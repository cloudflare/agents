/**
 * Quoting helpers for word expansion
 *
 * Handles quoting values for shell reuse (${var@Q} transformation).
 */

/**
 * Quote a value for safe reuse as shell input (${var@Q} transformation)
 * Uses single quotes with proper escaping for special characters.
 * Follows bash's quoting behavior:
 * - Simple strings without quotes: 'value'
 * - Strings with single quotes or control characters: $'value' with \' escaping
 */
export function quoteValue(value: string): string {
  // Empty string becomes ''
  if (value === "") return "''";

  // Check if we need $'...' format - for control characters OR single quotes
  // oxlint-disable-next-line no-control-regex -- intentional control char detection
  const needsDollarQuote = /[\n\r\t\x00-\x1f\x7f']/.test(value);

  if (needsDollarQuote) {
    // Use $'...' format for strings with control characters or single quotes
    let result = "$'";
    for (const char of value) {
      switch (char) {
        case "'":
          result += "\\'";
          break;
        case "\\":
          result += "\\\\";
          break;
        case "\n":
          result += "\\n";
          break;
        case "\r":
          result += "\\r";
          break;
        case "\t":
          result += "\\t";
          break;
        default: {
          // Check for control characters
          const code = char.charCodeAt(0);
          if (code < 32 || code === 127) {
            // Use octal escapes like bash does (not hex)
            result += `\\${code.toString(8).padStart(3, "0")}`;
          } else {
            result += char;
          }
        }
      }
    }
    return `${result}'`;
  }

  // For simple strings without control characters or single quotes, use single quotes
  return `'${value}'`;
}
