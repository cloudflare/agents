/**
 * Conditional Expression Evaluation
 *
 * Handles:
 * - [[ ... ]] conditional commands
 * - [ ... ] and test commands
 * - File tests (-f, -d, -e, etc.)
 * - String tests (-z, -n, =, !=)
 * - Numeric comparisons (-eq, -ne, -lt, etc.)
 * - Pattern matching (==, =~)
 */

import type { ConditionalExpressionNode } from "../ast/types";
import { parseArithmeticExpression } from "../parser/arithmetic-parser";
import { Parser } from "../parser/parser";
import { createUserRegex } from "../regex/index";
import type { ExecResult } from "../types";
import { evaluateArithmetic } from "./arithmetic";
import {
  escapeRegexChars,
  expandWord,
  expandWordForPattern,
  expandWordForRegex
} from "./expansion";
import { clearArray } from "./helpers/array";
import {
  evaluateBinaryFileTest,
  evaluateFileTest,
  isBinaryFileTestOperator,
  isFileTestOperator
} from "./helpers/file-tests";
import { compareNumeric, isNumericOp } from "./helpers/numeric-compare";
import { result as execResult, failure, testResult } from "./helpers/result";
import { compareStrings, isStringCompareOp } from "./helpers/string-compare";
import { evaluateStringTest, isStringTestOp } from "./helpers/string-tests";
import { evaluateVariableTest } from "./helpers/variable-tests";
import type { InterpreterContext } from "./types";

