/**
 * Word Expansion
 *
 * Handles shell word expansion including:
 * - Variable expansion ($VAR, ${VAR})
 * - Command substitution $(...)
 * - Arithmetic expansion $((...))
 * - Tilde expansion (~)
 * - Brace expansion {a,b,c}
 * - Glob expansion (*, ?, [...])
 */

import type { ParameterExpansionPart, WordNode, WordPart } from "../ast/types";
import { parseArithmeticExpression } from "../parser/arithmetic-parser";
import { Parser } from "../parser/parser";
import { GlobExpander } from "../shell/glob";
import { evaluateArithmetic } from "./arithmetic";
import { BadSubstitutionError, ExecutionLimitError, ExitError } from "./errors";

/**
 * Check if a string exceeds the maximum allowed length.
 * Throws ExecutionLimitError if the limit is exceeded.
 */
function checkStringLength(
  str: string,
  maxLength: number,
  context: string
): void {
  if (str.length > maxLength) {
    throw new ExecutionLimitError(
      `${context}: string length limit exceeded (${maxLength} bytes)`,
      "string_length"
    );
  }
}

import { analyzeWordParts } from "./expansion/analysis";
import {
  expandDollarVarsInArithText,
  expandSubscriptForAssocArray
} from "./expansion/arith-text-expansion";
import { expandBraceRange } from "./expansion/brace-range";
import { getFileReadShorthand } from "./expansion/command-substitution";
// Import from extracted modules
import {
  escapeGlobChars,
  escapeRegexChars,
  hasGlobPattern
} from "./expansion/glob-escape";
import {
  computeIsEmpty,
  handleArrayKeys,
  handleAssignDefault,
  handleCaseModification,
  handleDefaultValue,
  handleErrorIfUnset,
  handleIndirection,
  handleLength,
  handlePatternRemoval,
  handlePatternReplacement,
  handleSubstring,
  handleTransform,
  handleUseAlternative,
  handleVarNamePrefix
} from "./expansion/parameter-ops";
import {
  expandVariablesInPattern,
  expandVariablesInPatternAsync,
  patternHasCommandSubstitution
} from "./expansion/pattern-expansion";
import { applyTildeExpansion } from "./expansion/tilde";
import { getVariable, isVariableSet } from "./expansion/variable";
import {
  expandWordWithGlobImpl,
  type WordGlobExpansionDeps
} from "./expansion/word-glob-expansion";
import { smartWordSplit } from "./expansion/word-split";
import {
  buildIfsCharClassPattern,
  getIfs,
  isIfsEmpty,
  splitByIfsForExpansion
} from "./helpers/ifs";
import { isNameref, resolveNameref } from "./helpers/nameref";
import { getLiteralValue, isQuotedPart } from "./helpers/word-parts";
import type { InterpreterContext } from "./types";

// Re-export extracted functions for use elsewhere
export { escapeGlobChars, escapeRegexChars } from "./expansion/glob-escape";
// Re-export for backward compatibility
export { getArrayElements, getVariable, isArray } from "./expansion/variable";

// Helper to fully expand word parts (including variables, arithmetic, etc.)
async function expandWordPartsAsync(
  ctx: InterpreterContext,
  parts: WordPart[],
  inDoubleQuotes = false
): Promise<string> {
  const results: string[] = [];
  for (const part of parts) {
    results.push(await expandPart(ctx, part, inDoubleQuotes));
  }
  return results.join("");
}

/**
 * Check if a word is "fully quoted" - meaning glob characters should be treated literally.
 * A word is fully quoted if all its parts are either:
 * - SingleQuoted
 * - DoubleQuoted (entirely quoted variable expansion like "$pat")
 * - Escaped characters
 */
function isPartFullyQuoted(part: WordPart): boolean {
  return isQuotedPart(part);
}

/**
 * Check if an entire word is fully quoted
 */
export function isWordFullyQuoted(word: WordNode): boolean {
  // Empty word is considered quoted (matches empty pattern literally)
  if (word.parts.length === 0) return true;

  // Check if we have any unquoted parts with actual content
  for (const part of word.parts) {
    if (!isPartFullyQuoted(part)) {
      return false;
    }
  }
  return true;
}

