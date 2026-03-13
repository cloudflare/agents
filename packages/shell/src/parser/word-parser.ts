/**
 * Word Parsing Utilities
 *
 * String manipulation utilities for parsing words, expansions, and patterns.
 * These are pure functions extracted from the Parser class.
 */

import {
  type ArithmeticExpressionNode,
  AST,
  type RedirectionOperator,
  type WordNode,
  type WordPart
} from "../ast/types";
import { parseArithmeticExpression } from "./arithmetic-parser";
import { TokenType } from "./lexer";
import type { Parser } from "./parser";

// =============================================================================
// PURE STRING UTILITIES
// =============================================================================

/**
 * Decode a byte array as UTF-8 with error recovery.
 * Valid UTF-8 sequences are decoded to their Unicode characters.
 * Invalid bytes are preserved as Latin-1 characters (byte value = char code).
 *
 * This matches bash's behavior for $'\xNN' sequences.
 */
function decodeUtf8WithRecovery(bytes: number[]): string {
  let result = "";
  let i = 0;

  while (i < bytes.length) {
    const b0 = bytes[i];

    // ASCII (0xxxxxxx)
    if (b0 < 0x80) {
      result += String.fromCharCode(b0);
      i++;
      continue;
    }

    // 2-byte sequence (110xxxxx 10xxxxxx)
    if ((b0 & 0xe0) === 0xc0) {
      if (
        i + 1 < bytes.length &&
        (bytes[i + 1] & 0xc0) === 0x80 &&
        b0 >= 0xc2 // Reject overlong sequences
      ) {
        const codePoint = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
        result += String.fromCharCode(codePoint);
        i += 2;
        continue;
      }
      // Invalid or incomplete - output as Latin-1
      result += String.fromCharCode(b0);
      i++;
      continue;
    }

    // 3-byte sequence (1110xxxx 10xxxxxx 10xxxxxx)
    if ((b0 & 0xf0) === 0xe0) {
      if (
        i + 2 < bytes.length &&
        (bytes[i + 1] & 0xc0) === 0x80 &&
        (bytes[i + 2] & 0xc0) === 0x80
      ) {
        // Check for overlong encoding
        if (b0 === 0xe0 && bytes[i + 1] < 0xa0) {
          // Overlong - output first byte as Latin-1
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        // Check for surrogate range (U+D800-U+DFFF)
        const codePoint =
          ((b0 & 0x0f) << 12) |
          ((bytes[i + 1] & 0x3f) << 6) |
          (bytes[i + 2] & 0x3f);
        if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
          // Invalid surrogate - output first byte as Latin-1
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        result += String.fromCharCode(codePoint);
        i += 3;
        continue;
      }
      // Invalid or incomplete - output as Latin-1
      result += String.fromCharCode(b0);
      i++;
      continue;
    }

    // 4-byte sequence (11110xxx 10xxxxxx 10xxxxxx 10xxxxxx)
    if ((b0 & 0xf8) === 0xf0 && b0 <= 0xf4) {
      if (
        i + 3 < bytes.length &&
        (bytes[i + 1] & 0xc0) === 0x80 &&
        (bytes[i + 2] & 0xc0) === 0x80 &&
        (bytes[i + 3] & 0xc0) === 0x80
      ) {
        // Check for overlong encoding
        if (b0 === 0xf0 && bytes[i + 1] < 0x90) {
          // Overlong - output first byte as Latin-1
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        const codePoint =
          ((b0 & 0x07) << 18) |
          ((bytes[i + 1] & 0x3f) << 12) |
          ((bytes[i + 2] & 0x3f) << 6) |
          (bytes[i + 3] & 0x3f);
        // Check for valid range (U+10000 to U+10FFFF)
        if (codePoint > 0x10ffff) {
          // Invalid - output first byte as Latin-1
          result += String.fromCharCode(b0);
          i++;
          continue;
        }
        result += String.fromCodePoint(codePoint);
        i += 4;
        continue;
      }
      // Invalid or incomplete - output as Latin-1
      result += String.fromCharCode(b0);
      i++;
      continue;
    }

    // Invalid lead byte (10xxxxxx or 11111xxx) - output as Latin-1
    result += String.fromCharCode(b0);
    i++;
  }

  return result;
}

export function findTildeEnd(_p: Parser, value: string, start: number): number {
  let i = start + 1;
  while (i < value.length && /[a-zA-Z0-9_-]/.test(value[i])) {
    i++;
  }
  return i;
}

export function findMatchingBracket(
  _p: Parser,
  value: string,
  start: number,
  open: string,
  close: string
): number {
  let depth = 1;
  let i = start + 1;

  while (i < value.length && depth > 0) {
    if (value[i] === open) depth++;
    else if (value[i] === close) depth--;
    if (depth > 0) i++;
  }

  return depth === 0 ? i : -1;
}

export function findParameterOperationEnd(
  _p: Parser,
  value: string,
  start: number
): number {
  let i = start;
  let depth = 1;

  while (i < value.length && depth > 0) {
    const char = value[i];

    // Handle escape sequences - \X escapes the next character
    if (char === "\\" && i + 1 < value.length) {
      i += 2; // Skip escape and the escaped character
      continue;
    }

    // Handle single quotes - content is literal
    if (char === "'") {
      const closeIdx = value.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        i = closeIdx + 1;
        continue;
      }
    }

    // Handle double quotes - content with escapes
    if (char === '"') {
      i++;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < value.length) {
          i += 2;
        } else {
          i++;
        }
      }
      if (i < value.length) i++; // Skip closing quote
      continue;
    }

    if (char === "{") depth++;
    else if (char === "}") depth--;
    if (depth > 0) i++;
  }

  return i;
}

