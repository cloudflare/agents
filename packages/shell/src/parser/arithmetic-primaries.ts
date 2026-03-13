/**
 * Helper functions for parsing primary arithmetic expressions
 */

import type { ArithExpr } from "../ast/types";
import type { Parser } from "./parser";

/**
 * Skip whitespace in arithmetic expression input.
 * Also handles line continuations (backslash followed by newline).
 */
export function skipArithWhitespace(input: string, pos: number): number {
  while (pos < input.length) {
    // Skip line continuations (backslash followed by newline)
    if (input[pos] === "\\" && input[pos + 1] === "\n") {
      pos += 2;
      continue;
    }
    // Skip regular whitespace
    if (/\s/.test(input[pos])) {
      pos++;
      continue;
    }
    break;
  }
  return pos;
}

/**
 * Assignment operators in arithmetic expressions
 */
export const ARITH_ASSIGN_OPS = [
  "=",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "<<=",
  ">>=",
  "&=",
  "|=",
  "^="
] as const;

/**
 * Parse a number string with various bases (decimal, hex, octal, base#num)
 * Returns NaN for invalid numbers.
 */
export function parseArithNumber(str: string): number {
  // Handle base#num format
  // Bash supports bases 2-64 with digits: 0-9, a-z (10-35), A-Z (36-61), @ (62), _ (63)
  if (str.includes("#")) {
    const [baseStr, numStr] = str.split("#");
    const base = Number.parseInt(baseStr, 10);
    if (base < 2 || base > 64) {
      return Number.NaN;
    }
    // For bases <= 36, we can use parseInt
    if (base <= 36) {
      const result = Number.parseInt(numStr, base);
      // Clamp to MAX_SAFE_INTEGER (we don't support 64-bit integers)
      if (result > Number.MAX_SAFE_INTEGER) {
        return Number.MAX_SAFE_INTEGER;
      }
      return result;
    }

    // For bases 37-64, manually calculate
    let result = 0;
    for (const ch of numStr) {
      let digitValue: number;
      if (/[0-9]/.test(ch)) {
        digitValue = ch.charCodeAt(0) - "0".charCodeAt(0);
      } else if (/[a-z]/.test(ch)) {
        digitValue = ch.charCodeAt(0) - "a".charCodeAt(0) + 10;
      } else if (/[A-Z]/.test(ch)) {
        digitValue = ch.charCodeAt(0) - "A".charCodeAt(0) + 36;
      } else if (ch === "@") {
        digitValue = 62;
      } else if (ch === "_") {
        digitValue = 63;
      } else {
        return Number.NaN;
      }
      if (digitValue >= base) {
        return Number.NaN;
      }
      result = result * base + digitValue;
      // Clamp to MAX_SAFE_INTEGER (we don't support 64-bit integers)
      if (result > Number.MAX_SAFE_INTEGER) {
        return Number.MAX_SAFE_INTEGER;
      }
    }
    return result;
  }

  // Handle hex (0x or 0X prefix)
  if (str.startsWith("0x") || str.startsWith("0X")) {
    const result = Number.parseInt(str.slice(2), 16);
    if (result > Number.MAX_SAFE_INTEGER) {
      return Number.MAX_SAFE_INTEGER;
    }
    return result;
  }

  // Handle octal (leading 0, but not just "0")
  if (str.startsWith("0") && str.length > 1 && /^[0-9]+$/.test(str)) {
    // If it looks like octal (0-prefixed digits) but has 8 or 9, it's an error
    if (/[89]/.test(str)) {
      return Number.NaN;
    }
    const result = Number.parseInt(str, 8);
    if (result > Number.MAX_SAFE_INTEGER) {
      return Number.MAX_SAFE_INTEGER;
    }
    return result;
  }

  // Decimal
  const result = Number.parseInt(str, 10);
  if (result > Number.MAX_SAFE_INTEGER) {
    return Number.MAX_SAFE_INTEGER;
  }
  return result;
}

/**
 * Parse nested arithmetic expression: $((expr))
 */
export function parseNestedArithmetic(
  parseArithExpr: (
    p: Parser,
    input: string,
    pos: number
  ) => { expr: ArithExpr; pos: number },
  p: Parser,
  input: string,
  currentPos: number
): { expr: ArithExpr; pos: number } | null {
  if (input.slice(currentPos, currentPos + 3) !== "$((") {
    return null;
  }

  let pos = currentPos + 3;
  let depth = 1;
  const exprStart = pos;
  while (pos < input.length - 1 && depth > 0) {
    if (input[pos] === "(" && input[pos + 1] === "(") {
      depth++;
      pos += 2;
    } else if (input[pos] === ")" && input[pos + 1] === ")") {
      depth--;
      if (depth > 0) pos += 2;
    } else {
      pos++;
    }
  }
  const nestedExpr = input.slice(exprStart, pos);
  const { expr } = parseArithExpr(p, nestedExpr, 0);
  pos += 2; // Skip ))
  return { expr: { type: "ArithNested", expression: expr }, pos };
}

/**
 * Parse ANSI-C quoting: $'...'
 * Returns the numeric value of the string content
 */
export function parseAnsiCQuoting(
  input: string,
  currentPos: number
): { expr: ArithExpr; pos: number } | null {
  if (input.slice(currentPos, currentPos + 2) !== "$'") {
    return null;
  }

  let pos = currentPos + 2; // Skip $'
  let content = "";
  while (pos < input.length && input[pos] !== "'") {
    if (input[pos] === "\\" && pos + 1 < input.length) {
      const nextChar = input[pos + 1];
      switch (nextChar) {
        case "n":
          content += "\n";
          break;
        case "t":
          content += "\t";
          break;
        case "r":
          content += "\r";
          break;
        case "\\":
          content += "\\";
          break;
        case "'":
          content += "'";
          break;
        default:
          content += nextChar;
      }
      pos += 2;
    } else {
      content += input[pos];
      pos++;
    }
  }
  if (input[pos] === "'") pos++; // Skip closing '
  const numValue = Number.parseInt(content, 10);
  return {
    expr: {
      type: "ArithNumber",
      value: Number.isNaN(numValue) ? 0 : numValue
    },
    pos
  };
}

/**
 * Parse localization quoting: $"..."
 * Returns the numeric value of the string content
 */
export function parseLocalizationQuoting(
  input: string,
  currentPos: number
): { expr: ArithExpr; pos: number } | null {
  if (input.slice(currentPos, currentPos + 2) !== '$"') {
    return null;
  }

  let pos = currentPos + 2; // Skip $"
  let content = "";
  while (pos < input.length && input[pos] !== '"') {
    if (input[pos] === "\\" && pos + 1 < input.length) {
      content += input[pos + 1];
      pos += 2;
    } else {
      content += input[pos];
      pos++;
    }
  }
  if (input[pos] === '"') pos++; // Skip closing "
  const numValue = Number.parseInt(content, 10);
  return {
    expr: {
      type: "ArithNumber",
      value: Number.isNaN(numValue) ? 0 : numValue
    },
    pos
  };
}
