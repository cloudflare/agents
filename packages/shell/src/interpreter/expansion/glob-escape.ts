/**
 * Glob Helper Functions
 *
 * Functions for handling glob patterns, escaping, and unescaping.
 */

/**
 * Check if a string contains glob patterns, including extglob when enabled.
 */
export function hasGlobPattern(value: string, extglob: boolean): boolean {
  // Standard glob characters
  if (/[*?[]/.test(value)) {
    return true;
  }
  // Extglob patterns: @(...), *(...), +(...), ?(...), !(...)
  if (extglob && /[@*+?!]\(/.test(value)) {
    return true;
  }
  return false;
}

/**
 * Unescape a glob pattern - convert escaped glob chars to literal chars.
 * For example, [\]_ (escaped pattern) becomes [\\]_ (literal string).
 *
 * This is used when we need to take a pattern that was built with escaped
 * glob characters and convert it back to a literal string (e.g., for
 * no-match fallback when nullglob is off).
 *
 * Note: The input is expected to be a pattern string where backslashes escape
 * the following character. For patterns like "test\\[*" (user input: test\[*)
 * the output is "\\_" (with processed escapes), not [\\]_ (raw pattern).
 */
export function unescapeGlobPattern(pattern: string): string {
  let result = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "\\" && i + 1 < pattern.length) {
      // Backslash escapes the next character - output just the escaped char
      result += pattern[i + 1];
      i += 2;
    } else {
      result += pattern[i];
      i++;
    }
  }
  return result;
}

/**
 * Escape glob metacharacters in a string for literal matching.
 * Includes extglob metacharacters: ( ) |
 */
export function escapeGlobChars(str: string): string {
  return str.replace(/([*?[\]\\()|])/g, "\\$1");
}

/**
 * Escape regex metacharacters in a string for literal matching.
 * Used when quoted patterns are used with =~ operator.
 */
export function escapeRegexChars(str: string): string {
  return str.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