export function findPatternEnd(
  _p: Parser,
  value: string,
  start: number
): number {
  let i = start;

  // In bash, if the pattern starts with /, that / IS the pattern.
  // For ${x////c}: after //, the next / is the pattern, followed by / separator, then c
  // So we need to consume at least one character before treating / as a delimiter.
  let consumedAny = false;

  while (i < value.length) {
    const char = value[i];
    // Only break on / if we've consumed at least one character
    if ((char === "/" && consumedAny) || char === "}") break;

    // Handle single quotes - skip until closing quote
    if (char === "'") {
      const closeIdx = value.indexOf("'", i + 1);
      if (closeIdx !== -1) {
        i = closeIdx + 1;
        consumedAny = true;
        continue;
      }
    }

    // Handle double quotes - skip until closing quote (handling escapes)
    if (char === '"') {
      i++;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\" && i + 1 < value.length) {
          i += 2;
        } else {
          i++;
        }
      }
      if (i < value.length) i++; // Skip closing quote
      consumedAny = true;
      continue;
    }

    if (char === "\\") {
      i += 2;
      consumedAny = true;
    } else {
      i++;
      consumedAny = true;
    }
  }

  return i;
}

export function parseGlobPattern(
  _p: Parser,
  value: string,
  start: number
): { pattern: string; endIndex: number } {
  let i = start;
  let pattern = "";

  while (i < value.length) {
    const char = value[i];

    if (char === "*" || char === "?") {
      pattern += char;
      i++;
    } else if (char === "[") {
      // Character class - need to properly find closing ]
      // Handle POSIX character classes like [[:alpha:]], [^[:alpha:]], etc.
      const closeIdx = findCharacterClassEnd(value, i);
      if (closeIdx === -1) {
        pattern += char;
        i++;
      } else {
        pattern += value.slice(i, closeIdx + 1);
        i = closeIdx + 1;
      }
    } else {
      break;
    }
  }

  return { pattern, endIndex: i };
}

/**
 * Find the closing ] of a character class, properly handling:
 * - POSIX character classes like [:alpha:], [:digit:], etc.
 * - Negation [^...]
 * - Literal ] at the start []] or [^]]
 * - Single quotes inside class (bash extension): [^'abc]'] contains literal ]
 */