/**
 * Handle simple part types that don't require recursion or async.
 * Returns the expanded string, or null if the part type needs special handling.
 * inDoubleQuotes flag suppresses tilde expansion (tilde is literal inside "...")
 */
function expandSimplePart(
  ctx: InterpreterContext,
  part: WordPart,
  inDoubleQuotes = false
): string | null {
  // Handle literal parts (Literal, SingleQuoted, Escaped)
  const literal = getLiteralValue(part);
  if (literal !== null) return literal;

  switch (part.type) {
    case "TildeExpansion":
      // Tilde expansion doesn't happen inside double quotes
      if (inDoubleQuotes) {
        return part.user === null ? "~" : `~${part.user}`;
      }
      if (part.user === null) {
        // Use HOME if set (even if empty), otherwise fall back to /home/user
        return ctx.state.env.get("HOME") ?? "/home/user";
      }
      // ~username only expands if user exists
      // In sandboxed environment, we can only verify 'root' exists universally
      // Other unknown users stay literal (matches bash behavior)
      if (part.user === "root") {
        return "/root";
      }
      return `~${part.user}`;
    case "Glob":
      // Expand variables within extglob patterns (e.g., @($var|$other))
      return expandVariablesInPattern(ctx, part.pattern);
    default:
      return null; // Needs special handling (DoubleQuoted, BraceExpansion, ArithmeticExpansion, CommandSubstitution)
  }
}

export async function expandWord(
  ctx: InterpreterContext,
  word: WordNode
): Promise<string> {
  return expandWordAsync(ctx, word);
}

/**
 * Expand a word for use as a regex pattern (in [[ =~ ]]).
 * Preserves backslash escapes so they're passed to the regex engine.
 * For example, \[\] becomes \[\] in the regex (matching literal [ and ]).
 */
export async function expandWordForRegex(
  ctx: InterpreterContext,
  word: WordNode
): Promise<string> {
  const parts: string[] = [];
  for (const part of word.parts) {
    if (part.type === "Escaped") {
      // For regex patterns, preserve ALL backslash escapes
      // This allows \[ \] \. \* etc. to work as regex escapes
      parts.push(`\\${part.value}`);
    } else if (part.type === "SingleQuoted") {
      // Single-quoted content is literal in regex
      parts.push(part.value);
    } else if (part.type === "DoubleQuoted") {
      // Double-quoted: expand contents
      const expanded = await expandWordPartsAsync(ctx, part.parts);
      parts.push(expanded);
    } else if (part.type === "TildeExpansion") {
      // Tilde expansion on RHS of =~ is treated as literal (regex chars escaped)
      // This matches bash 4.x+ behavior where ~ expands but the result is
      // matched literally, not as a regex pattern.
      // e.g., HOME='^a$'; [[ $HOME =~ ~ ]] matches because ~ expands to '^a$'
      // and then '^a$' is escaped to '\^a\$' which matches the literal string
      const expanded = await expandPart(ctx, part);
      parts.push(escapeRegexChars(expanded));
    } else {
      // Other parts: expand normally
      parts.push(await expandPart(ctx, part));
    }
  }
  return parts.join("");
}

/**
 * Expand a word for use as a pattern (e.g., in [[ == ]] or case).
 * Preserves backslash escapes for pattern metacharacters so they're treated literally.
 * This prevents `*\(\)` from being interpreted as an extglob pattern.
 */
export async function expandWordForPattern(
  ctx: InterpreterContext,
  word: WordNode
): Promise<string> {
  const parts: string[] = [];
  for (const part of word.parts) {
    if (part.type === "Escaped") {
      // For escaped characters that are pattern metacharacters, preserve the backslash
      // This includes: ( ) | * ? [ ] for glob/extglob patterns
      const ch = part.value;
      if ("()|*?[]".includes(ch)) {
        parts.push(`\\${ch}`);
      } else {
        parts.push(ch);
      }
    } else if (part.type === "SingleQuoted") {
      // Single-quoted content should be escaped for literal matching
      parts.push(escapeGlobChars(part.value));
    } else if (part.type === "DoubleQuoted") {
      // Double-quoted: expand contents and escape for literal matching
      const expanded = await expandWordPartsAsync(ctx, part.parts);
      parts.push(escapeGlobChars(expanded));
    } else {
      // Other parts: expand normally
      parts.push(await expandPart(ctx, part));
    }
  }
  return parts.join("");
}

