/**
 * Arithmetic Expression Parser
 *
 * Parses bash arithmetic expressions like:
 * - $((1 + 2))
 * - $((x++))
 * - $((a ? b : c))
 * - $((2#1010))
 *
 * All functions take a Parser instance as the first argument for shared state access.
 */

import type {
  ArithAssignmentOperator,
  ArithExpr,
  ArithmeticExpressionNode
} from "../ast/types";
import { ArithmeticError } from "../interpreter/errors";
import {
  ARITH_ASSIGN_OPS,
  parseAnsiCQuoting,
  parseArithNumber,
  parseLocalizationQuoting,
  parseNestedArithmetic,
  skipArithWhitespace
} from "./arithmetic-primaries";
import type { Parser } from "./parser";

// Re-export for external use
export { parseArithNumber };

/**
 * Preprocess arithmetic expression to handle double-quoted strings.
 * In bash, double quotes inside arithmetic are removed and their content is
 * text-inserted into the expression. E.g., $(( "1 + 2" * 3 )) becomes $(( 1 + 2 * 3 ))
 *
 * Single quotes are left intact to trigger errors at parse/eval time.
 */
function preprocessArithInput(input: string): string {
  let result = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      // Skip opening quote
      i++;
      // Copy content until closing quote
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          // Handle escape sequences - keep the escaped character
          result += input[i + 1];
          i += 2;
        } else {
          result += input[i];
          i++;
        }
      }
      // Skip closing quote
      if (i < input.length) i++;
    } else {
      result += input[i];
      i++;
    }
  }
  return result;
}

/**
 * Parse an arithmetic expression string into an AST node
 */
export function parseArithmeticExpression(
  _p: Parser,
  input: string
): ArithmeticExpressionNode {
  // Preprocess to handle double-quoted strings (bash text-substitution behavior)
  const preprocessed = preprocessArithInput(input);
  const { expr: expression, pos } = parseArithExpr(_p, preprocessed, 0);
  // Validate that all input was consumed (skip trailing whitespace first)
  // IMPORTANT: Check against preprocessed string, not original input
  const finalPos = skipArithWhitespace(preprocessed, pos);
  if (finalPos < preprocessed.length) {
    // There's remaining content that wasn't parsed - create an error node
    // that will be evaluated at runtime to produce the error
    const remaining = input.slice(finalPos).trim();
    if (remaining) {
      return {
        type: "ArithmeticExpression",
        originalText: input,
        expression: {
          type: "ArithSyntaxError",
          errorToken: remaining,
          message: `${remaining}: syntax error: invalid arithmetic operator (error token is "${remaining}")`
        }
      };
    }
  }
  return { type: "ArithmeticExpression", expression, originalText: input };
}

/**
 * Helper to create a "missing operand" syntax error node.
 * Used when a binary operator is followed by end of input.
 */
function makeMissingOperandError(
  op: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  return {
    expr: {
      type: "ArithSyntaxError",
      errorToken: op,
      message: `syntax error: operand expected (error token is "${op}")`
    },
    pos
  };
}

/**
 * Check if we're at end of input (after skipping whitespace).
 * Used to detect missing operand after binary operators.
 */
function isMissingOperand(input: string, pos: number): boolean {
  return skipArithWhitespace(input, pos) >= input.length;
}

export function parseArithExpr(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  // Comma operator has the lowest precedence
  return parseArithComma(p, input, pos);
}

function parseArithComma(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithTernary(p, input, pos);

  currentPos = skipArithWhitespace(input, currentPos);
  while (input[currentPos] === ",") {
    const op = ",";
    currentPos++; // Skip comma
    if (isMissingOperand(input, currentPos)) {
      return makeMissingOperandError(op, currentPos);
    }
    const { expr: right, pos: p2 } = parseArithTernary(p, input, currentPos);
    left = { type: "ArithBinary", operator: ",", left, right };
    currentPos = skipArithWhitespace(input, p2);
  }

  return { expr: left, pos: currentPos };
}