function findCharacterClassEnd(value: string, start: number): number {
  let i = start + 1; // Skip opening [

  // Handle negation
  if (i < value.length && value[i] === "^") {
    i++;
  }

  // A ] immediately after [ or [^ is literal, not closing
  if (i < value.length && value[i] === "]") {
    i++;
  }

  while (i < value.length) {
    const char = value[i];

    // Handle escape sequences
    // In bash, shell escaping takes precedence over character class escaping.
    // So \" inside a character class means the shell escaped the quote,
    // and this is NOT a valid character class (bash outputs ["] for [\"])
    // Only \] is valid inside a character class to include literal ]
    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      // If it's an escaped quote or shell special char, this is not a valid character class
      if (next === '"' || next === "'") {
        return -1;
      }
      i += 2; // Skip both the backslash and the escaped character
      continue;
    }

    if (char === "]") {
      return i;
    }

    // If we encounter expansion or quote characters, this is NOT a valid glob
    // character class. In bash, ["$x"] is [ + "$x" + ], not a character class.
    if (char === '"' || char === "$" || char === "`") {
      return -1;
    }

    // Handle single quotes inside character class (bash extension)
    // [^'abc]'] - the ] inside quotes is literal, class ends at second ]
    if (char === "'") {
      const closeQuote = value.indexOf("'", i + 1);
      if (closeQuote !== -1) {
        i = closeQuote + 1;
        continue;
      }
    }

    // Handle POSIX character classes [:name:]
    if (char === "[" && i + 1 < value.length && value[i + 1] === ":") {
      // Find closing :]
      const closePos = value.indexOf(":]", i + 2);
      if (closePos !== -1) {
        i = closePos + 2;
        continue;
      }
    }

    // Handle collating symbols [.name.] and equivalence classes [=name=]
    if (
      char === "[" &&
      i + 1 < value.length &&
      (value[i + 1] === "." || value[i + 1] === "=")
    ) {
      const closeChar = value[i + 1];
      const closeSeq = `${closeChar}]`;
      const closePos = value.indexOf(closeSeq, i + 2);
      if (closePos !== -1) {
        i = closePos + 2;
        continue;
      }
    }

    i++;
  }

  return -1; // No closing ] found
}

export function parseAnsiCQuoted(
  _p: Parser,
  value: string,
  start: number
): { part: WordPart; endIndex: number } {
  let result = "";
  let i = start;

  while (i < value.length && value[i] !== "'") {
    const char = value[i];

    if (char === "\\" && i + 1 < value.length) {
      const next = value[i + 1];
      switch (next) {
        case "n":
          result += "\n";
          i += 2;
          break;
        case "t":
          result += "\t";
          i += 2;
          break;
        case "r":
          result += "\r";
          i += 2;
          break;
        case "\\":
          result += "\\";
          i += 2;
          break;
        case "'":
          result += "'";
          i += 2;
          break;
        case '"':
          result += '"';
          i += 2;
          break;
        case "a":
          result += "\x07"; // bell
          i += 2;
          break;
        case "b":
          result += "\b"; // backspace
          i += 2;
          break;
        case "e":
        case "E":
          result += "\x1b"; // escape
          i += 2;
          break;
        case "f":
          result += "\f"; // form feed
          i += 2;
          break;
        case "v":
          result += "\v"; // vertical tab
          i += 2;
          break;
        case "x": {
          // \xHH - hex escape
          // Collect consecutive \xHH escapes and decode as UTF-8 with error recovery
          const bytes: number[] = [];
          let j = i;
          while (
            j + 1 < value.length &&
            value[j] === "\\" &&
            value[j + 1] === "x"
          ) {
            const hex = value.slice(j + 2, j + 4);
            const code = parseInt(hex, 16);
            if (!Number.isNaN(code) && hex.length > 0) {
              bytes.push(code);
              j += 2 + hex.length;
            } else {
              break;
            }
          }

          if (bytes.length > 0) {
            // Decode bytes as UTF-8 with error recovery
            // Invalid bytes are preserved as Latin-1 characters
            result += decodeUtf8WithRecovery(bytes);
            i = j;
          } else {
            result += "\\x";
            i += 2;
          }
          break;
        }
        case "u": {
          // \uHHHH - unicode escape
          const hex = value.slice(i + 2, i + 6);
          const code = parseInt(hex, 16);
          if (!Number.isNaN(code)) {
            result += String.fromCharCode(code);
            i += 6;
          } else {
            result += "\\u";
            i += 2;
          }
          break;
        }
        case "c": {
          // \cX - control character escape
          // Control char = X & 0x1f (mask with 31)
          // For letters a-z/A-Z: ctrl-A=1, ctrl-Z=26
          // For special chars: \c- = 0x0d (CR), \c+ = 0x0b (VT), \c" = 0x02
          if (i + 2 < value.length) {
            const ctrlChar = value[i + 2];
            const code = ctrlChar.charCodeAt(0) & 0x1f;
            result += String.fromCharCode(code);
            i += 3;
          } else {
            // Incomplete \c at end of string
            result += "\\c";
            i += 2;
          }
          break;
        }
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7": {
          // \NNN - octal escape
          let octal = "";
          let j = i + 1;
          while (j < value.length && j < i + 4 && /[0-7]/.test(value[j])) {
            octal += value[j];
            j++;
          }
          const code = parseInt(octal, 8);
          result += String.fromCharCode(code);
          i = j;
          break;
        }
        default:
          // Unknown escape, keep the backslash
          result += char;
          i++;
      }
    } else {
      result += char;
      i++;
    }
  }

  // Skip closing quote
  if (i < value.length && value[i] === "'") {
    i++;
  }

  return {
    part: AST.literal(result),
    endIndex: i
  };
}

