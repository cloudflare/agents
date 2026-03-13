/**
 * IFS (Internal Field Separator) Handling
 *
 * Centralized utilities for IFS-based word splitting used by:
 * - Word expansion (unquoted variable expansion)
 * - read builtin
 * - ${!prefix*} and ${!arr[*]} expansions
 */

/** Default IFS value: space, tab, newline */
const DEFAULT_IFS = " \t\n";

/**
 * Get the effective IFS value from environment.
 * Returns DEFAULT_IFS if IFS is undefined, or the actual value (including empty string).
 */
export function getIfs(env: Map<string, string>): string {
  return env.get("IFS") ?? DEFAULT_IFS;
}

/**
 * Check if IFS is set to empty string (disables word splitting).
 */
export function isIfsEmpty(env: Map<string, string>): boolean {
  return env.get("IFS") === "";
}

/**
 * Check if IFS contains only whitespace characters (space, tab, newline).
 * This affects how empty fields are handled in $@ and $* expansion.
 * When IFS has non-whitespace chars, empty params are preserved.
 * When IFS has only whitespace, empty params are dropped.
 */
export function isIfsWhitespaceOnly(env: Map<string, string>): boolean {
  const ifs = getIfs(env);
  if (ifs === "") return true; // Empty IFS counts as "whitespace only" for this purpose
  for (const ch of ifs) {
    if (ch !== " " && ch !== "\t" && ch !== "\n") {
      return false;
    }
  }
  return true;
}

/**
 * Build a regex-safe pattern from IFS characters for use in character classes.
 * E.g., for IFS=" \t\n", returns " \\t\\n" (escaped for [pattern] use)
 */
export function buildIfsCharClassPattern(ifs: string): string {
  let hasDash = false;
  const parts: string[] = [];
  for (const c of ifs.split("")) {
    if (c === "-") {
      // Defer '-' to place it last in the character class
      hasDash = true;
    } else if (/[\\^$.*+?()[\]{}|]/.test(c)) {
      parts.push(`\\${c}`);
    } else if (c === "\t") {
      parts.push("\\t");
    } else if (c === "\n") {
      parts.push("\\n");
    } else {
      parts.push(c);
    }
  }
  // Place '-' last to prevent unintended ranges like [a-z]
  if (hasDash) {
    parts.push("\\-");
  }
  return parts.join("");
}

/**
 * Get the first character of IFS (used for joining with $* and ${!prefix*}).
 * Returns space if IFS is undefined, empty string if IFS is empty.
 */
export function getIfsSeparator(env: Map<string, string>): string {
  const ifs = env.get("IFS");
  if (ifs === undefined) return " ";
  return ifs[0] || "";
}

/** IFS whitespace characters */
const IFS_WHITESPACE = " \t\n";

/**
 * Check if a character is an IFS whitespace character.
 */
function isIfsWhitespace(ch: string): boolean {
  return IFS_WHITESPACE.includes(ch);
}

/**
 * Split IFS characters into whitespace and non-whitespace sets.
 */
function categorizeIfs(ifs: string): {
  whitespace: Set<string>;
  nonWhitespace: Set<string>;
} {
  const whitespace = new Set<string>();
  const nonWhitespace = new Set<string>();
  for (const ch of ifs) {
    if (isIfsWhitespace(ch)) {
      whitespace.add(ch);
    } else {
      nonWhitespace.add(ch);
    }
  }
  return { whitespace, nonWhitespace };
}

/**
 * Advanced IFS splitting for the read builtin with proper whitespace/non-whitespace handling.
 *
 * IFS has two types of characters:
 * - Whitespace (space, tab, newline): Multiple consecutive ones are collapsed,
 *   leading/trailing are stripped
 * - Non-whitespace (like 'x', ':'): Create empty fields when consecutive,
 *   trailing ones preserved (except the final delimiter)
 *
 * @param value - String to split
 * @param ifs - IFS characters to split on
 * @param maxSplit - Maximum number of splits (for read with multiple vars, the last gets the rest)
 * @param raw - If true, backslash escaping is disabled (like read -r)
 * @returns Object with words array and wordStarts array
 */