export async function evaluateConditional(
  ctx: InterpreterContext,
  expr: ConditionalExpressionNode
): Promise<boolean> {
  switch (expr.type) {
    case "CondBinary": {
      const left = await expandWord(ctx, expr.left);

      // Check if RHS is fully quoted (should be treated literally, not as pattern)
      // For regex (=~), Escaped parts are NOT considered "quoted" because they need
      // backslash preservation for the regex engine. For == and !=, Escaped parts
      // should be treated as literal characters (quoted).
      const isRhsQuoted =
        expr.right.parts.length > 0 &&
        expr.right.parts.every(
          (p) =>
            p.type === "SingleQuoted" ||
            p.type === "DoubleQuoted" ||
            // Escaped counts as quoted for pattern matching, but NOT for regex
            (p.type === "Escaped" && expr.operator !== "=~")
        );

      // For pattern comparisons (== and !=), use expandWordForPattern to preserve
      // backslash escapes for pattern metacharacters like \( and \)
      // This ensures *\(\) matches "foo()" by treating \( and \) as literal
      // For regex (=~), use expandWordForRegex to preserve all backslash escapes
      // so \[\] works as a regex to match literal []
      // When regex pattern is quoted, escape regex metacharacters for literal matching
      let right: string;
      if (expr.operator === "=~") {
        if (isRhsQuoted) {
          // Quoted regex patterns should have metacharacters escaped for literal matching
          // e.g., [[ 'a b' =~ '^(a b)$' ]] should NOT match because ^ ( ) $ are literals
          const expanded = await expandWord(ctx, expr.right);
          right = escapeRegexChars(expanded);
        } else {
          right = await expandWordForRegex(ctx, expr.right);
        }
      } else if (isStringCompareOp(expr.operator) && !isRhsQuoted) {
        right = await expandWordForPattern(ctx, expr.right);
      } else {
        right = await expandWord(ctx, expr.right);
      }

      // String comparisons (with pattern matching support in [[ ]])
      if (isStringCompareOp(expr.operator)) {
        const nocasematch = ctx.state.shoptOptions.nocasematch;
        // In [[ ]], extglob patterns are always recognized regardless of shopt setting
        // The extglob shopt only affects filename globbing and variable assignment syntax
        return compareStrings(
          expr.operator,
          left,
          right,
          !isRhsQuoted,
          nocasematch,
          true // Always enable extglob in [[ ]] pattern matching
        );
      }

      // Numeric comparisons
      if (isNumericOp(expr.operator)) {
        return compareNumeric(
          expr.operator,
          await evalArithExpr(ctx, left),
          await evalArithExpr(ctx, right)
        );
      }

      // Binary file tests
      if (isBinaryFileTestOperator(expr.operator)) {
        return evaluateBinaryFileTest(ctx, expr.operator, left, right);
      }

      switch (expr.operator) {
        case "=~": {
          try {
            const nocasematch = ctx.state.shoptOptions.nocasematch;
            // Convert POSIX ERE syntax to JavaScript regex syntax
            const jsPattern = posixEreToJsRegex(right);
            const regex = createUserRegex(jsPattern, nocasematch ? "i" : "");
            const match = regex.match(left);
            // Always clear BASH_REMATCH first (bash clears it on failed match)
            clearArray(ctx, "BASH_REMATCH");
            if (match) {
              // Store full match at index 0, capture groups at indices 1, 2, ...
              for (let i = 0; i < match.length; i++) {
                ctx.state.env.set(`BASH_REMATCH_${i}`, match[i] || "");
              }
            }
            return match !== null;
          } catch {
            // Invalid regex pattern is a syntax error (exit code 2)
            throw new Error("syntax error in regular expression");
          }
        }
        case "<":
          return left < right;
        case ">":
          return left > right;
        default:
          return false;
      }
    }

    case "CondUnary": {
      const operand = await expandWord(ctx, expr.operand);

      // Handle file test operators using shared helper
      if (isFileTestOperator(expr.operator)) {
        return evaluateFileTest(ctx, expr.operator, operand);
      }

      if (isStringTestOp(expr.operator)) {
        return evaluateStringTest(expr.operator, operand);
      }
      if (expr.operator === "-v") {
        return await evaluateVariableTest(ctx, operand);
      }
      if (expr.operator === "-o") {
        return evaluateShellOption(ctx, operand);
      }
      return false;
    }

    case "CondNot": {
      // When extglob is enabled and we have !( group ), it should be treated
      // as an extglob pattern instead of negation. In bash, with extglob on,
      // [[ !($str) ]] parses differently - the !() is a pattern, not negation.
      // Since we parse before knowing extglob state, we handle this at evaluation.
      //
      // Check if operand is CondGroup containing CondWord - if extglob is on,
      // treat the whole thing as a pattern word (which is always non-empty).
      if (ctx.state.shoptOptions.extglob) {
        if (
          expr.operand.type === "CondGroup" &&
          expr.operand.expression.type === "CondWord"
        ) {
          // With extglob, !($str) is an extglob pattern, not negation.
          // Expand the word inside the group, construct the extglob pattern,
          // and test if the pattern string is non-empty (which it always is).
          const innerValue = await expandWord(
            ctx,
            expr.operand.expression.word
          );
          // The extglob pattern "!(value)" is always a non-empty string
          const extglobPattern = `!(${innerValue})`;
          return extglobPattern !== "";
        }
      }
      return !(await evaluateConditional(ctx, expr.operand));
    }

    case "CondAnd": {
      const left = await evaluateConditional(ctx, expr.left);
      if (!left) return false;
      return await evaluateConditional(ctx, expr.right);
    }

    case "CondOr": {
      const left = await evaluateConditional(ctx, expr.left);
      if (left) return true;
      return await evaluateConditional(ctx, expr.right);
    }

    case "CondGroup":
      return await evaluateConditional(ctx, expr.expression);

    case "CondWord": {
      const value = await expandWord(ctx, expr.word);
      return value !== "";
    }

    default:
      return false;
  }
}

