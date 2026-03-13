/**
 * Shared escape sequence and formatting utilities
 * Used by printf command and find -printf
 */

/**
 * Apply width and alignment to a string value
 * Supports: width (right-justify), -width (left-justify), .precision (truncate)
 * @param value - The string value to format
 * @param width - The field width (negative for left-justify)
 * @param precision - Maximum length (-1 for no limit)
 */
export function applyWidth(
  value: string,
  width: number,
  precision: number
): string {
  let result = value;

  // Apply precision (truncate)
  if (precision >= 0 && result.length > precision) {
    result = result.slice(0, precision);
  }

  // Apply width
  const absWidth = Math.abs(width);
  if (absWidth > result.length) {
    if (width < 0) {
      // Left-justify
      result = result.padEnd(absWidth, " ");
    } else {
      // Right-justify
      result = result.padStart(absWidth, " ");
    }
  }

  return result;
}

/**
 * Parse a width/precision spec from a format directive
 * Returns: [width, precision, charsConsumed]
 * width: positive for right-justify, negative for left-justify
 * precision: -1 if not specified
 */
export function parseWidthPrecision(
  format: string,
  startIndex: number
): [number, number, number] {
  let i = startIndex;
  let width = 0;
  let precision = -1;
  let leftJustify = false;

  // Check for - flag (left-justify)
  if (i < format.length && format[i] === "-") {
    leftJustify = true;
    i++;
  }

  // Parse width
  while (i < format.length && /\d/.test(format[i])) {
    width = width * 10 + parseInt(format[i], 10);
    i++;
  }

  // Parse precision
  if (i < format.length && format[i] === ".") {
    i++;
    precision = 0;
    while (i < format.length && /\d/.test(format[i])) {
      precision = precision * 10 + parseInt(format[i], 10);
      i++;
    }
  }

  // Apply left-justify as negative width
  if (leftJustify && width > 0) {
    width = -width;
  }

  return [width, precision, i - startIndex];
}

/**
 * Process escape sequences in a string
 * Handles: \n, \t, \r, \\, \a, \b, \f, \v, \e, \0NNN (octal), \xHH (hex),
 *          \uHHHH (unicode), \UHHHHHHHH (unicode)
 */
export function processEscapes(str: string): string {
  let result = "";
  let i = 0;

  while (i < str.length) {
    if (str[i] === "\\" && i + 1 < str.length) {
      const next = str[i + 1];
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
        case "a":
          result += "\x07";
          i += 2;
          break;
        case "b":
          result += "\b";
          i += 2;
          break;
        case "f":
          result += "\f";
          i += 2;
          break;
        case "v":
          result += "\v";
          i += 2;
          break;
        case "e":
        case "E":
          // Escape character (0x1B) - used for ANSI color codes
          result += "\x1b";
          i += 2;
          break;
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7": {
          // Octal escape sequence
          let octal = "";
          let j = i + 1;
          while (j < str.length && j < i + 4 && /[0-7]/.test(str[j])) {
            octal += str[j];
            j++;
          }
          result += String.fromCharCode(parseInt(octal, 8));
          i = j;
          break;
        }
        case "x": {
          // Hex escape sequence \xHH
          // Collect consecutive \xHH escapes and try to decode as UTF-8
          const bytes: number[] = [];
          let j = i;
          while (
            j + 3 < str.length &&
            str[j] === "\\" &&
            str[j + 1] === "x" &&
            /[0-9a-fA-F]{2}/.test(str.slice(j + 2, j + 4))
          ) {
            bytes.push(parseInt(str.slice(j + 2, j + 4), 16));
            j += 4;
          }

          if (bytes.length > 0) {
            // Try to decode the bytes as UTF-8
            try {
              const decoder = new TextDecoder("utf-8", { fatal: true });
              result += decoder.decode(new Uint8Array(bytes));
            } catch {
              // If not valid UTF-8, fall back to Latin-1 (1:1 byte to codepoint)
              for (const byte of bytes) {
                result += String.fromCharCode(byte);
              }
            }
            i = j;
          } else {
            // No valid hex escape, keep the backslash
            result += str[i];
            i++;
          }
          break;
        }
        case "u": {
          // Unicode escape \uHHHH (1-4 hex digits)
          let hex = "";
          let j = i + 2;
          while (j < str.length && j < i + 6 && /[0-9a-fA-F]/.test(str[j])) {
            hex += str[j];
            j++;
          }
          if (hex) {
            result += String.fromCodePoint(parseInt(hex, 16));
            i = j;
          } else {
            result += "\\u";
            i += 2;
          }
          break;
        }
        case "U": {
          // Unicode escape \UHHHHHHHH (1-8 hex digits)
          let hex = "";
          let j = i + 2;
          while (j < str.length && j < i + 10 && /[0-9a-fA-F]/.test(str[j])) {
            hex += str[j];
            j++;
          }
          if (hex) {
            result += String.fromCodePoint(parseInt(hex, 16));
            i = j;
          } else {
            result += "\\U";
            i += 2;
          }
          break;
        }
        default:
          result += str[i];
          i++;
      }
    } else {
      result += str[i];
      i++;
    }
  }

  return result;
}