export function splitByIfsForRead(
  value: string,
  ifs: string,
  maxSplit?: number,
  raw?: boolean
): { words: string[]; wordStarts: number[] } {
  // Empty IFS means no splitting
  if (ifs === "") {
    // If value is empty, return empty array (no words)
    // If value is non-empty, return the entire value as a single word
    if (value === "") {
      return { words: [], wordStarts: [] };
    }
    return { words: [value], wordStarts: [0] };
  }

  const { whitespace, nonWhitespace } = categorizeIfs(ifs);
  const words: string[] = [];
  const wordStarts: number[] = [];
  let pos = 0;

  // Skip leading IFS whitespace
  while (pos < value.length && whitespace.has(value[pos])) {
    pos++;
  }

  // If we've consumed all input, return empty result
  if (pos >= value.length) {
    return { words: [], wordStarts: [] };
  }

  // Check for leading non-whitespace delimiter (creates empty field)
  if (nonWhitespace.has(value[pos])) {
    words.push("");
    wordStarts.push(pos);
    pos++;
    // Skip any whitespace after the delimiter
    while (pos < value.length && whitespace.has(value[pos])) {
      pos++;
    }
  }

  // Now process words
  while (pos < value.length) {
    // Check if we've reached maxSplit limit
    if (maxSplit !== undefined && words.length >= maxSplit) {
      break;
    }

    const wordStart = pos;
    wordStarts.push(wordStart);

    // Collect characters until we hit an IFS character
    // In non-raw mode, backslash escapes the next character (protects it from being IFS)
    while (pos < value.length) {
      const ch = value[pos];
      // In non-raw mode, backslash escapes the next character
      if (!raw && ch === "\\") {
        pos++; // skip backslash
        if (pos < value.length) {
          pos++; // skip escaped character (it's part of the word, not IFS)
        }
        continue;
      }
      // Check if current char is IFS
      if (whitespace.has(ch) || nonWhitespace.has(ch)) {
        break;
      }
      pos++;
    }

    words.push(value.substring(wordStart, pos));

    if (pos >= value.length) {
      break;
    }

    // Now handle the delimiter(s)
    // Skip IFS characters (whitespace before non-whitespace)
    while (pos < value.length && whitespace.has(value[pos])) {
      pos++;
    }

    // Check for non-whitespace delimiter
    if (pos < value.length && nonWhitespace.has(value[pos])) {
      pos++;

      // Skip whitespace after non-whitespace delimiter
      while (pos < value.length && whitespace.has(value[pos])) {
        pos++;
      }

      // Check for another non-whitespace delimiter (creates empty field)
      while (pos < value.length && nonWhitespace.has(value[pos])) {
        // Check maxSplit
        if (maxSplit !== undefined && words.length >= maxSplit) {
          break;
        }
        // Empty field for this delimiter
        words.push("");
        wordStarts.push(pos);
        pos++;
        // Skip whitespace after
        while (pos < value.length && whitespace.has(value[pos])) {
          pos++;
        }
      }
    }

    // Note: Trailing non-whitespace delimiter does NOT create an empty field.
    // Empty fields are only created between consecutive non-whitespace delimiters.
    // For example: "a:b:" with IFS=":" produces ['a', 'b'], not ['a', 'b', '']
    // But "a::b" with IFS=":" produces ['a', '', 'b'] (empty field between the two colons)
  }

  return { words, wordStarts };
}

/**
 * IFS splitting for word expansion (unquoted $VAR, $*, etc.).
 *
 * Key differences from splitByIfsForRead:
 * - Trailing non-whitespace delimiter does NOT create an empty field
 * - No maxSplit concept (always splits fully)
 * - No backslash escape handling
 *
 * @param value - String to split
 * @param ifs - IFS characters to split on
 * @returns Array of words after splitting
 */
/**
 * Result of splitByIfsForExpansionEx with leading/trailing delimiter info.
 */
export interface IfsExpansionSplitResult {
  words: string[];
  /** True if the value started with an IFS whitespace delimiter (affects joining with preceding text) */
  hadLeadingDelimiter: boolean;
  /** True if the value ended with an IFS delimiter (affects joining with subsequent text) */
  hadTrailingDelimiter: boolean;
}

/**
 * Extended IFS splitting that tracks trailing delimiters.
 * This is needed for proper word boundary handling when literal text follows an expansion.
 * For example, in `-$x-` where `x='a b c '`, the trailing space means the final `-`
 * should become a separate word, not join with `c`.
 */
