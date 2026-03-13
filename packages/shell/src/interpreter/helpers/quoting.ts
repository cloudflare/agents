/**
 * Shell value quoting utilities
 *
 * Provides functions for quoting values in shell output format,
 * used by both `set` and `declare/typeset` builtins.
 */

/**
 * Check if a character needs $'...' quoting (control characters only)
 * Bash uses $'...' only for control characters (0x00-0x1F, 0x7F).
 * Valid UTF-8 characters above 0x7F are output with regular single quotes.
 */
function needsDollarQuoting(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Only control characters need $'...' quoting
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Quote a value for shell output using $'...' quoting (bash ANSI-C quoting)
 * Only used for values containing control characters.
 */
function dollarQuote(value: string): string {
  let result = "$'";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const code = value.charCodeAt(i);

    if (code === 0x07) {
      result += "\\a"; // bell
    } else if (code === 0x08) {
      result += "\\b"; // backspace
    } else if (code === 0x09) {
      result += "\\t"; // tab
    } else if (code === 0x0a) {
      result += "\\n"; // newline
    } else if (code === 0x0b) {
      result += "\\v"; // vertical tab
    } else if (code === 0x0c) {
      result += "\\f"; // form feed
    } else if (code === 0x0d) {
      result += "\\r"; // carriage return
    } else if (code === 0x1b) {
      result += "\\e"; // escape (bash extension)
    } else if (code === 0x27) {
      result += "\\'"; // single quote
    } else if (code === 0x5c) {
      result += "\\\\"; // backslash
    } else if (code < 0x20 || code === 0x7f) {
      // Other control characters: use octal notation (bash uses \NNN)
      result += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      // Pass through normal characters including UTF-8 (code > 0x7f)
      result += char;
    }
  }
  result += "'";
  return result;
}

/**
 * Quote a value for shell output (used by 'set' and 'typeset' with no args)
 * Matches bash's output format:
 * - No quotes for simple alphanumeric values
 * - Single quotes for values with spaces or shell metacharacters
 * - $'...' quoting for values with control characters
 */
export function quoteValue(value: string): string {
  // If value contains control characters or non-printable, use $'...' quoting
  if (needsDollarQuoting(value)) {
    return dollarQuote(value);
  }

  // If value contains no special chars, return as-is
  // Safe chars: alphanumerics, underscore, slash, dot, colon, hyphen, at, percent, plus, comma, equals
  if (/^[a-zA-Z0-9_/.:\-@%+,=]*$/.test(value)) {
    return value;
  }

  // Use single quotes for values with spaces or shell metacharacters
  // Escape embedded single quotes as '\''
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Quote a value for array element output
 * Uses $'...' for control characters, double quotes otherwise
 */
export function quoteArrayValue(value: string): string {
  // If value needs $'...' quoting, use it
  if (needsDollarQuoting(value)) {
    return dollarQuote(value);
  }
  // For array elements, bash always uses double quotes
  // Escape backslashes and double quotes
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Quote a value for declare -p output
 * Uses $'...' for control characters, double quotes otherwise
 */
export function quoteDeclareValue(value: string): string {
  // If value needs $'...' quoting, use it
  if (needsDollarQuoting(value)) {
    return dollarQuote(value);
  }
  // Otherwise use double quotes with escaping
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