export function parseArithExprFromString(
  p: Parser,
  str: string
): ArithmeticExpressionNode {
  // Trim whitespace - bash allows spaces around arithmetic expressions in slices
  const trimmed = str.trim();
  if (trimmed === "") {
    // Empty string means 0
    return {
      type: "ArithmeticExpression",
      expression: { type: "ArithNumber", value: 0 }
    };
  }
  // Use the full arithmetic expression parser
  return parseArithmeticExpression(p, trimmed);
}

/**
 * Split a brace expansion inner content by commas at the top level.
 * Handles nested braces like {a,{b,c},d} correctly.
 */
function splitBraceItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;

  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "{") {
      depth++;
      current += c;
    } else if (c === "}") {
      depth--;
      current += c;
    } else if (c === "," && depth === 0) {
      items.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  items.push(current);
  return items;
}

export type WordPartsParser = (
  p: Parser,
  value: string,
  quoted?: boolean,
  singleQuoted?: boolean,
  isAssignment?: boolean
) => WordPart[];

export function tryParseBraceExpansion(
  p: Parser,
  value: string,
  start: number,
  parseWordPartsFn?: WordPartsParser
): { part: WordPart; endIndex: number } | null {
  // Find matching }
  const closeIdx = findMatchingBracket(p, value, start, "{", "}");
  if (closeIdx === -1) return null;

  const inner = value.slice(start + 1, closeIdx);

  // Check for range: {a..z} or {1..10} or {1..10..2}
  const rangeMatch = inner.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
  if (rangeMatch) {
    return {
      part: {
        type: "BraceExpansion",
        items: [
          {
            type: "Range",
            start: Number.parseInt(rangeMatch[1], 10),
            end: Number.parseInt(rangeMatch[2], 10),
            step: rangeMatch[3]
              ? Number.parseInt(rangeMatch[3], 10)
              : undefined,
            // Store original strings for zero-padding support
            startStr: rangeMatch[1],
            endStr: rangeMatch[2]
          }
        ]
      },
      endIndex: closeIdx + 1
    };
  }

  // Character ranges: {a..z} or {a..z..2}
  const charRangeMatch = inner.match(
    /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/
  );
  if (charRangeMatch) {
    return {
      part: {
        type: "BraceExpansion",
        items: [
          {
            type: "Range",
            start: charRangeMatch[1],
            end: charRangeMatch[2],
            step: charRangeMatch[3]
              ? Number.parseInt(charRangeMatch[3], 10)
              : undefined
          }
        ]
      },
      endIndex: closeIdx + 1
    };
  }

  // Check for comma-separated list: {a,b,c}
  if (inner.includes(",") && parseWordPartsFn) {
    // Split by comma at top level (handling nested braces)
    const rawItems = splitBraceItems(inner);
    // Parse each item as a word with full expansion support
    const items = rawItems.map((s) => ({
      type: "Word" as const,
      word: AST.word(parseWordPartsFn(p, s, false, false, false))
    }));
    return {
      part: { type: "BraceExpansion", items },
      endIndex: closeIdx + 1
    };
  }

  // Legacy fallback: treat items as literals if no parser provided
  if (inner.includes(",")) {
    const rawItems = splitBraceItems(inner);
    const items = rawItems.map((s) => ({
      type: "Word" as const,
      word: AST.word([AST.literal(s)])
    }));
    return {
      part: { type: "BraceExpansion", items },
      endIndex: closeIdx + 1
    };
  }

  return null;
}