/**
 * Expand a word for glob matching.
 * Unlike regular expansion, this escapes glob metacharacters in quoted parts
 * so they are treated as literals, while preserving glob patterns from Glob parts.
 * This enables patterns like '_tmp/[bc]'*.mm where [bc] is literal and * is a glob.
 */
async function expandWordForGlobbing(
  ctx: InterpreterContext,
  word: WordNode
): Promise<string> {
  const parts: string[] = [];
  for (const part of word.parts) {
    if (part.type === "SingleQuoted") {
      // Single-quoted content: escape glob metacharacters for literal matching
      parts.push(escapeGlobChars(part.value));
    } else if (part.type === "Escaped") {
      // Escaped character: escape if it's a glob metacharacter
      const ch = part.value;
      if ("*?[]\\()|".includes(ch)) {
        parts.push(`\\${ch}`);
      } else {
        parts.push(ch);
      }
    } else if (part.type === "DoubleQuoted") {
      // Double-quoted: expand contents and escape glob metacharacters
      const expanded = await expandWordPartsAsync(ctx, part.parts);
      parts.push(escapeGlobChars(expanded));
    } else if (part.type === "Glob") {
      // Glob pattern: expand variables and command substitutions within extglob patterns
      // e.g., @($var|$(echo foo)) needs both variable and command substitution expansion
      if (patternHasCommandSubstitution(part.pattern)) {
        // Use async version for command substitutions
        parts.push(await expandVariablesInPatternAsync(ctx, part.pattern));
      } else {
        // Use sync version for simple variable expansion
        parts.push(expandVariablesInPattern(ctx, part.pattern));
      }
    } else if (part.type === "Literal") {
      // Literal: keep as-is (may contain glob characters that should glob)
      parts.push(part.value);
    } else {
      // Other parts (ParameterExpansion, etc.): expand normally
      parts.push(await expandPart(ctx, part));
    }
  }
  return parts.join("");
}

/**
 * Check if word parts contain brace expansion
 */
function hasBraceExpansion(parts: WordPart[]): boolean {
  for (const part of parts) {
    if (part.type === "BraceExpansion") return true;
    if (part.type === "DoubleQuoted" && hasBraceExpansion(part.parts))
      return true;
  }
  return false;
}

// Maximum total operations across all recursive calls (internal safety cap)
const MAX_BRACE_OPERATIONS = 100000;

type BraceExpandedPart = string | WordPart;

/**
 * Expand brace expansion in word parts, producing multiple arrays of parts.
 * Each result array represents the parts that will be joined to form one word.
 * For example, "pre{a,b}post" produces [["pre", "a", "post"], ["pre", "b", "post"]]
 *
 * Non-brace parts are kept as WordPart objects to allow deferred expansion.
 * This is necessary for bash-like behavior where side effects in expansions
 * (like $((i++))) are evaluated separately for each brace alternative.
 */
async function expandBracesInPartsAsync(
  ctx: InterpreterContext,
  parts: WordPart[],
  operationCounter: { count: number } = { count: 0 }
): Promise<BraceExpandedPart[][]> {
  if (operationCounter.count > MAX_BRACE_OPERATIONS) {
    return [[]];
  }

  let results: BraceExpandedPart[][] = [[]];

  for (const part of parts) {
    if (part.type === "BraceExpansion") {
      const braceValues: string[] = [];
      let hasInvalidRange = false;
      let invalidRangeLiteral = "";
      for (const item of part.items) {
        if (item.type === "Range") {
          const range = expandBraceRange(
            item.start,
            item.end,
            item.step,
            item.startStr,
            item.endStr
          );
          if (range.expanded) {
            for (const val of range.expanded) {
              operationCounter.count++;
              braceValues.push(val);
            }
          } else {
            hasInvalidRange = true;
            invalidRangeLiteral = range.literal;
            break;
          }
        } else {
          // Word item - expand it (recursively handle nested braces)
          const expanded = await expandBracesInPartsAsync(
            ctx,
            item.word.parts,
            operationCounter
          );
          for (const exp of expanded) {
            operationCounter.count++;
            // Join all parts, expanding any deferred WordParts
            const joinedParts: string[] = [];
            for (const p of exp) {
              if (typeof p === "string") {
                joinedParts.push(p);
              } else {
                joinedParts.push(await expandPart(ctx, p));
              }
            }
            braceValues.push(joinedParts.join(""));
          }
        }
      }

      if (hasInvalidRange) {
        for (const result of results) {
          operationCounter.count++;
          result.push(invalidRangeLiteral);
        }
        continue;
      }

      const newSize = results.length * braceValues.length;
      if (
        newSize > ctx.limits.maxBraceExpansionResults ||
        operationCounter.count > MAX_BRACE_OPERATIONS
      ) {
        return results;
      }

      const newResults: BraceExpandedPart[][] = [];
      for (const result of results) {
        for (const val of braceValues) {
          operationCounter.count++;
          if (operationCounter.count > MAX_BRACE_OPERATIONS) {
            return newResults.length > 0 ? newResults : results;
          }
          newResults.push([...result, val]);
        }
      }
      results = newResults;
    } else {
      // Non-brace part: keep as WordPart for deferred expansion
      for (const result of results) {
        operationCounter.count++;
        result.push(part);
      }
    }
  }

  return results;
}

