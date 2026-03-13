/**
 * Pattern Expansion
 *
 * Functions for expanding variables within glob/extglob patterns.
 * Handles command substitution, variable expansion, and quoting within patterns.
 */

import type { ScriptNode } from "../../ast/types";
import { Parser } from "../../parser/parser";
import { ExecutionLimitError, ExitError } from "../errors";
import type { InterpreterContext } from "../types";
import { escapeGlobChars } from "./glob-escape";

/**
 * Check if a pattern string contains command substitution $(...)
 */
export function patternHasCommandSubstitution(pattern: string): boolean {
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    // Skip escaped characters
    if (c === "\\" && i + 1 < pattern.length) {
      i += 2;
      continue;
    }
    // Skip single-quoted strings
    if (c === "'") {
      const closeIdx = pattern.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        i = closeIdx + 1;
        continue;
      }
    }
    // Check for $( which indicates command substitution
    if (c === "$" && i + 1 < pattern.length && pattern[i + 1] === "(") {
      return true;
    }
    // Check for backtick command substitution
    if (c === "`") {
      return true;
    }
    i++;
  }
  return false;
}

/**
 * Find the matching closing parenthesis for a command substitution.
 * Handles nested parentheses, quotes, and escapes.
 * Returns the index of the closing ), or -1 if not found.
 */
function findCommandSubstitutionEnd(pattern: string, startIdx: number): number {
  let depth = 1;
  let i = startIdx;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (i < pattern.length && depth > 0) {
    const c = pattern[i];

    // Handle escapes (only outside single quotes)
    if (c === "\\" && !inSingleQuote && i + 1 < pattern.length) {
      i += 2;
      continue;
    }

    // Handle single quotes (only outside double quotes)
    if (c === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      i++;
      continue;
    }

    // Handle double quotes (only outside single quotes)
    if (c === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      i++;
      continue;
    }

    // Handle parentheses (only outside quotes)
    if (!inSingleQuote && !inDoubleQuote) {
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
        if (depth === 0) {
          return i;
        }
      }
    }

    i++;
  }

  return -1;
}

/**
 * Execute a command substitution from a raw command string.
 * Parses and executes the command, returning stdout with trailing newlines stripped.
 */
async function executeCommandSubstitutionFromString(
  ctx: InterpreterContext,
  commandStr: string
): Promise<string> {
  // Parse the command
  const parser = new Parser();
  let ast: ScriptNode;
  try {
    ast = parser.parse(commandStr);
  } catch {
    // Parse error - return empty string
    return "";
  }

  // Execute in subshell-like context
  const savedBashPid = ctx.state.bashPid;
  ctx.state.bashPid = ctx.state.nextVirtualPid++;
  const savedEnv = new Map(ctx.state.env);
  const savedCwd = ctx.state.cwd;
  const savedSuppressVerbose = ctx.state.suppressVerbose;
  ctx.state.suppressVerbose = true;

  try {
    const result = await ctx.executeScript(ast);
    // Restore environment but preserve exit code
    const exitCode = result.exitCode;
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.suppressVerbose = savedSuppressVerbose;
    ctx.state.lastExitCode = exitCode;
    ctx.state.env.set("?", String(exitCode));
    if (result.stderr) {
      ctx.state.expansionStderr =
        (ctx.state.expansionStderr || "") + result.stderr;
    }
    ctx.state.bashPid = savedBashPid;
    return result.stdout.replace(/\n+$/, "");
  } catch (error) {
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.bashPid = savedBashPid;
    ctx.state.suppressVerbose = savedSuppressVerbose;
    if (error instanceof ExecutionLimitError) {
      throw error;
    }
    if (error instanceof ExitError) {
      ctx.state.lastExitCode = error.exitCode;
      ctx.state.env.set("?", String(error.exitCode));
      return error.stdout?.replace(/\n+$/, "") ?? "";
    }
    return "";
  }
}

/**
 * Expand variables within a glob/extglob pattern string.
 * This handles patterns like @($var|$other) where variables need expansion.
 * Also handles quoted strings inside patterns (e.g., @(foo|'bar'|"$baz")).
 * Preserves pattern metacharacters while expanding $var and ${var} references.
 */