/**
 * Convert a WordNode back to a string representation.
 * Used for reconstructing array assignment strings for declare/local.
 */
export function wordToString(_p: Parser, word: WordNode): string {
  let result = "";
  for (const part of word.parts) {
    switch (part.type) {
      case "Literal":
        result += part.value;
        break;
      case "SingleQuoted":
        // Preserve single quotes so empty strings like '' are not lost
        result += `'${part.value}'`;
        break;
      case "Escaped":
        result += part.value;
        break;
      case "DoubleQuoted":
        // For double-quoted parts, reconstruct them
        result += '"';
        for (const inner of part.parts) {
          if (inner.type === "Literal" || inner.type === "Escaped") {
            result += inner.value;
          } else if (inner.type === "ParameterExpansion") {
            result += `\${${inner.parameter}}`;
          }
        }
        result += '"';
        break;
      case "ParameterExpansion":
        result += `\${${part.parameter}}`;
        break;
      case "Glob":
        result += part.pattern;
        break;
      case "TildeExpansion":
        result += "~";
        if (part.user) {
          result += part.user;
        }
        break;
      case "BraceExpansion": {
        // Reconstruct brace expansion syntax
        result += "{";
        const braceItems: string[] = [];
        for (const item of part.items) {
          if (item.type === "Range") {
            // Reconstruct range: {start..end} or {start..end..step}
            const startVal = item.startStr ?? String(item.start);
            const endVal = item.endStr ?? String(item.end);
            if (item.step !== undefined) {
              braceItems.push(`${startVal}..${endVal}..${item.step}`);
            } else {
              braceItems.push(`${startVal}..${endVal}`);
            }
          } else {
            // Word item - recurse to convert the word
            braceItems.push(wordToString(_p, item.word));
          }
        }
        // If there's only one item and it's a range, use the range syntax
        // Otherwise, join with commas for {a,b,c} syntax
        if (braceItems.length === 1 && part.items[0].type === "Range") {
          result += braceItems[0];
        } else {
          result += braceItems.join(",");
        }
        result += "}";
        break;
      }
      default:
        // For complex parts, just use a placeholder
        result += part.type;
    }
  }
  return result;
}

export function tokenToRedirectOp(
  _p: Parser,
  type: TokenType
): RedirectionOperator {
  const map: Partial<Record<TokenType, RedirectionOperator>> = {
    [TokenType.LESS]: "<",
    [TokenType.GREAT]: ">",
    [TokenType.DGREAT]: ">>",
    [TokenType.LESSAND]: "<&",
    [TokenType.GREATAND]: ">&",
    [TokenType.LESSGREAT]: "<>",
    [TokenType.CLOBBER]: ">|",
    [TokenType.TLESS]: "<<<",
    [TokenType.AND_GREAT]: "&>",
    [TokenType.AND_DGREAT]: "&>>",
    [TokenType.DLESS]: "<", // Here-doc operator is <
    [TokenType.DLESSDASH]: "<"
  };
  return map[type] || ">";
}