export async function evaluateTestArgs(
  ctx: InterpreterContext,
  args: string[]
): Promise<ExecResult> {
  if (args.length === 0) {
    return execResult("", "", 1);
  }

  if (args.length === 1) {
    return testResult(Boolean(args[0]));
  }

  if (args.length === 2) {
    const op = args[0];
    const operand = args[1];

    // "(" without matching ")" is a syntax error
    if (op === "(") {
      return failure("test: '(' without matching ')'\n", 2);
    }

    // Handle file test operators using shared helper
    if (isFileTestOperator(op)) {
      return testResult(await evaluateFileTest(ctx, op, operand));
    }

    if (isStringTestOp(op)) {
      return testResult(evaluateStringTest(op, operand));
    }
    if (op === "!") {
      return testResult(!operand);
    }
    if (op === "-v") {
      return testResult(await evaluateVariableTest(ctx, operand));
    }
    if (op === "-o") {
      return testResult(evaluateShellOption(ctx, operand));
    }
    // If the first arg is a known binary operator but used in 2-arg context, it's an error
    if (
      op === "=" ||
      op === "==" ||
      op === "!=" ||
      op === "<" ||
      op === ">" ||
      op === "-eq" ||
      op === "-ne" ||
      op === "-lt" ||
      op === "-le" ||
      op === "-gt" ||
      op === "-ge" ||
      op === "-nt" ||
      op === "-ot" ||
      op === "-ef"
    ) {
      return failure(`test: ${op}: unary operator expected\n`, 2);
    }
    return execResult("", "", 1);
  }

  if (args.length === 3) {
    const left = args[0];
    const op = args[1];
    const right = args[2];

    // POSIX 3-argument rules:
    // If $2 is a binary primary, evaluate as: $1 op $3
    // Binary primaries include: =, !=, -eq, -ne, -lt, -le, -gt, -ge, -a, -o, -nt, -ot, -ef
    // Note: -a and -o as binary primaries test if both/either operand is non-empty

    // String comparisons (no pattern matching in test/[)
    if (isStringCompareOp(op)) {
      return testResult(compareStrings(op, left, right));
    }

    if (isNumericOp(op)) {
      const leftNum = parseNumericDecimal(left);
      const rightNum = parseNumericDecimal(right);
      // Invalid operand returns exit code 2
      if (!leftNum.valid || !rightNum.valid) {
        return execResult("", "", 2);
      }
      return testResult(compareNumeric(op, leftNum.value, rightNum.value));
    }

    // Binary file tests
    if (isBinaryFileTestOperator(op)) {
      return testResult(await evaluateBinaryFileTest(ctx, op, left, right));
    }

    switch (op) {
      case "-a":
        // In 3-arg context, -a is binary AND: both operands must be non-empty
        return testResult(left !== "" && right !== "");
      case "-o":
        // In 3-arg context, -o is binary OR: at least one operand must be non-empty
        return testResult(left !== "" || right !== "");
      case ">":
        // String comparison: left > right (lexicographically)
        return testResult(left > right);
      case "<":
        // String comparison: left < right (lexicographically)
        return testResult(left < right);
    }

    // If $1 is '!', negate the 2-argument test
    if (left === "!") {
      const negResult = await evaluateTestArgs(ctx, [op, right]);
      return execResult(
        "",
        negResult.stderr,
        negResult.exitCode === 0
          ? 1
          : negResult.exitCode === 1
            ? 0
            : negResult.exitCode
      );
    }

    // If $1 is '(' and $3 is ')', evaluate $2 as single-arg test
    if (left === "(" && right === ")") {
      return testResult(op !== "");
    }
  }

  // POSIX 4-argument rules
  if (args.length === 4) {
    // If $1 is '!', negate the 3-argument expression
    if (args[0] === "!") {
      const negResult = await evaluateTestArgs(ctx, args.slice(1));
      return execResult(
        "",
        negResult.stderr,
        negResult.exitCode === 0
          ? 1
          : negResult.exitCode === 1
            ? 0
            : negResult.exitCode
      );
    }

    // If $1 is '(' and $4 is ')', evaluate $2 and $3 as 2-arg expression
    if (args[0] === "(" && args[3] === ")") {
      return evaluateTestArgs(ctx, [args[1], args[2]]);
    }
  }

  // Handle compound expressions with -a (AND) and -o (OR)
  const exprResult = await evaluateTestExpr(ctx, args, 0);

  // Check for unconsumed tokens (extra arguments = syntax error)
  if (exprResult.pos < args.length) {
    return failure("test: too many arguments\n", 2);
  }

  return testResult(exprResult.value);
}

// Recursive expression evaluator for test command
async function evaluateTestExpr(
  ctx: InterpreterContext,
  args: string[],
  pos: number
): Promise<{ value: boolean; pos: number }> {
  return evaluateTestOr(ctx, args, pos);
}

async function evaluateTestOr(
  ctx: InterpreterContext,
  args: string[],
  pos: number
): Promise<{ value: boolean; pos: number }> {
  let { value, pos: newPos } = await evaluateTestAnd(ctx, args, pos);
  while (args[newPos] === "-o") {
    const right = await evaluateTestAnd(ctx, args, newPos + 1);
    value = value || right.value;
    newPos = right.pos;
  }
  return { value, pos: newPos };
}