/**
 * Async version of expandWordWithBraces
 */
async function expandWordWithBracesAsync(
  ctx: InterpreterContext,
  word: WordNode
): Promise<string[]> {
  const parts = word.parts;

  if (!hasBraceExpansion(parts)) {
    return [await expandWord(ctx, word)];
  }

  const expanded = await expandBracesInPartsAsync(ctx, parts);

  // Now expand each result, evaluating deferred parts separately for each
  // This ensures side effects like $((i++)) are evaluated fresh for each brace alternative
  const results: string[] = [];
  for (const resultParts of expanded) {
    const joinedParts: string[] = [];
    for (const p of resultParts) {
      if (typeof p === "string") {
        joinedParts.push(p);
      } else {
        // Expand the deferred WordPart now (async)
        joinedParts.push(await expandPart(ctx, p));
      }
    }
    // Apply tilde expansion to each result - this handles cases like ~{/src,root}
    // where brace expansion produces ~/src and ~root, which then need tilde expansion
    results.push(applyTildeExpansion(ctx, joinedParts.join("")));
  }
  return results;
}

// Create dependencies object for word-glob-expansion module
function createWordGlobDeps(): WordGlobExpansionDeps {
  return {
    expandWordAsync,
    expandWordForGlobbing,
    expandWordWithBracesAsync,
    expandWordPartsAsync,
    expandPart,
    expandParameterAsync,
    hasBraceExpansion,
    evaluateArithmetic,
    buildIfsCharClassPattern,
    smartWordSplit
  };
}

export async function expandWordWithGlob(
  ctx: InterpreterContext,
  word: WordNode
): Promise<{ values: string[]; quoted: boolean }> {
  return expandWordWithGlobImpl(ctx, word, createWordGlobDeps());
}

/**
 * Get textual representation of a word for error messages
 */
function getWordText(parts: WordPart[]): string {
  for (const p of parts) {
    if (p.type === "ParameterExpansion") {
      return p.parameter;
    }
    if (p.type === "Literal") {
      return p.value;
    }
  }
  return "";
}