export function expandVariablesInPattern(
  ctx: InterpreterContext,
  pattern: string
): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    // Handle single-quoted strings - content is literal, strip quotes, escape glob chars
    if (c === "'") {
      const closeIdx = pattern.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 1, closeIdx);
        // Escape glob metacharacters so they match literally
        result += escapeGlobChars(content);
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle double-quoted strings - expand variables inside, strip quotes, escape glob chars
    if (c === '"') {
      // Find matching close quote, handling escapes
      let closeIdx = -1;
      let j = i + 1;
      while (j < pattern.length) {
        if (pattern[j] === "\\") {
          j += 2; // Skip escaped char
          continue;
        }
        if (pattern[j] === '"') {
          closeIdx = j;
          break;
        }
        j++;
      }
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 1, closeIdx);
        // Recursively expand variables in the double-quoted content
        // but without the quote handling (pass through all other chars)
        const expanded = expandVariablesInDoubleQuotedPattern(ctx, content);
        // Escape glob metacharacters so they match literally
        result += escapeGlobChars(expanded);
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle variable references: $var or ${var}
    if (c === "$") {
      if (i + 1 < pattern.length) {
        const next = pattern[i + 1];
        if (next === "{") {
          // ${var} form - find matching }
          const closeIdx = pattern.indexOf("}", i + 2);
          if (closeIdx !== -1) {
            const varName = pattern.slice(i + 2, closeIdx);
            // Simple variable expansion (no complex operations)
            result += ctx.state.env.get(varName) ?? "";
            i = closeIdx + 1;
            continue;
          }
        } else if (/[a-zA-Z_]/.test(next)) {
          // $var form - read variable name
          let end = i + 1;
          while (end < pattern.length && /[a-zA-Z0-9_]/.test(pattern[end])) {
            end++;
          }
          const varName = pattern.slice(i + 1, end);
          result += ctx.state.env.get(varName) ?? "";
          i = end;
          continue;
        }
      }
    }

    // Handle backslash escapes - preserve them
    if (c === "\\" && i + 1 < pattern.length) {
      result += c + pattern[i + 1];
      i += 2;
      continue;
    }

    // All other characters pass through unchanged
    result += c;
    i++;
  }

  return result;
}

/**
 * Expand variables within a double-quoted string inside a pattern.
 * Handles $var and ${var} but not nested quotes.
 */
function expandVariablesInDoubleQuotedPattern(
  ctx: InterpreterContext,
  content: string
): string {
  let result = "";
  let i = 0;

  while (i < content.length) {
    const c = content[i];

    // Handle backslash escapes
    if (c === "\\" && i + 1 < content.length) {
      const next = content[i + 1];
      // In double quotes, only $, `, \, ", and newline are special after \
      if (next === "$" || next === "`" || next === "\\" || next === '"') {
        result += next;
        i += 2;
        continue;
      }
      // Other escapes pass through as-is
      result += c;
      i++;
      continue;
    }

    // Handle variable references: $var or ${var}
    if (c === "$") {
      if (i + 1 < content.length) {
        const next = content[i + 1];
        if (next === "{") {
          // ${var} form - find matching }
          const closeIdx = content.indexOf("}", i + 2);
          if (closeIdx !== -1) {
            const varName = content.slice(i + 2, closeIdx);
            result += ctx.state.env.get(varName) ?? "";
            i = closeIdx + 1;
            continue;
          }
        } else if (/[a-zA-Z_]/.test(next)) {
          // $var form - read variable name
          let end = i + 1;
          while (end < content.length && /[a-zA-Z0-9_]/.test(content[end])) {
            end++;
          }
          const varName = content.slice(i + 1, end);
          result += ctx.state.env.get(varName) ?? "";
          i = end;
          continue;
        }
      }
    }

    // All other characters pass through unchanged
    result += c;
    i++;
  }

  return result;
}

/**
 * Async version of expandVariablesInPattern that handles command substitutions.
 * This handles patterns like @($var|$(echo foo)) where command substitutions need expansion.
 */