async function evaluateTestAnd(
  ctx: InterpreterContext,
  args: string[],
  pos: number
): Promise<{ value: boolean; pos: number }> {
  let { value, pos: newPos } = await evaluateTestNot(ctx, args, pos);
  while (args[newPos] === "-a") {
    const right = await evaluateTestNot(ctx, args, newPos + 1);
    value = value && right.value;
    newPos = right.pos;
  }
  return { value, pos: newPos };
}

async function evaluateTestNot(
  ctx: InterpreterContext,
  args: string[],
  pos: number
): Promise<{ value: boolean; pos: number }> {
  if (args[pos] === "!") {
    const { value, pos: newPos } = await evaluateTestNot(ctx, args, pos + 1);
    return { value: !value, pos: newPos };
  }
  return evaluateTestPrimary(ctx, args, pos);
}

async function evaluateTestPrimary(
  ctx: InterpreterContext,
  args: string[],
  pos: number
): Promise<{ value: boolean; pos: number }> {
  const token = args[pos];

  // Parentheses grouping
  if (token === "(") {
    const { value, pos: newPos } = await evaluateTestExpr(ctx, args, pos + 1);
    // Skip closing )
    return { value, pos: args[newPos] === ")" ? newPos + 1 : newPos };
  }

  // IMPORTANT: Check for binary operators FIRST, before unary operators.
  // This handles the ambiguous case where a flag-like string (e.g., "-o", "-z", "-f")
  // is used as the left operand of a binary comparison.
  // For example: test -o != foo  -> should compare "-o" with "foo", not test shell option "!="
  // Similarly:   test 1 -eq 1 -a -o != foo  -> after -a, "-o" followed by "!=" is a comparison
  const next = args[pos + 1];

  // Check for binary string operators
  // Note: [ / test uses literal string comparison, NOT pattern matching
  if (isStringCompareOp(next)) {
    const left = token;
    const right = args[pos + 2] ?? "";
    return { value: compareStrings(next, left, right), pos: pos + 3 };
  }

  // Check for binary numeric operators
  if (isNumericOp(next)) {
    const leftParsed = parseNumericDecimal(token);
    const rightParsed = parseNumericDecimal(args[pos + 2] ?? "0");
    // Invalid operands - return false (will cause exit code 2 at higher level)
    if (!leftParsed.valid || !rightParsed.valid) {
      // For now, return false which is at least consistent with "comparison failed"
      return { value: false, pos: pos + 3 };
    }
    const value = compareNumeric(next, leftParsed.value, rightParsed.value);
    return { value, pos: pos + 3 };
  }

  // Binary file tests
  if (isBinaryFileTestOperator(next)) {
    const left = token;
    const right = args[pos + 2] ?? "";
    const value = await evaluateBinaryFileTest(ctx, next, left, right);
    return { value, pos: pos + 3 };
  }

  // Now check for unary operators (only if next token is NOT a binary operator)

  // Unary file tests - use shared helper
  if (isFileTestOperator(token)) {
    const operand = args[pos + 1] ?? "";
    const value = await evaluateFileTest(ctx, token, operand);
    return { value, pos: pos + 2 };
  }

  // Unary string tests - use shared helper
  if (isStringTestOp(token)) {
    const operand = args[pos + 1] ?? "";
    return { value: evaluateStringTest(token, operand), pos: pos + 2 };
  }

  // Variable tests
  if (token === "-v") {
    const varName = args[pos + 1] ?? "";
    const value = await evaluateVariableTest(ctx, varName);
    return { value, pos: pos + 2 };
  }

  // Shell option tests
  if (token === "-o") {
    const optName = args[pos + 1] ?? "";
    const value = evaluateShellOption(ctx, optName);
    return { value, pos: pos + 2 };
  }

  // Single argument: true if non-empty
  return { value: token !== undefined && token !== "", pos: pos + 1 };
}

export function matchPattern(
  value: string,
  pattern: string,
  nocasematch = false,
  extglob = false
): boolean {
  const regex = `^${patternToRegexStr(pattern, extglob)}$`;
  // Use 's' flag (dotAll) so that * matches newlines in the value
  // This matches bash behavior where patterns like *foo* match multiline values
  const flags = nocasematch ? "is" : "s";
  return createUserRegex(regex, flags).test(value);
}