function parseArithTernary(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: condition, pos: currentPos } = parseArithLogicalOr(p, input, pos);

  currentPos = skipArithWhitespace(input, currentPos);
  if (input[currentPos] === "?") {
    currentPos++;
    const { expr: consequent, pos: p2 } = parseArithExpr(p, input, currentPos);
    currentPos = skipArithWhitespace(input, p2);
    if (input[currentPos] === ":") {
      currentPos++;
      const { expr: alternate, pos: p3 } = parseArithExpr(p, input, currentPos);
      return {
        expr: { type: "ArithTernary", condition, consequent, alternate },
        pos: p3
      };
    }
  }

  return { expr: condition, pos: currentPos };
}

function parseArithLogicalOr(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithLogicalAnd(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input.slice(currentPos, currentPos + 2) === "||") {
      const op = "||";
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithLogicalAnd(
        p,
        input,
        currentPos
      );
      left = { type: "ArithBinary", operator: "||", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithLogicalAnd(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithBitwiseOr(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input.slice(currentPos, currentPos + 2) === "&&") {
      const op = "&&";
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithBitwiseOr(
        p,
        input,
        currentPos
      );
      left = { type: "ArithBinary", operator: "&&", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithBitwiseOr(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithBitwiseXor(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input[currentPos] === "|" && input[currentPos + 1] !== "|") {
      const op = "|";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithBitwiseXor(
        p,
        input,
        currentPos
      );
      left = { type: "ArithBinary", operator: "|", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithBitwiseXor(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithBitwiseAnd(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input[currentPos] === "^") {
      const op = "^";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithBitwiseAnd(
        p,
        input,
        currentPos
      );
      left = { type: "ArithBinary", operator: "^", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithBitwiseAnd(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithEquality(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input[currentPos] === "&" && input[currentPos + 1] !== "&") {
      const op = "&";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithEquality(p, input, currentPos);
      left = { type: "ArithBinary", operator: "&", left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithEquality(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithRelational(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (
      input.slice(currentPos, currentPos + 2) === "==" ||
      input.slice(currentPos, currentPos + 2) === "!="
    ) {
      const op = input.slice(currentPos, currentPos + 2) as "==" | "!=";
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithRelational(
        p,
        input,
        currentPos
      );
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithRelational(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithShift(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (
      input.slice(currentPos, currentPos + 2) === "<=" ||
      input.slice(currentPos, currentPos + 2) === ">="
    ) {
      const op = input.slice(currentPos, currentPos + 2) as "<=" | ">=";
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithShift(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else if (input[currentPos] === "<" || input[currentPos] === ">") {
      const op = input[currentPos] as "<" | ">";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithShift(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithShift(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithAdditive(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (
      input.slice(currentPos, currentPos + 2) === "<<" ||
      input.slice(currentPos, currentPos + 2) === ">>"
    ) {
      const op = input.slice(currentPos, currentPos + 2) as "<<" | ">>";
      currentPos += 2;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithAdditive(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithAdditive(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithMultiplicative(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (
      (input[currentPos] === "+" || input[currentPos] === "-") &&
      input[currentPos + 1] !== input[currentPos]
    ) {
      const op = input[currentPos] as "+" | "-";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithMultiplicative(
        p,
        input,
        currentPos
      );
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithMultiplicative(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr: left, pos: currentPos } = parseArithPower(p, input, pos);

  while (true) {
    currentPos = skipArithWhitespace(input, currentPos);
    if (input[currentPos] === "*" && input[currentPos + 1] !== "*") {
      const op = "*";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithPower(p, input, currentPos);
      left = { type: "ArithBinary", operator: "*", left, right };
      currentPos = p2;
    } else if (input[currentPos] === "/" || input[currentPos] === "%") {
      const op = input[currentPos] as "/" | "%";
      currentPos++;
      if (isMissingOperand(input, currentPos)) {
        return makeMissingOperandError(op, currentPos);
      }
      const { expr: right, pos: p2 } = parseArithPower(p, input, currentPos);
      left = { type: "ArithBinary", operator: op, left, right };
      currentPos = p2;
    } else {
      break;
    }
  }

  return { expr: left, pos: currentPos };
}

function parseArithPower(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  const { expr: base, pos: currentPos } = parseArithUnary(p, input, pos);
  let p2 = skipArithWhitespace(input, currentPos);

  if (input.slice(p2, p2 + 2) === "**") {
    const op = "**";
    p2 += 2;
    if (isMissingOperand(input, p2)) {
      return makeMissingOperandError(op, p2);
    }
    const { expr: exponent, pos: p3 } = parseArithPower(p, input, p2); // Right associative
    return {
      expr: {
        type: "ArithBinary",
        operator: "**",
        left: base,
        right: exponent
      },
      pos: p3
    };
  }

  return { expr: base, pos: currentPos };
}

function parseArithUnary(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let currentPos = skipArithWhitespace(input, pos);

  // Prefix operators: ++ -- + - ! ~
  if (
    input.slice(currentPos, currentPos + 2) === "++" ||
    input.slice(currentPos, currentPos + 2) === "--"
  ) {
    const op = input.slice(currentPos, currentPos + 2) as "++" | "--";
    currentPos += 2;
    const { expr: operand, pos: p2 } = parseArithUnary(p, input, currentPos);
    return {
      expr: { type: "ArithUnary", operator: op, operand, prefix: true },
      pos: p2
    };
  }

  if (
    input[currentPos] === "+" ||
    input[currentPos] === "-" ||
    input[currentPos] === "!" ||
    input[currentPos] === "~"
  ) {
    const op = input[currentPos] as "+" | "-" | "!" | "~";
    currentPos++;
    const { expr: operand, pos: p2 } = parseArithUnary(p, input, currentPos);
    return {
      expr: { type: "ArithUnary", operator: op, operand, prefix: true },
      pos: p2
    };
  }

  return parseArithPostfix(p, input, currentPos);
}

/**
 * Check if a character can start another concatenated primary (expansion)
 * This is used to detect adjacent expansions like $(cmd)${var}
 */
function canStartConcatPrimary(input: string, pos: number): boolean {
  const c = input[pos];
  // $ starts command sub, parameter expansion, nested arith, or variable
  if (c === "$") return true;
  // ` starts backtick command substitution
  if (c === "`") return true;
  return false;
}

function parseArithPostfix(
  p: Parser,
  input: string,
  pos: number
): { expr: ArithExpr; pos: number } {
  let { expr, pos: currentPos } = parseArithPrimary(p, input, pos, false);

  // Check for adjacent primaries without whitespace (concatenation)
  // e.g., $(echo 1)${undefined:-3} → "13"
  // When collecting parts for concatenation, skip assignment checking
  // because assignment applies to the full concatenated name
  const parts: ArithExpr[] = [expr];
  while (canStartConcatPrimary(input, currentPos)) {
    const { expr: nextExpr, pos: nextPos } = parseArithPrimary(
      p,
      input,
      currentPos,
      true // Skip assignment check for concat parts
    );
    parts.push(nextExpr);
    currentPos = nextPos;
  }

  if (parts.length > 1) {
    expr = { type: "ArithConcat", parts };
  }

  // Check for array subscript on concatenated expression: x$foo[5]
  // This handles dynamic array names where subscript applies to the full concatenated name
  let subscript: ArithExpr | undefined;
  if (input[currentPos] === "[" && expr.type === "ArithConcat") {
    currentPos++; // Skip [
    const { expr: indexExpr, pos: p2 } = parseArithExpr(p, input, currentPos);
    subscript = indexExpr;
    currentPos = p2;
    if (input[currentPos] === "]") currentPos++; // Skip ]
  }

  // If we have a subscript on a concat, wrap it in ArithDynamicElement
  // This allows unary operators to properly handle dynamic array elements
  if (subscript && expr.type === "ArithConcat") {
    expr = { type: "ArithDynamicElement" as const, nameExpr: expr, subscript };
    subscript = undefined; // Clear so we don't use it again for assignment
  }

  currentPos = skipArithWhitespace(input, currentPos);

  // Check for assignment operators after building full expression
  // This handles dynamic variable names like x$foo = 42 or x$foo[5] = 42
  if (
    expr.type === "ArithConcat" ||
    expr.type === "ArithVariable" ||
    expr.type === "ArithDynamicElement"
  ) {
    for (const op of ARITH_ASSIGN_OPS) {
      if (
        input.slice(currentPos, currentPos + op.length) === op &&
        input.slice(currentPos, currentPos + op.length + 1) !== "=="
      ) {
        currentPos += op.length;
        const { expr: value, pos: p2 } = parseArithTernary(
          p,
          input,
          currentPos
        );
        // For dynamic element (x$foo[5]), create dynamic assignment with subscript from the element
        if (expr.type === "ArithDynamicElement") {
          return {
            expr: {
              type: "ArithDynamicAssignment" as const,
              operator: op as ArithAssignmentOperator,
              target: expr.nameExpr,
              subscript: expr.subscript,
              value
            },
            pos: p2
          };
        }
        // For concat (without subscript), create a dynamic assignment
        if (expr.type === "ArithConcat") {
          return {
            expr: {
              type: "ArithDynamicAssignment" as const,
              operator: op as ArithAssignmentOperator,
              target: expr,
              value
            },
            pos: p2
          };
        }
        // For simple variable, create regular assignment
        return {
          expr: {
            type: "ArithAssignment",
            operator: op as ArithAssignmentOperator,
            variable: (expr as { name: string }).name,
            value
          },
          pos: p2
        };
      }
    }
  }

  // Postfix operators: ++ --
  if (
    input.slice(currentPos, currentPos + 2) === "++" ||
    input.slice(currentPos, currentPos + 2) === "--"
  ) {
    const op = input.slice(currentPos, currentPos + 2) as "++" | "--";
    currentPos += 2;
    return {
      expr: {
        type: "ArithUnary",
        operator: op,
        operand: expr,
        prefix: false
      },
      pos: currentPos
    };
  }

  return { expr, pos: currentPos };
}

function parseArithPrimary(
  p: Parser,
  input: string,
  pos: number,
  skipAssignment = false
): { expr: ArithExpr; pos: number } {
  let currentPos = skipArithWhitespace(input, pos);

  // Nested arithmetic: $((expr))
  const nestedResult = parseNestedArithmetic(
    parseArithExpr,
    p,
    input,
    currentPos
  );
  if (nestedResult) return nestedResult;

  // ANSI-C quoting: $'...' - evaluates to the string's numeric value
  const ansiResult = parseAnsiCQuoting(input, currentPos);
  if (ansiResult) return ansiResult;

  // Localization quoting: $"..." - same as double quotes in our context
  const locResult = parseLocalizationQuoting(input, currentPos);
  if (locResult) return locResult;

  // Command substitution: $(cmd)
  if (
    input.slice(currentPos, currentPos + 2) === "$(" &&
    input[currentPos + 2] !== "("
  ) {
    currentPos += 2;
    // Find matching )
    let depth = 1;
    const cmdStart = currentPos;
    while (currentPos < input.length && depth > 0) {
      if (input[currentPos] === "(") depth++;
      else if (input[currentPos] === ")") depth--;
      if (depth > 0) currentPos++;
    }
    const cmd = input.slice(cmdStart, currentPos);
    currentPos++; // Skip )
    return {
      expr: { type: "ArithCommandSubst", command: cmd },
      pos: currentPos
    };
  }

  // Backtick command substitution: `cmd`
  if (input[currentPos] === "`") {
    currentPos++;
    const cmdStart = currentPos;
    while (currentPos < input.length && input[currentPos] !== "`") {
      currentPos++;
    }
    const cmd = input.slice(cmdStart, currentPos);
    if (input[currentPos] === "`") currentPos++;
    return {
      expr: { type: "ArithCommandSubst", command: cmd },
      pos: currentPos
    };
  }

  // Grouped expression
  if (input[currentPos] === "(") {
    currentPos++;
    const { expr, pos: p2 } = parseArithExpr(p, input, currentPos);
    currentPos = skipArithWhitespace(input, p2);
    if (input[currentPos] === ")") currentPos++;
    return { expr: { type: "ArithGroup", expression: expr }, pos: currentPos };
  }

  // Single-quoted string: '...' - context-dependent behavior
  // In bash $(( )) expansion context, single quotes cause an error.
  // In bash (( )) command context, single quotes work like numbers.
  // We create a special ArithSingleQuote node that stores both the content
  // and numeric value, allowing the evaluator to handle it based on context.
  if (input[currentPos] === "'") {
    currentPos++; // Skip opening '
    let content = "";
    while (currentPos < input.length && input[currentPos] !== "'") {
      content += input[currentPos];
      currentPos++;
    }
    if (input[currentPos] === "'") currentPos++; // Skip closing '
    const numValue = Number.parseInt(content, 10);
    return {
      expr: {
        type: "ArithSingleQuote",
        content,
        value: Number.isNaN(numValue) ? 0 : numValue
      },
      pos: currentPos
    };
  }

  // Double-quoted string: "..." - In bash, the content is text-inserted into the expression
  // e.g., $(( "1 + 2" * 3 )) becomes $(( 1 + 2 * 3 )) = 7
  // The quoted content is parsed inline, NOT as a grouped sub-expression
  if (input[currentPos] === '"') {
    currentPos++; // Skip opening "
    let content = "";
    while (currentPos < input.length && input[currentPos] !== '"') {
      if (input[currentPos] === "\\" && currentPos + 1 < input.length) {
        content += input[currentPos + 1];
        currentPos += 2;
      } else {
        content += input[currentPos];
        currentPos++;
      }
    }
    if (input[currentPos] === '"') currentPos++; // Skip closing "
    // Parse the content as an expression and return it directly (no grouping)
    const trimmed = content.trim();
    if (!trimmed) {
      return { expr: { type: "ArithNumber", value: 0 }, pos: currentPos };
    }
    const { expr } = parseArithExpr(p, trimmed, 0);
    return { expr, pos: currentPos };
  }

  // Number
  if (/[0-9]/.test(input[currentPos])) {
    let numStr = "";
    let seenHash = false;
    let isHex = false;
    // Handle different bases: 0x, 0, base#num
    while (currentPos < input.length) {
      const ch = input[currentPos];
      // After #, allow alphanumeric plus @ and _ for base#num format (e.g., 64#_)
      if (seenHash) {
        if (/[0-9a-zA-Z@_]/.test(ch)) {
          numStr += ch;
          currentPos++;
        } else {
          break;
        }
      } else if (ch === "#") {
        seenHash = true;
        numStr += ch;
        currentPos++;
      } else if (
        numStr === "0" &&
        (ch === "x" || ch === "X") &&
        currentPos + 1 < input.length &&
        /[0-9a-fA-F]/.test(input[currentPos + 1])
      ) {
        // Start of hex: 0x followed by hex digit
        isHex = true;
        numStr += ch;
        currentPos++;
      } else if (isHex && /[0-9a-fA-F]/.test(ch)) {
        // Continue hex digits
        numStr += ch;
        currentPos++;
      } else if (!isHex && /[0-9]/.test(ch)) {
        // Decimal or octal digits only (no letters unless hex)
        numStr += ch;
        currentPos++;
      } else {
        break;
      }
    }
    // Check for invalid constant: a number followed by a letter that isn't a valid identifier start
    // e.g., "42x" is invalid - the "x" makes it invalid
    // But we've already parsed just the digits, so check if next char is a letter
    if (currentPos < input.length && /[a-zA-Z_]/.test(input[currentPos])) {
      // Consume the trailing letters to form the invalid token for error message
      let invalidToken = numStr;
      while (
        currentPos < input.length &&
        /[a-zA-Z0-9_]/.test(input[currentPos])
      ) {
        invalidToken += input[currentPos];
        currentPos++;
      }
      // Return an error node that will throw at evaluation time
      return {
        expr: {
          type: "ArithSyntaxError" as const,
          errorToken: invalidToken,
          message: `${invalidToken}: value too great for base (error token is "${invalidToken}")`
        },
        pos: currentPos
      };
    }
    // Check for floating point (not supported in bash arithmetic)
    if (input[currentPos] === "." && /[0-9]/.test(input[currentPos + 1])) {
      throw new ArithmeticError(
        `${numStr}.${input[currentPos + 1]}...: syntax error: invalid arithmetic operator`
      );
    }
    // Check for array subscript on number: 1[2] is invalid - numbers can't be indexed
    // Instead of throwing at parse time, return a special node that throws at evaluation
    if (input[currentPos] === "[") {
      // Find the error token (everything from [ onwards)
      const errorToken = input.slice(currentPos).trim();
      return {
        expr: {
          type: "ArithNumberSubscript" as const,
          number: numStr,
          errorToken
        },
        pos: input.length // Consume the rest
      };
    }
    const value = parseArithNumber(numStr);
    return { expr: { type: "ArithNumber", value }, pos: currentPos };
  }

  // Variable (optionally with $ prefix)
  // Handle ${...} braced parameter expansion
  if (input[currentPos] === "$" && input[currentPos + 1] === "{") {
    const braceStart = currentPos + 2;
    let braceDepth = 1;
    let i = braceStart;
    while (i < input.length && braceDepth > 0) {
      if (input[i] === "{") braceDepth++;
      else if (input[i] === "}") braceDepth--;
      if (braceDepth > 0) i++;
    }
    const content = input.slice(braceStart, i);
    const afterBrace = i + 1; // Position past the closing }

    // Check for dynamic base constant: ${base}#value or ${base}xHEX or ${base}octal
    // This handles cases like: ${base}#a, ${zero}11, ${zero}xAB
    if (input[afterBrace] === "#") {
      // Dynamic base#value: ${base}#digits
      let valueEnd = afterBrace + 1;
      while (valueEnd < input.length && /[0-9a-zA-Z@_]/.test(input[valueEnd])) {
        valueEnd++;
      }
      const valueStr = input.slice(afterBrace + 1, valueEnd);
      return {
        expr: { type: "ArithDynamicBase", baseExpr: content, value: valueStr },
        pos: valueEnd
      };
    }
    if (
      /[0-9]/.test(input[afterBrace]) ||
      input[afterBrace] === "x" ||
      input[afterBrace] === "X"
    ) {
      // Dynamic octal (${zero}11) or hex (${zero}xAB)
      let numEnd = afterBrace;
      if (input[afterBrace] === "x" || input[afterBrace] === "X") {
        numEnd++; // Skip x/X
        while (numEnd < input.length && /[0-9a-fA-F]/.test(input[numEnd])) {
          numEnd++;
        }
      } else {
        while (numEnd < input.length && /[0-9]/.test(input[numEnd])) {
          numEnd++;
        }
      }
      const suffix = input.slice(afterBrace, numEnd);
      return {
        expr: { type: "ArithDynamicNumber", prefix: content, suffix },
        pos: numEnd
      };
    }

    currentPos = afterBrace;
    return { expr: { type: "ArithBracedExpansion", content }, pos: currentPos };
  }
  // Handle $1, $2, etc. (positional parameters)
  if (
    input[currentPos] === "$" &&
    currentPos + 1 < input.length &&
    /[0-9]/.test(input[currentPos + 1])
  ) {
    currentPos++; // Skip the $
    let name = "";
    while (currentPos < input.length && /[0-9]/.test(input[currentPos])) {
      name += input[currentPos];
      currentPos++;
    }
    return {
      expr: { type: "ArithVariable", name, hasDollarPrefix: true },
      pos: currentPos
    };
  }
  // Handle special variables: $*, $@, $#, $?, $-, $!, $$
  if (
    input[currentPos] === "$" &&
    currentPos + 1 < input.length &&
    /[*@#?\-!$]/.test(input[currentPos + 1])
  ) {
    const name = input[currentPos + 1];
    currentPos += 2; // Skip $X
    return { expr: { type: "ArithSpecialVar", name }, pos: currentPos };
  }
  // Handle $name (regular variables with $ prefix)
  let hasDollarPrefix = false;
  if (
    input[currentPos] === "$" &&
    currentPos + 1 < input.length &&
    /[a-zA-Z_]/.test(input[currentPos + 1])
  ) {
    hasDollarPrefix = true;
    currentPos++; // Skip the $ prefix
  }
  if (currentPos < input.length && /[a-zA-Z_]/.test(input[currentPos])) {
    let name = "";
    while (
      currentPos < input.length &&
      /[a-zA-Z0-9_]/.test(input[currentPos])
    ) {
      name += input[currentPos];
      currentPos++;
    }

    // Check for array indexing: array[index]
    // Skip if in concat context - subscript should be handled at postfix level for dynamic names
    if (input[currentPos] === "[" && !skipAssignment) {
      currentPos++; // Skip [

      // Check for quoted string key: array['key'] or array["key"]
      let stringKey: string | undefined;
      if (input[currentPos] === "'" || input[currentPos] === '"') {
        const quote = input[currentPos];
        currentPos++;
        stringKey = "";
        while (currentPos < input.length && input[currentPos] !== quote) {
          stringKey += input[currentPos];
          currentPos++;
        }
        if (input[currentPos] === quote) currentPos++;
        // Skip to ]
        currentPos = skipArithWhitespace(input, currentPos);
        if (input[currentPos] === "]") currentPos++;
      }

      let indexExpr: ArithExpr | undefined;
      if (stringKey === undefined) {
        const { expr, pos: p2 } = parseArithExpr(p, input, currentPos);
        indexExpr = expr;
        currentPos = p2;
        if (input[currentPos] === "]") currentPos++; // Skip ]
      }

      currentPos = skipArithWhitespace(input, currentPos);
      // Detect double subscript: a[1][1] is not valid - mark as error but don't throw during parsing
      if (input[currentPos] === "[" && indexExpr) {
        // Return a special error node that will fail during evaluation
        return {
          expr: { type: "ArithDoubleSubscript", array: name, index: indexExpr },
          pos: currentPos
        };
      }

      // Check for assignment operators after array subscript (skip if in concat context)
      if (!skipAssignment) {
        for (const op of ARITH_ASSIGN_OPS) {
          if (
            input.slice(currentPos, currentPos + op.length) === op &&
            input.slice(currentPos, currentPos + op.length + 1) !== "=="
          ) {
            currentPos += op.length;
            const { expr: value, pos: p2 } = parseArithTernary(
              p,
              input,
              currentPos
            );
            return {
              expr: {
                type: "ArithAssignment",
                operator: op as ArithAssignmentOperator,
                variable: name,
                subscript: indexExpr,
                stringKey,
                value
              },
              pos: p2
            };
          }
        }
      }

      return {
        expr: {
          type: "ArithArrayElement",
          array: name,
          index: indexExpr,
          stringKey
        },
        pos: currentPos
      };
    }

    currentPos = skipArithWhitespace(input, currentPos);

    // Check for assignment operators (skip if in concat context)
    // Assignment has higher precedence than comma, so parse RHS with parseArithTernary
    // This makes `a = b, c` parse as `(a = b), c` not `a = (b, c)`
    if (!skipAssignment) {
      for (const op of ARITH_ASSIGN_OPS) {
        if (
          input.slice(currentPos, currentPos + op.length) === op &&
          input.slice(currentPos, currentPos + op.length + 1) !== "=="
        ) {
          currentPos += op.length;
          // Use parseArithTernary instead of parseArithExpr to give assignment higher precedence than comma
          const { expr: value, pos: p2 } = parseArithTernary(
            p,
            input,
            currentPos
          );
          return {
            expr: {
              type: "ArithAssignment",
              operator: op as ArithAssignmentOperator,
              variable: name,
              value
            },
            pos: p2
          };
        }
      }
    }

    return {
      expr: { type: "ArithVariable", name, hasDollarPrefix },
      pos: currentPos
    };
  }

  // Check for invalid characters like # that would cause syntax errors in bash
  // The # character is only valid as part of base notation (e.g., 2#1010) which is
  // handled in the number parsing above. A bare # is a syntax error in bash arithmetic.
  // We return an error node so the error happens at runtime, not parse time.
  if (input[currentPos] === "#") {
    // Find what comes after for error message
    let errorEnd = currentPos + 1;
    while (errorEnd < input.length && input[errorEnd] !== "\n") {
      errorEnd++;
    }
    const errorToken = input.slice(currentPos, errorEnd).trim() || "#";
    return {
      expr: {
        type: "ArithSyntaxError" as const,
        errorToken,
        message: `${errorToken}: syntax error: invalid arithmetic operator (error token is "${errorToken}")`
      },
      pos: input.length // Consume the rest
    };
  }

  // Default: 0
  return { expr: { type: "ArithNumber", value: 0 }, pos: currentPos };
}