export function hasQuotedMultiValueAt(
  ctx: InterpreterContext,
  word: WordNode
): boolean {
  const numParams = Number.parseInt(ctx.state.env.get("#") || "0", 10);
  // Only a problem if there are 2+ positional parameters
  if (numParams < 2) return false;

  // Check for "$@" inside DoubleQuoted parts
  function checkParts(parts: WordPart[]): boolean {
    for (const part of parts) {
      if (part.type === "DoubleQuoted") {
        // Check inside the double-quoted part
        for (const innerPart of part.parts) {
          if (
            innerPart.type === "ParameterExpansion" &&
            innerPart.parameter === "@" &&
            !innerPart.operation // plain $@ without operations
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  return checkParts(word.parts);
}

/**
 * Expand a redirect target with glob handling.
 *
 * For redirects:
 * - If glob matches 0 files with failglob → error (returns { error: ... })
 * - If glob matches 0 files without failglob → use literal pattern
 * - If glob matches 1 file → use that file
 * - If glob matches 2+ files → "ambiguous redirect" error
 *
 * Returns { target: string } on success or { error: string } on failure.
 */
export async function expandRedirectTarget(
  ctx: InterpreterContext,
  word: WordNode
): Promise<{ target: string } | { error: string }> {
  // Check for "$@" with multiple positional params - this is an ambiguous redirect
  if (hasQuotedMultiValueAt(ctx, word)) {
    return { error: "bash: $@: ambiguous redirect\n" };
  }

  const wordParts = word.parts;
  const { hasQuoted } = analyzeWordParts(wordParts);

  // Check for brace expansion - if it produces multiple values, it's an ambiguous redirect
  // For example: echo hi > a-{one,two} should error
  if (hasBraceExpansion(wordParts)) {
    const braceExpanded = await expandWordWithBracesAsync(ctx, word);
    if (braceExpanded.length > 1) {
      // Get the original word text for the error message
      const originalText = wordParts
        .map((p) => {
          if (p.type === "Literal") return p.value;
          if (p.type === "BraceExpansion") {
            // Reconstruct brace expression
            const items = p.items
              .map((item) => {
                if (item.type === "Range") {
                  const step = item.step ? `..${item.step}` : "";
                  return `${item.startStr ?? item.start}..${item.endStr ?? item.end}${step}`;
                }
                return item.word.parts
                  .map((wp) => (wp.type === "Literal" ? wp.value : ""))
                  .join("");
              })
              .join(",");
            return `{${items}}`;
          }
          return "";
        })
        .join("");
      return { error: `bash: ${originalText}: ambiguous redirect\n` };
    }
    // Single value from brace expansion - continue with normal processing
    // (value will be re-expanded below, but since there's only one value it's the same)
  }

  const value = await expandWordAsync(ctx, word);

  // Check for word splitting producing multiple words - this is an ambiguous redirect
  // This only applies when the word has unquoted expansions (not all quoted)
  const { hasParamExpansion, hasCommandSub } = analyzeWordParts(wordParts);
  const hasUnquotedExpansion =
    (hasParamExpansion || hasCommandSub) && !hasQuoted;

  if (hasUnquotedExpansion && !isIfsEmpty(ctx.state.env)) {
    const ifsChars = getIfs(ctx.state.env);
    const splitWords = splitByIfsForExpansion(value, ifsChars);
    if (splitWords.length > 1) {
      // Word splitting produces multiple words - ambiguous redirect
      return {
        error: `bash: $${getWordText(wordParts)}: ambiguous redirect\n`
      };
    }
  }

  // Skip glob expansion if noglob is set (set -f) or if the word was quoted
  // Check these BEFORE building glob pattern to avoid double-expanding side-effectful expressions
  if (hasQuoted || ctx.state.options.noglob) {
    return { target: value };
  }

  // Build glob pattern using expandWordForGlobbing which preserves escaped glob chars
  // For example: two-\* becomes two-\\* (escaped * is literal, not a glob)
  // But: two-$star where star='*' becomes two-* (variable expansion is subject to glob)
  const globPattern = await expandWordForGlobbing(ctx, word);

  // Skip if there are no glob patterns in the pattern
  if (!hasGlobPattern(globPattern, ctx.state.shoptOptions.extglob)) {
    return { target: value };
  }

  // Perform glob expansion for redirect targets
  const globExpander = new GlobExpander(ctx.fs, ctx.state.cwd, ctx.state.env, {
    globstar: ctx.state.shoptOptions.globstar,
    nullglob: ctx.state.shoptOptions.nullglob,
    failglob: ctx.state.shoptOptions.failglob,
    dotglob: ctx.state.shoptOptions.dotglob,
    extglob: ctx.state.shoptOptions.extglob,
    globskipdots: ctx.state.shoptOptions.globskipdots,
    maxGlobOperations: ctx.limits.maxGlobOperations
  });

  const matches = await globExpander.expand(globPattern);

  if (matches.length === 0) {
    // No matches
    if (globExpander.hasFailglob()) {
      // failglob: error on no match
      return { error: `bash: no match: ${value}\n` };
    }
    // Without failglob, use the literal pattern (unescaped)
    return { target: value };
  }

  if (matches.length === 1) {
    // Exactly one match - use it
    return { target: matches[0] };
  }

  // Multiple matches - ambiguous redirect error
  return { error: `bash: ${value}: ambiguous redirect\n` };
}

// Async version of expandWord (internal)
async function expandWordAsync(
  ctx: InterpreterContext,
  word: WordNode
): Promise<string> {
  const wordParts = word.parts;
  const len = wordParts.length;

  if (len === 1) {
    const result = await expandPart(ctx, wordParts[0]);
    checkStringLength(result, ctx.limits.maxStringLength, "word expansion");
    return result;
  }

  const parts: string[] = [];
  for (let i = 0; i < len; i++) {
    parts.push(await expandPart(ctx, wordParts[i]));
  }
  const result = parts.join("");
  checkStringLength(result, ctx.limits.maxStringLength, "word expansion");
  return result;
}

async function expandPart(
  ctx: InterpreterContext,
  part: WordPart,
  inDoubleQuotes = false
): Promise<string> {
  // Always use async expansion for ParameterExpansion
  if (part.type === "ParameterExpansion") {
    return expandParameterAsync(ctx, part, inDoubleQuotes);
  }

  // Try simple cases first (Literal, SingleQuoted, Escaped, TildeExpansion, Glob)
  const simple = expandSimplePart(ctx, part, inDoubleQuotes);
  if (simple !== null) return simple;

  // Handle cases that need recursion or async
  switch (part.type) {
    case "DoubleQuoted": {
      const parts: string[] = [];
      for (const p of part.parts) {
        // Inside double quotes, suppress tilde expansion
        parts.push(await expandPart(ctx, p, true));
      }
      return parts.join("");
    }

    case "CommandSubstitution": {
      // Check for the special $(<file) shorthand pattern
      // This is equivalent to $(cat file) but reads the file directly
      const fileReadShorthand = getFileReadShorthand(part.body);
      if (fileReadShorthand) {
        try {
          // Expand the file path (handles $VAR, etc.)
          const filePath = await expandWord(ctx, fileReadShorthand.target);
          // Resolve relative paths
          const resolvedPath = filePath.startsWith("/")
            ? filePath
            : `${ctx.state.cwd}/${filePath}`;
          // Read the file
          const content = await ctx.fs.readFile(resolvedPath);
          ctx.state.lastExitCode = 0;
          ctx.state.env.set("?", "0");
          // Strip trailing newlines (like command substitution does)
          const result = content.replace(/\n+$/, "");
          // Check string length limit
          checkStringLength(
            result,
            ctx.limits.maxStringLength,
            "command substitution"
          );
          return result;
        } catch (error) {
          // ExecutionLimitError must propagate
          if (error instanceof ExecutionLimitError) {
            throw error;
          }
          // File not found or read error - return empty string, set exit code
          ctx.state.lastExitCode = 1;
          ctx.state.env.set("?", "1");
          return "";
        }
      }

      // Command substitution runs in a subshell-like context
      // ExitError should NOT terminate the main script, just this substitution
      // But ExecutionLimitError MUST propagate to protect against infinite recursion
      // Check command substitution nesting depth limit
      const currentDepth = ctx.substitutionDepth ?? 0;
      const maxDepth = ctx.limits.maxSubstitutionDepth;
      if (currentDepth >= maxDepth) {
        throw new ExecutionLimitError(
          `Command substitution nesting limit exceeded (${maxDepth})`,
          "substitution_depth"
        );
      }
      // Increment depth for nested substitutions
      const savedDepth = ctx.substitutionDepth;
      ctx.substitutionDepth = currentDepth + 1;

      // Command substitutions get a new BASHPID (unlike $$ which stays the same)
      const savedBashPid = ctx.state.bashPid;
      ctx.state.bashPid = ctx.state.nextVirtualPid++;
      // Save environment - command substitutions run in a subshell and should not
      // modify parent environment (e.g., aliases defined inside $() should not leak)
      const savedEnv = new Map(ctx.state.env);
      const savedCwd = ctx.state.cwd;
      // Suppress verbose mode (set -v) inside command substitutions
      // bash only prints verbose output for the main script
      const savedSuppressVerbose = ctx.state.suppressVerbose;
      ctx.state.suppressVerbose = true;
      try {
        const result = await ctx.executeScript(part.body);
        // Restore environment but preserve exit code
        const exitCode = result.exitCode;
        ctx.state.env = savedEnv;
        ctx.state.cwd = savedCwd;
        ctx.state.suppressVerbose = savedSuppressVerbose;
        // Store the exit code for $?
        ctx.state.lastExitCode = exitCode;
        ctx.state.env.set("?", String(exitCode));
        // Command substitution stderr should go to the shell's stderr at expansion time,
        // NOT be affected by later redirections on the outer command
        if (result.stderr) {
          ctx.state.expansionStderr =
            (ctx.state.expansionStderr || "") + result.stderr;
        }
        ctx.state.bashPid = savedBashPid;
        ctx.substitutionDepth = savedDepth;
        const output = result.stdout.replace(/\n+$/, "");
        // Check string length limit for command substitution output
        checkStringLength(
          output,
          ctx.limits.maxStringLength,
          "command substitution"
        );
        return output;
      } catch (error) {
        // Restore environment on error as well
        ctx.state.env = savedEnv;
        ctx.state.cwd = savedCwd;
        ctx.state.bashPid = savedBashPid;
        ctx.substitutionDepth = savedDepth;
        ctx.state.suppressVerbose = savedSuppressVerbose;
        // ExecutionLimitError must always propagate - these are safety limits
        if (error instanceof ExecutionLimitError) {
          throw error;
        }
        if (error instanceof ExitError) {
          // Catch exit in command substitution - return output so far
          ctx.state.lastExitCode = error.exitCode;
          ctx.state.env.set("?", String(error.exitCode));
          // Also forward stderr from the exit
          if (error.stderr) {
            ctx.state.expansionStderr =
              (ctx.state.expansionStderr || "") + error.stderr;
          }
          const exitOutput = error.stdout.replace(/\n+$/, "");
          // Check string length limit for command substitution output
          checkStringLength(
            exitOutput,
            ctx.limits.maxStringLength,
            "command substitution"
          );
          return exitOutput;
        }
        throw error;
      }
    }

    case "ArithmeticExpansion": {
      // If original text is available and contains $var patterns (not ${...}),
      // we need to do text substitution before parsing to maintain operator precedence.
      // E.g., $(( $x * 3 )) where x='1 + 2' should expand to $(( 1 + 2 * 3 )) = 7
      // not $(( (1+2) * 3 )) = 9
      const originalText = part.expression.originalText;
      const hasDollarVars =
        originalText && /\$[a-zA-Z_][a-zA-Z0-9_]*(?![{[(])/.test(originalText);
      if (hasDollarVars) {
        // Expand $var patterns in the text
        const expandedText = await expandDollarVarsInArithText(
          ctx,
          originalText
        );
        // Re-parse the expanded expression
        const parser = new Parser();
        const newExpr = parseArithmeticExpression(parser, expandedText);
        // true = expansion context, single quotes cause error
        return String(await evaluateArithmetic(ctx, newExpr.expression, true));
      }
      // true = expansion context, single quotes cause error
      return String(
        await evaluateArithmetic(ctx, part.expression.expression, true)
      );
    }

    case "BraceExpansion": {
      const results: string[] = [];
      for (const item of part.items) {
        if (item.type === "Range") {
          const range = expandBraceRange(
            item.start,
            item.end,
            item.step,
            item.startStr,
            item.endStr
          );
          if (range.expanded) {
            results.push(...range.expanded);
          } else {
            return range.literal;
          }
        } else {
          results.push(await expandWord(ctx, item.word));
        }
      }
      return results.join(" ");
    }

    default:
      return "";
  }
}

// Async version of expandParameter for parameter expansions that contain command substitution
async function expandParameterAsync(
  ctx: InterpreterContext,
  part: ParameterExpansionPart,
  inDoubleQuotes = false
): Promise<string> {
  let { parameter } = part;
  const { operation } = part;

  // Handle subscript expansion for array access: ${a[...]}
  // We need to expand the subscript before calling getVariable
  const bracketMatch = parameter.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/);
  if (bracketMatch) {
    const [, arrayName, subscript] = bracketMatch;
    const isAssoc = ctx.state.associativeArrays?.has(arrayName);

    // For associative arrays, expand the subscript to handle ${array[@]} and other expansions
    // Also expand if subscript contains command substitution or variables
    if (
      isAssoc ||
      subscript.includes("$(") ||
      subscript.includes("`") ||
      subscript.includes("${")
    ) {
      const expandedSubscript = await expandSubscriptForAssocArray(
        ctx,
        subscript
      );
      parameter = `${arrayName}[${expandedSubscript}]`;
    }
  } else if (
    // Handle nameref pointing to array subscript with command substitution:
    // typeset -n ref='a[$(echo 2) + 1]'; echo $ref
    /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(parameter) &&
    isNameref(ctx, parameter)
  ) {
    const target = resolveNameref(ctx, parameter);
    if (target && target !== parameter) {
      // Check if the resolved target is an array subscript with command substitution
      const targetBracketMatch = target.match(
        /^([a-zA-Z_][a-zA-Z0-9_]*)\[(.+)\]$/
      );
      if (targetBracketMatch) {
        const [, targetArrayName, targetSubscript] = targetBracketMatch;
        const isAssoc = ctx.state.associativeArrays?.has(targetArrayName);
        if (
          isAssoc ||
          targetSubscript.includes("$(") ||
          targetSubscript.includes("`") ||
          targetSubscript.includes("${")
        ) {
          const expandedSubscript = await expandSubscriptForAssocArray(
            ctx,
            targetSubscript
          );
          // Replace the nameref's stored target with the expanded one for this expansion
          // We need to call getVariable with the expanded target directly
          parameter = `${targetArrayName}[${expandedSubscript}]`;
        }
      }
    }
  }

  // Operations that handle unset variables should not trigger nounset
  const skipNounset =
    operation &&
    (operation.type === "DefaultValue" ||
      operation.type === "AssignDefault" ||
      operation.type === "UseAlternative" ||
      operation.type === "ErrorIfUnset");

  const value = await getVariable(ctx, parameter, !skipNounset);

  if (!operation) {
    return value;
  }

  const isUnset = !(await isVariableSet(ctx, parameter));
  // Compute isEmpty and effectiveValue using extracted helper
  const { isEmpty, effectiveValue } = computeIsEmpty(
    ctx,
    parameter,
    value,
    inDoubleQuotes
  );
  const opCtx = {
    value,
    isUnset,
    isEmpty,
    effectiveValue,
    inDoubleQuotes
  };

  switch (operation.type) {
    case "DefaultValue":
      return handleDefaultValue(ctx, operation, opCtx, expandWordPartsAsync);

    case "AssignDefault":
      return handleAssignDefault(
        ctx,
        parameter,
        operation,
        opCtx,
        expandWordPartsAsync
      );

    case "ErrorIfUnset":
      return handleErrorIfUnset(
        ctx,
        parameter,
        operation,
        opCtx,
        expandWordPartsAsync
      );

    case "UseAlternative":
      return handleUseAlternative(ctx, operation, opCtx, expandWordPartsAsync);

    case "PatternRemoval": {
      const result = await handlePatternRemoval(
        ctx,
        value,
        operation,
        expandWordPartsAsync,
        expandPart
      );
      checkStringLength(result, ctx.limits.maxStringLength, "pattern removal");
      return result;
    }

    case "PatternReplacement": {
      const result = await handlePatternReplacement(
        ctx,
        value,
        operation,
        expandWordPartsAsync,
        expandPart
      );
      checkStringLength(
        result,
        ctx.limits.maxStringLength,
        "pattern replacement"
      );
      return result;
    }

    case "Length":
      return handleLength(ctx, parameter, value);

    case "LengthSliceError":
      throw new BadSubstitutionError(parameter);

    case "BadSubstitution":
      throw new BadSubstitutionError(operation.text);

    case "Substring":
      return handleSubstring(ctx, parameter, value, operation);

    case "CaseModification": {
      const result = await handleCaseModification(
        ctx,
        value,
        operation,
        expandWordPartsAsync,
        expandParameterAsync
      );
      checkStringLength(
        result,
        ctx.limits.maxStringLength,
        "case modification"
      );
      return result;
    }

    case "Transform":
      return handleTransform(ctx, parameter, value, isUnset, operation);

    case "Indirection":
      return handleIndirection(
        ctx,
        parameter,
        value,
        isUnset,
        operation,
        expandParameterAsync,
        inDoubleQuotes
      );

    case "ArrayKeys":
      return handleArrayKeys(ctx, operation);

    case "VarNamePrefix":
      return handleVarNamePrefix(ctx, operation);

    default:
      return value;
  }
}