/**
 * Convert a glob pattern to a regex string (without anchors).
 * Supports extglob patterns: @(...), *(...), +(...), ?(...), !(...)
 */
function patternToRegexStr(pattern: string, extglob: boolean): string {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    // Check for extglob patterns: @(...), *(...), +(...), ?(...), !(...)
    if (
      extglob &&
      (char === "@" ||
        char === "*" ||
        char === "+" ||
        char === "?" ||
        char === "!") &&
      i + 1 < pattern.length &&
      pattern[i + 1] === "("
    ) {
      // Find the matching closing paren (handle nesting)
      const closeIdx = findMatchingParen(pattern, i + 1);
      if (closeIdx !== -1) {
        const content = pattern.slice(i + 2, closeIdx);
        // Split on | but handle nested extglob patterns
        const alternatives = splitExtglobAlternatives(content);
        // Convert each alternative recursively
        const altRegexes = alternatives.map((alt) =>
          patternToRegexStr(alt, extglob)
        );
        const altGroup = altRegexes.length > 0 ? altRegexes.join("|") : "(?:)";

        if (char === "@") {
          // @(...) - match exactly one of the patterns
          regex += `(?:${altGroup})`;
        } else if (char === "*") {
          // *(...) - match zero or more occurrences
          regex += `(?:${altGroup})*`;
        } else if (char === "+") {
          // +(...) - match one or more occurrences
          regex += `(?:${altGroup})+`;
        } else if (char === "?") {
          // ?(...) - match zero or one occurrence
          regex += `(?:${altGroup})?`;
        } else if (char === "!") {
          // !(...) - match anything except the patterns
          // When !(pattern) is followed by more pattern content, we need special handling
          const hasMorePattern = closeIdx < pattern.length - 1;
          if (hasMorePattern) {
            // Try to compute fixed lengths for the alternatives
            const lengths = alternatives.map((alt) =>
              computePatternLength(alt, extglob)
            );
            const allSameLength =
              lengths.every((l) => l !== null) &&
              lengths.every((l) => l === lengths[0]);

            if (allSameLength && lengths[0] !== null) {
              const n = lengths[0];
              if (n === 0) {
                // !(empty) followed by more - matches any non-empty string
                regex += "(?:.+)";
              } else {
                // Match: <n chars OR >n chars OR exactly n chars that aren't the pattern
                const parts: string[] = [];
                if (n > 0) {
                  parts.push(`.{0,${n - 1}}`);
                }
                parts.push(`.{${n + 1},}`);
                parts.push(`(?!(?:${altGroup})).{${n}}`);
                regex += `(?:${parts.join("|")})`;
              }
            } else {
              // Complex case: different lengths or variable-length patterns
              regex += `(?:(?!(?:${altGroup})).)*?`;
            }
          } else {
            // At end of pattern - use simple negative lookahead
            regex += `(?!(?:${altGroup})$).*`;
          }
        }
        i = closeIdx;
        continue;
      }
    }

    // Handle backslash escapes - next char is literal
    if (char === "\\") {
      if (i + 1 < pattern.length) {
        const next = pattern[i + 1];
        // Escape regex special chars
        if (/[\\^$.|+(){}[\]*?]/.test(next)) {
          regex += `\\${next}`;
        } else {
          regex += next;
        }
        i++; // Skip the escaped character
      } else {
        regex += "\\\\"; // Trailing backslash
      }
    } else if (char === "*") {
      regex += ".*";
    } else if (char === "?") {
      regex += ".";
    } else if (char === "[") {
      const closeIdx = pattern.indexOf("]", i + 1);
      if (closeIdx !== -1) {
        regex += pattern.slice(i, closeIdx + 1);
        i = closeIdx;
      } else {
        regex += "\\[";
      }
    } else if (/[\\^$.|+(){}]/.test(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  return regex;
}

/**
 * Find the matching closing parenthesis, handling nesting
 */
function findMatchingParen(pattern: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < pattern.length && depth > 0) {
    const c = pattern[i];
    if (c === "\\") {
      i += 2; // Skip escaped char
      continue;
    }
    if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Split extglob pattern content on | handling nested patterns
 */
function splitExtglobAlternatives(content: string): string[] {
  const alternatives: string[] = [];
  let current = "";
  let depth = 0;
  let i = 0;

  while (i < content.length) {
    const c = content[i];
    if (c === "\\") {
      // Escaped character
      current += c;
      if (i + 1 < content.length) {
        current += content[i + 1];
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (c === "(") {
      depth++;
      current += c;
    } else if (c === ")") {
      depth--;
      current += c;
    } else if (c === "|" && depth === 0) {
      alternatives.push(current);
      current = "";
    } else {
      current += c;
    }
    i++;
  }
  alternatives.push(current);
  return alternatives;
}

/**
 * Compute the fixed length of a pattern, if it has one.
 * Returns null if the pattern has variable length (contains *, +, etc.).
 * Used to optimize !() extglob patterns.
 */
function computePatternLength(
  pattern: string,
  extglob: boolean
): number | null {
  let length = 0;
  let i = 0;

  while (i < pattern.length) {
    const c = pattern[i];

    // Check for extglob patterns
    if (
      extglob &&
      (c === "@" || c === "*" || c === "+" || c === "?" || c === "!") &&
      i + 1 < pattern.length &&
      pattern[i + 1] === "("
    ) {
      const closeIdx = findMatchingParen(pattern, i + 1);
      if (closeIdx !== -1) {
        if (c === "@") {
          // @() matches exactly one occurrence - get length of alternatives
          const content = pattern.slice(i + 2, closeIdx);
          const alts = splitExtglobAlternatives(content);
          const altLengths = alts.map((a) => computePatternLength(a, extglob));
          // All alternatives must have same length for fixed length
          if (
            altLengths.every((l) => l !== null) &&
            altLengths.every((l) => l === altLengths[0])
          ) {
            length += altLengths[0] as number;
            i = closeIdx + 1;
            continue;
          }
          return null; // Variable length
        }
        // *, +, ?, ! all have variable length
        return null;
      }
    }

    if (c === "*") {
      return null; // Variable length
    }
    if (c === "?") {
      length += 1;
      i++;
      continue;
    }
    if (c === "[") {
      // Character class matches exactly 1 char
      const closeIdx = pattern.indexOf("]", i + 1);
      if (closeIdx !== -1) {
        length += 1;
        i = closeIdx + 1;
        continue;
      }
      // No closing bracket - treat as literal
      length += 1;
      i++;
      continue;
    }
    if (c === "\\") {
      // Escaped char
      length += 1;
      i += 2;
      continue;
    }
    // Regular character
    length += 1;
    i++;
  }

  return length;
}

/**
 * Evaluate -o option test (check if shell option is enabled).
 * Maps option names to interpreter state flags.
 */
function evaluateShellOption(ctx: InterpreterContext, option: string): boolean {
  // Map of option names to their state in ctx.state.options
  // Only includes options that are actually implemented
  const optionMap = new Map<string, () => boolean>([
    // Implemented options (set -o)
    ["errexit", () => ctx.state.options.errexit === true],
    ["nounset", () => ctx.state.options.nounset === true],
    ["pipefail", () => ctx.state.options.pipefail === true],
    ["xtrace", () => ctx.state.options.xtrace === true],
    // Single-letter aliases for implemented options
    ["e", () => ctx.state.options.errexit === true],
    ["u", () => ctx.state.options.nounset === true],
    ["x", () => ctx.state.options.xtrace === true]
  ]);

  const getter = optionMap.get(option);
  if (getter) {
    return getter();
  }
  // Unknown or unimplemented option - return false
  return false;
}

/**
 * Evaluate an arithmetic expression string for [[ ]] comparisons.
 * In bash, [[ -eq ]] etc. evaluate operands as arithmetic expressions.
 */
async function evalArithExpr(
  ctx: InterpreterContext,
  expr: string
): Promise<number> {
  expr = expr.trim();
  if (expr === "") return 0;

  // First try simple numeric parsing (handles octal, hex, base-N)
  // If the expression is just a number, parseNumeric handles it correctly
  if (/^[+-]?(\d+#[a-zA-Z0-9@_]+|0[xX][0-9a-fA-F]+|0[0-7]+|\d+)$/.test(expr)) {
    return parseNumeric(expr);
  }

  // Otherwise, parse and evaluate as arithmetic expression
  try {
    const parser = new Parser();
    const arithAst = parseArithmeticExpression(parser, expr);
    return await evaluateArithmetic(ctx, arithAst.expression);
  } catch {
    // If parsing fails, try simple numeric
    return parseNumeric(expr);
  }
}

/**
 * Parse a number in base N (2-64).
 * Digit values: 0-9=0-9, a-z=10-35, A-Z=36-61, @=62, _=63
 */
function parseBaseN(digits: string, base: number): number {
  let result = 0;
  for (const char of digits) {
    let digitValue: number;
    if (char >= "0" && char <= "9") {
      digitValue = char.charCodeAt(0) - 48; // '0' = 48
    } else if (char >= "a" && char <= "z") {
      digitValue = char.charCodeAt(0) - 97 + 10; // 'a' = 97
    } else if (char >= "A" && char <= "Z") {
      digitValue = char.charCodeAt(0) - 65 + 36; // 'A' = 65
    } else if (char === "@") {
      digitValue = 62;
    } else if (char === "_") {
      digitValue = 63;
    } else {
      return Number.NaN;
    }
    if (digitValue >= base) {
      return Number.NaN;
    }
    result = result * base + digitValue;
  }
  return result;
}

/**
 * Parse a bash numeric value, supporting:
 * - Decimal: 42, -42
 * - Octal: 0777, -0123
 * - Hex: 0xff, 0xFF, -0xff
 * - Base-N: 64#a, 2#1010
 * - Strings are coerced to 0
 */
function parseNumeric(value: string): number {
  value = value.trim();
  if (value === "") return 0;

  // Handle negative numbers
  let negative = false;
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }

  let result: number;

  // Base-N syntax: base#value
  const baseMatch = value.match(/^(\d+)#([a-zA-Z0-9@_]+)$/);
  if (baseMatch) {
    const base = Number.parseInt(baseMatch[1], 10);
    if (base >= 2 && base <= 64) {
      result = parseBaseN(baseMatch[2], base);
    } else {
      result = 0;
    }
  }
  // Hex: 0x or 0X
  else if (/^0[xX][0-9a-fA-F]+$/.test(value)) {
    result = Number.parseInt(value, 16);
  }
  // Octal: starts with 0 followed by digits (0-7)
  else if (/^0[0-7]+$/.test(value)) {
    result = Number.parseInt(value, 8);
  }
  // Decimal
  else {
    result = Number.parseInt(value, 10);
  }

  // NaN becomes 0 (bash coerces invalid strings to 0)
  if (Number.isNaN(result)) {
    result = 0;
  }

  return negative ? -result : result;
}

/**
 * Parse a number as plain decimal (for test/[ command).
 * Unlike parseNumeric, this does NOT interpret octal/hex/base-N.
 * Leading zeros are treated as decimal.
 * Returns { value, valid } - valid is false if input is invalid.
 */
function parseNumericDecimal(value: string): { value: number; valid: boolean } {
  value = value.trim();
  if (value === "") return { value: 0, valid: true };

  // Handle negative numbers
  let negative = false;
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }

  // Check if it's a valid decimal number (only digits)
  if (!/^\d+$/.test(value)) {
    // Invalid format (hex, base-N, letters, etc.)
    return { value: 0, valid: false };
  }

  // Always parse as decimal (base 10)
  const result = Number.parseInt(value, 10);

  // NaN is invalid
  if (Number.isNaN(result)) {
    return { value: 0, valid: false };
  }

  return { value: negative ? -result : result, valid: true };
}

/**
 * Convert a POSIX Extended Regular Expression to JavaScript RegExp syntax.
 *
 * Key differences handled:
 * 1. `[]...]` - In POSIX, `]` is literal when first in class. In JS, need `\]`
 * 2. `[^]...]` - Same with negated class
 * 3. `[[:class:]]` - POSIX character classes need conversion
 *
 * @param pattern - POSIX ERE pattern string
 * @returns JavaScript-compatible regex pattern string
 */
function posixEreToJsRegex(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    // Handle backslash escapes - skip the escaped character
    if (pattern[i] === "\\" && i + 1 < pattern.length) {
      result += pattern[i] + pattern[i + 1];
      i += 2;
    } else if (pattern[i] === "[") {
      // Found start of character class
      const classResult = convertPosixCharClass(pattern, i);
      result += classResult.converted;
      i = classResult.endIndex;
    } else {
      result += pattern[i];
      i++;
    }
  }

  return result;
}

/**
 * Convert a POSIX character class starting at `startIndex` (where pattern[startIndex] === '[')
 * to JavaScript regex character class syntax.
 *
 * Returns the converted class and the index after the closing `]`.
 */
function convertPosixCharClass(
  pattern: string,
  startIndex: number
): { converted: string; endIndex: number } {
  let i = startIndex + 1;
  let result = "[";

  // Handle negation: [^ or [!
  if (i < pattern.length && (pattern[i] === "^" || pattern[i] === "!")) {
    result += "^";
    i++;
  }

  // In POSIX, ] is literal when it's the first char (after optional ^)
  // We need to collect it and add it later in a JS-compatible position
  let hasLiteralCloseBracket = false;
  if (i < pattern.length && pattern[i] === "]") {
    hasLiteralCloseBracket = true;
    i++;
  }

  // In POSIX, [ can also be literal when first (after optional ^ and ])
  let hasLiteralOpenBracket = false;
  if (
    i < pattern.length &&
    pattern[i] === "[" &&
    i + 1 < pattern.length &&
    pattern[i + 1] !== ":"
  ) {
    hasLiteralOpenBracket = true;
    i++;
  }

  // Collect the rest of the character class content
  let classContent = "";
  let foundClose = false;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "]") {
      // End of character class
      foundClose = true;
      i++;
      break;
    }

    // Handle POSIX character classes like [:alpha:]
    if (ch === "[" && i + 1 < pattern.length && pattern[i + 1] === ":") {
      const endPos = pattern.indexOf(":]", i + 2);
      if (endPos !== -1) {
        const className = pattern.slice(i + 2, endPos);
        classContent += posixClassToJsClass(className);
        i = endPos + 2;
        continue;
      }
    }

    // Handle collating elements [.ch.] and equivalence classes [=ch=]
    // These are rarely used but we should skip them properly
    if (ch === "[" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === "." || next === "=") {
        const endMarker = `${next}]`;
        const endPos = pattern.indexOf(endMarker, i + 2);
        if (endPos !== -1) {
          // For now, just include the content as literal
          const content = pattern.slice(i + 2, endPos);
          classContent += content;
          i = endPos + 2;
          continue;
        }
      }
    }

    // Handle escape sequences
    if (ch === "\\" && i + 1 < pattern.length) {
      classContent += ch + pattern[i + 1];
      i += 2;
      continue;
    }

    classContent += ch;
    i++;
  }

  if (!foundClose) {
    // No closing bracket found - return as literal [
    return { converted: "\\[", endIndex: startIndex + 1 };
  }

  // Build the JS-compatible character class
  // In JS regex, we need to escape ] and [ or put them in specific positions
  // The safest approach is to escape them with backslash

  // If we had literal ] at the start, escape it
  if (hasLiteralCloseBracket) {
    result += "\\]";
  }

  // If we had literal [ at the start, escape it
  if (hasLiteralOpenBracket) {
    result += "\\[";
  }

  // Add the rest of the content
  result += classContent;

  result += "]";
  return { converted: result, endIndex: i };
}

/**
 * Convert POSIX character class name to JS regex equivalent.
 */
function posixClassToJsClass(className: string): string {
  const mapping = new Map<string, string>([
    ["alnum", "a-zA-Z0-9"],
    ["alpha", "a-zA-Z"],
    ["ascii", "\\x00-\\x7F"],
    ["blank", " \\t"],
    ["cntrl", "\\x00-\\x1F\\x7F"],
    ["digit", "0-9"],
    ["graph", "!-~"],
    ["lower", "a-z"],
    ["print", " -~"],
    ["punct", "!-/:-@\\[-`{-~"],
    ["space", " \\t\\n\\r\\f\\v"],
    ["upper", "A-Z"],
    ["word", "a-zA-Z0-9_"],
    ["xdigit", "0-9A-Fa-f"]
  ]);

  return mapping.get(className) ?? "";
}