export function splitByIfsForExpansionEx(
  value: string,
  ifs: string
): IfsExpansionSplitResult {
  // Empty IFS means no splitting
  if (ifs === "") {
    return {
      words: value ? [value] : [],
      hadLeadingDelimiter: false,
      hadTrailingDelimiter: false
    };
  }

  // Empty value means no words
  if (value === "") {
    return {
      words: [],
      hadLeadingDelimiter: false,
      hadTrailingDelimiter: false
    };
  }

  const { whitespace, nonWhitespace } = categorizeIfs(ifs);
  const words: string[] = [];
  let pos = 0;
  let hadLeadingDelimiter = false;
  let hadTrailingDelimiter = false;

  // Skip leading IFS whitespace
  const leadingStart = pos;
  while (pos < value.length && whitespace.has(value[pos])) {
    pos++;
  }
  // Track if we consumed any leading whitespace
  if (pos > leadingStart) {
    hadLeadingDelimiter = true;
  }

  // If we've consumed all input, return empty result
  if (pos >= value.length) {
    // The value was all whitespace - it had both leading and trailing delimiter
    return { words: [], hadLeadingDelimiter: true, hadTrailingDelimiter: true };
  }

  // Check for leading non-whitespace delimiter (creates empty field)
  if (nonWhitespace.has(value[pos])) {
    words.push("");
    pos++;
    // Skip any whitespace after the delimiter
    while (pos < value.length && whitespace.has(value[pos])) {
      pos++;
    }
  }

  // Now process words
  while (pos < value.length) {
    const wordStart = pos;

    // Collect characters until we hit an IFS character
    while (pos < value.length) {
      const ch = value[pos];
      if (whitespace.has(ch) || nonWhitespace.has(ch)) {
        break;
      }
      pos++;
    }

    words.push(value.substring(wordStart, pos));

    if (pos >= value.length) {
      // Ended on a word, no trailing delimiter
      hadTrailingDelimiter = false;
      break;
    }

    // Now handle the delimiter(s)
    // Skip IFS whitespace
    const beforeDelimiterPos = pos;
    while (pos < value.length && whitespace.has(value[pos])) {
      pos++;
    }

    // Check for non-whitespace delimiter
    if (pos < value.length && nonWhitespace.has(value[pos])) {
      pos++;

      // Skip whitespace after non-whitespace delimiter
      while (pos < value.length && whitespace.has(value[pos])) {
        pos++;
      }

      // Check for more non-whitespace delimiters (creates empty fields)
      while (pos < value.length && nonWhitespace.has(value[pos])) {
        // Empty field for this delimiter
        words.push("");
        pos++;
        // Skip whitespace after
        while (pos < value.length && whitespace.has(value[pos])) {
          pos++;
        }
      }
    }

    // If we've consumed all input, we ended on a delimiter
    if (pos >= value.length && pos > beforeDelimiterPos) {
      hadTrailingDelimiter = true;
    }
  }

  return { words, hadLeadingDelimiter, hadTrailingDelimiter };
}

export function splitByIfsForExpansion(value: string, ifs: string): string[] {
  return splitByIfsForExpansionEx(value, ifs).words;
}

/**
 * Check if string contains any non-whitespace IFS chars.
 */
function containsNonWsIfs(value: string, nonWhitespace: Set<string>): boolean {
  for (const ch of value) {
    if (nonWhitespace.has(ch)) {
      return true;
    }
  }
  return false;
}

/**
 * Strip trailing IFS from the last variable in read builtin.
 *
 * Bash behavior:
 * 1. Strip trailing IFS whitespace characters (but NOT if they're escaped by backslash)
 * 2. If there's a single trailing IFS non-whitespace character, strip it ONLY IF
 *    there are no other non-ws IFS chars in the content (excluding the trailing one)
 *
 * Examples with IFS="x ":
 * - "ax  " -> "a" (trailing spaces stripped, then trailing single x stripped because no other x)
 * - "ax" -> "a" (trailing single x stripped because no other x in remaining content)
 * - "axx" -> "axx" (two trailing x's, so don't strip - there's another x)
 * - "ax  x" -> "ax  x" (trailing x NOT stripped because there's an x earlier)
 * - "bx" -> "b" (trailing x stripped, no other x)
 * - "a\ " -> "a " (backslash-escaped space is NOT stripped)
 *
 * @param value - String to strip (raw, before backslash processing)
 * @param ifs - IFS characters
 * @param raw - If true, backslash escaping is disabled
 */
export function stripTrailingIfsWhitespace(
  value: string,
  ifs: string,
  raw?: boolean
): string {
  if (ifs === "") return value;
  const { whitespace, nonWhitespace } = categorizeIfs(ifs);

  // First strip trailing whitespace IFS, but stop if we hit an escaped character
  let end = value.length;
  while (end > 0) {
    // Check if current trailing char is IFS whitespace
    if (!whitespace.has(value[end - 1])) {
      break;
    }
    // In non-raw mode, check if this char is escaped by a backslash
    // A char at position i is escaped if there's a backslash at position i-1
    // But we need to count consecutive backslashes to handle \\
    if (!raw && end >= 2) {
      // Count how many backslashes precede this character
      let backslashCount = 0;
      let pos = end - 2;
      while (pos >= 0 && value[pos] === "\\") {
        backslashCount++;
        pos--;
      }
      // If odd number of backslashes, the char is escaped - stop stripping
      if (backslashCount % 2 === 1) {
        break;
      }
    }
    end--;
  }
  const result = value.substring(0, end);

  // Check for trailing single IFS non-whitespace char
  if (result.length >= 1 && nonWhitespace.has(result[result.length - 1])) {
    // In non-raw mode, check if this char is escaped
    if (!raw && result.length >= 2) {
      let backslashCount = 0;
      let pos = result.length - 2;
      while (pos >= 0 && result[pos] === "\\") {
        backslashCount++;
        pos--;
      }
      // If odd number of backslashes, the char is escaped - don't strip
      if (backslashCount % 2 === 1) {
        return result;
      }
    }

    // Only strip if there are NO other non-ws IFS chars in the rest of the string
    const contentWithoutTrailing = result.substring(0, result.length - 1);
    if (!containsNonWsIfs(contentWithoutTrailing, nonWhitespace)) {
      return contentWithoutTrailing;
    }
  }

  return result;
}