export async function expandVariablesInPatternAsync(
  ctx: InterpreterContext,
  pattern: string
): Promise<string> {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    // Handle single-quoted strings - content is literal, strip quotes, escape glob chars
    if (c === "'") {
      const closeIdx = pattern.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 1, closeIdx);
        // Escape glob metacharacters so they match literally
        result += escapeGlobChars(content);
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle double-quoted strings - expand variables inside, strip quotes, escape glob chars
    if (c === '"') {
      // Find matching close quote, handling escapes
      let closeIdx = -1;
      let j = i + 1;
      while (j < pattern.length) {
        if (pattern[j] === "\\") {
          j += 2; // Skip escaped char
          continue;
        }
        if (pattern[j] === '"') {
          closeIdx = j;
          break;
        }
        j++;
      }
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 1, closeIdx);
        // Recursively expand (including command substitutions) in the double-quoted content
        const expanded = await expandVariablesInDoubleQuotedPatternAsync(
          ctx,
          content
        );
        // Escape glob metacharacters so they match literally
        result += escapeGlobChars(expanded);
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle command substitution: $(...)
    if (c === "$" && i + 1 < pattern.length && pattern[i + 1] === "(") {
      const closeIdx = findCommandSubstitutionEnd(pattern, i + 2);
      if (closeIdx !== -1) {
        const commandStr = pattern.slice(i + 2, closeIdx);
        // Execute the command substitution
        const output = await executeCommandSubstitutionFromString(
          ctx,
          commandStr
        );
        result += output;
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle backtick command substitution: `...`
    if (c === "`") {
      const closeIdx = pattern.indexOf("`", i + 1);
      if (closeIdx !== -1) {
        const commandStr = pattern.slice(i + 1, closeIdx);
        // Execute the command substitution
        const output = await executeCommandSubstitutionFromString(
          ctx,
          commandStr
        );
        result += output;
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle variable references: $var or ${var}
    if (c === "$") {
      if (i + 1 < pattern.length) {
        const next = pattern[i + 1];
        if (next === "{") {
          // ${var} form - find matching }
          const closeIdx = pattern.indexOf("}", i + 2);
          if (closeIdx !== -1) {
            const varName = pattern.slice(i + 2, closeIdx);
            // Simple variable expansion (no complex operations)
            result += ctx.state.env.get(varName) ?? "";
            i = closeIdx + 1;
            continue;
          }
        } else if (/[a-zA-Z_]/.test(next)) {
          // $var form - read variable name
          let end = i + 1;
          while (end < pattern.length && /[a-zA-Z0-9_]/.test(pattern[end])) {
            end++;
          }
          const varName = pattern.slice(i + 1, end);
          result += ctx.state.env.get(varName) ?? "";
          i = end;
          continue;
        }
      }
    }

    // Handle backslash escapes - preserve them
    if (c === "\\" && i + 1 < pattern.length) {
      result += c + pattern[i + 1];
      i += 2;
      continue;
    }

    // All other characters pass through unchanged
    result += c;
    i++;
  }

  return result;
}

/**
 * Async version of expandVariablesInDoubleQuotedPattern that handles command substitutions.
 */
async function expandVariablesInDoubleQuotedPatternAsync(
  ctx: InterpreterContext,
  content: string
): Promise<string> {
  let result = "";
  let i = 0;

  while (i < content.length) {
    const c = content[i];

    // Handle backslash escapes
    if (c === "\\" && i + 1 < content.length) {
      const next = content[i + 1];
      // In double quotes, only $, `, \, ", and newline are special after \
      if (next === "$" || next === "`" || next === "\\" || next === '"') {
        result += next;
        i += 2;
        continue;
      }
      // Other escapes pass through as-is
      result += c;
      i++;
      continue;
    }

    // Handle command substitution: $(...)
    if (c === "$" && i + 1 < content.length && content[i + 1] === "(") {
      const closeIdx = findCommandSubstitutionEnd(content, i + 2);
      if (closeIdx !== -1) {
        const commandStr = content.slice(i + 2, closeIdx);
        const output = await executeCommandSubstitutionFromString(
          ctx,
          commandStr
        );
        result += output;
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle backtick command substitution: `...`
    if (c === "`") {
      const closeIdx = content.indexOf("`", i + 1);
      if (closeIdx !== -1) {
        const commandStr = content.slice(i + 1, closeIdx);
        const output = await executeCommandSubstitutionFromString(
          ctx,
          commandStr
        );
        result += output;
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle variable references: $var or ${var}
    if (c === "$") {
      if (i + 1 < content.length) {
        const next = content[i + 1];
        if (next === "{") {
          // ${var} form - find matching }
          const closeIdx = content.indexOf("}", i + 2);
          if (closeIdx !== -1) {
            const varName = content.slice(i + 2, closeIdx);
            result += ctx.state.env.get(varName) ?? "";
            i = closeIdx + 1;
            continue;
          }
        } else if (/[a-zA-Z_]/.test(next)) {
          // $var form - read variable name
          let end = i + 1;
          while (end < content.length && /[a-zA-Z0-9_]/.test(content[end])) {
            end++;
          }
          const varName = content.slice(i + 1, end);
          result += ctx.state.env.get(varName) ?? "";
          i = end;
          continue;
        }
      }
    }

    // All other characters pass through unchanged
    result += c;
    i++;
  }

  return result;
}
