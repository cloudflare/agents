/**
 * Regex building utilities for search commands
 */

import { createUserRegex, type UserRegex } from "../../regex/index";

/** POSIX character class to JavaScript regex character range mapping (Map prevents prototype pollution) */
const POSIX_CLASS_MAP = new Map<string, string>([
  ["alpha", "a-zA-Z"],
  ["digit", "0-9"],
  ["alnum", "a-zA-Z0-9"],
  ["lower", "a-z"],
  ["upper", "A-Z"],
  ["xdigit", "0-9A-Fa-f"],
  ["space", " \\t\\n\\r\\f\\v"],
  ["blank", " \\t"],
  ["punct", "!-/:-@\\[-`{-~"],
  ["graph", "!-~"],
  ["print", " -~"],
  ["cntrl", "\\x00-\\x1F\\x7F"],
  ["ascii", "\\x00-\\x7F"],
  ["word", "a-zA-Z0-9_"]
]);

export type RegexMode = "basic" | "extended" | "fixed" | "perl";

export interface RegexOptions {
  mode: RegexMode;
  ignoreCase?: boolean;
  wholeWord?: boolean;
  lineRegexp?: boolean;
  multiline?: boolean;
  /** Makes . match newlines in multiline mode (ripgrep --multiline-dotall) */
  multilineDotall?: boolean;
}

export interface RegexResult {
  regex: UserRegex;
  /** If \K was used, this is the 1-based index of the capture group containing the "real" match */
  kResetGroup?: number;
}

/**
 * Transform POSIX character classes in bracket expressions to JavaScript regex equivalents.
 *
 * Examples:
 * - [[:alpha:]] → [a-zA-Z]
 * - [[:digit:]] → [0-9]
 * - [[:alpha:][:digit:]] → [a-zA-Z0-9]
 * - [^[:alpha:]] → [^a-zA-Z]
 * - [[:<:]] → (?<![\\w]) (word start boundary)
 * - [[:>:]] → (?![\\w]) (word end boundary)
 */
function transformPosixCharacterClasses(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    // Check for word boundary extensions [[:<:]] and [[:>:]]
    // Using \b instead of lookahead/lookbehind for RE2 compatibility
    if (pattern.slice(i, i + 7) === "[[:<:]]") {
      // Word start boundary - use \b (works at word/non-word boundary)
      result += "\\b";
      i += 7;
      continue;
    }
    if (pattern.slice(i, i + 7) === "[[:>:]]") {
      // Word end boundary - use \b (works at word/non-word boundary)
      result += "\\b";
      i += 7;
      continue;
    }

    // Check for start of bracket expression
    if (pattern[i] === "[") {
      // Parse the entire bracket expression
      let bracketExpr = "[";
      i++;

      // Handle negation
      if (i < pattern.length && (pattern[i] === "^" || pattern[i] === "!")) {
        bracketExpr += "^";
        i++;
      }

      // Handle ] as first char (literal ])
      if (i < pattern.length && pattern[i] === "]") {
        bracketExpr += "\\]";
        i++;
      }

      // Parse bracket expression contents
      while (i < pattern.length && pattern[i] !== "]") {
        // Check for POSIX character class [[:name:]]
        if (
          pattern[i] === "[" &&
          i + 1 < pattern.length &&
          pattern[i + 1] === ":"
        ) {
          // Find the closing :]
          const closeIdx = pattern.indexOf(":]", i + 2);
          if (closeIdx !== -1) {
            const className = pattern.slice(i + 2, closeIdx);
            const replacement = POSIX_CLASS_MAP.get(className);
            if (replacement) {
              bracketExpr += replacement;
              i = closeIdx + 2;
              continue;
            }
          }
        }

        // Handle escape sequences
        if (pattern[i] === "\\" && i + 1 < pattern.length) {
          bracketExpr += pattern[i] + pattern[i + 1];
          i += 2;
          continue;
        }

        // Regular character
        bracketExpr += pattern[i];
        i++;
      }

      // Close the bracket expression
      if (i < pattern.length && pattern[i] === "]") {
        bracketExpr += "]";
        i++;
      }

      result += bracketExpr;
      continue;
    }

    // Handle escape sequences outside bracket expressions
    if (pattern[i] === "\\" && i + 1 < pattern.length) {
      result += pattern[i] + pattern[i + 1];
      i += 2;
      continue;
    }

    // Regular character
    result += pattern[i];
    i++;
  }

  return result;
}

/**
 * Build a JavaScript RegExp from a pattern with the specified mode
 */
export function buildRegex(
  pattern: string,
  options: RegexOptions
): RegexResult {
  let regexPattern: string;
  let kResetGroup: number | undefined;

  switch (options.mode) {
    case "fixed":
      // Escape all regex special characters for literal match
      regexPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      break;
    case "extended":
    case "perl": {
      // Transform POSIX character classes first
      regexPattern = transformPosixCharacterClasses(pattern);

      // Convert (?P<name>...) to JavaScript's (?<name>...) syntax
      regexPattern = regexPattern.replace(/\(\?P<([^>]+)>/g, "(?<$1>");

      // Handle Perl-specific features only in perl mode
      if (options.mode === "perl") {
        // Handle \Q...\E (quote metacharacters)
        regexPattern = handleQuoteMetachars(regexPattern);

        // Handle \x{NNNN} Unicode code points -> \u{NNNN}
        regexPattern = handleUnicodeCodePoints(regexPattern);

        // Handle inline modifiers (?i:...), (?i), etc.
        regexPattern = handleInlineModifiers(regexPattern);

        // Handle \K (Perl regex reset match start)
        const kResult = handlePerlKReset(regexPattern);
        regexPattern = kResult.pattern;
        kResetGroup = kResult.kResetGroup;
      }
      break;
    }
    default:
      // BRE mode: transform POSIX classes first, then convert BRE to JS regex
      regexPattern = transformPosixCharacterClasses(pattern);
      regexPattern = escapeRegexForBasicGrep(regexPattern);
      break;
  }

  if (options.wholeWord) {
    // Wrap in non-capturing group to handle alternation properly
    // e.g., min|max should become \b(?:min|max)\b, not \bmin|max\b
    // Using \b for RE2 compatibility (RE2 doesn't support lookahead/lookbehind)
    regexPattern = `\\b(?:${regexPattern})\\b`;
  }
  if (options.lineRegexp) {
    regexPattern = `^${regexPattern}$`;
  }

  // Build flags:
  // - g: global matching
  // - i: case insensitive
  // - m: multiline (^ and $ match at line boundaries)
  // - s: dotall (. matches newlines)
  // - u: unicode (needed for \u{NNNN} syntax)
  const needsUnicode = /\\u\{[0-9A-Fa-f]+\}/.test(regexPattern);
  const flags =
    "g" +
    (options.ignoreCase ? "i" : "") +
    (options.multiline ? "m" : "") +
    (options.multilineDotall ? "s" : "") +
    (needsUnicode ? "u" : "");
  return { regex: createUserRegex(regexPattern, flags), kResetGroup };
}

/**
 * Handle \Q...\E (quote metacharacters).
 * Everything between \Q and \E is treated as literal text.
 * If \E is missing, quotes until end of pattern.
 */
function handleQuoteMetachars(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    // Check for \Q
    if (
      pattern[i] === "\\" &&
      i + 1 < pattern.length &&
      pattern[i + 1] === "Q"
    ) {
      // Skip \Q
      i += 2;

      // Find matching \E or end of string
      let quoted = "";
      while (i < pattern.length) {
        if (
          pattern[i] === "\\" &&
          i + 1 < pattern.length &&
          pattern[i + 1] === "E"
        ) {
          // Found \E, skip it
          i += 2;
          break;
        }
        quoted += pattern[i];
        i++;
      }

      // Escape all regex metacharacters in the quoted section
      result += quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else {
      result += pattern[i];
      i++;
    }
  }

  return result;
}

/**
 * Handle \x{NNNN} Unicode code points.
 * Converts Perl's \x{NNNN} to JavaScript's \u{NNNN}.
 */
function handleUnicodeCodePoints(pattern: string): string {
  // Convert \x{NNNN} to \u{NNNN}
  // The pattern matches \x{ followed by hex digits and }
  return pattern.replace(/\\x\{([0-9A-Fa-f]+)\}/g, "\\u{$1}");
}

/**
 * Handle inline modifiers like (?i:...), (?i), (?-i), etc.
 *
 * Supported modifiers:
 * - i: case insensitive
 * - m: multiline (^ and $ match at line boundaries) - already default in our impl
 * - s: single-line mode (. matches newlines)
 * - x: extended mode (ignore whitespace) - not fully supported
 *
 * Forms:
 * - (?i) - Turn on modifier for rest of pattern (simplified: applies to whole pattern)
 * - (?-i) - Turn off modifier (simplified: removes from rest)
 * - (?i:pattern) - Apply modifier only to this group
 */
function handleInlineModifiers(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    // Look for (?
    if (
      pattern[i] === "(" &&
      i + 1 < pattern.length &&
      pattern[i + 1] === "?"
    ) {
      // Check if this is a modifier group
      const modifierMatch = pattern
        .slice(i)
        .match(/^\(\?([imsx]*)(-[imsx]*)?(:|$|\))/);

      if (modifierMatch) {
        const enableMods = modifierMatch[1] || "";
        const disableMods = modifierMatch[2] || "";
        const delimiter = modifierMatch[3];

        if (delimiter === ":") {
          // (?i:pattern) form - apply modifiers to group content
          const groupStart = i + modifierMatch[0].length - 1; // position of :
          const groupEnd = findMatchingParen(pattern, i);

          if (groupEnd !== -1) {
            const groupContent = pattern.slice(groupStart + 1, groupEnd);
            const transformed = applyInlineModifiers(
              groupContent,
              enableMods,
              disableMods
            );
            result += `(?:${transformed})`;
            i = groupEnd + 1;
            continue;
          }
        } else if (delimiter === ")" || delimiter === "") {
          // (?i) form - modifier only, no content
          // For simplicity, we just remove these as they're hard to emulate precisely
          // The caller should use -i flag for case insensitivity
          i += modifierMatch[0].length;
          continue;
        }
      }
    }

    result += pattern[i];
    i++;
  }

  return result;
}

/**
 * Find the matching closing parenthesis for an opening one at position start.
 */
function findMatchingParen(pattern: string, start: number): number {
  let depth = 0;
  let i = start;

  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      // Skip escaped character
      i += 2;
      continue;
    }

    if (pattern[i] === "[") {
      // Skip character class
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }

    if (pattern[i] === "(") {
      depth++;
    } else if (pattern[i] === ")") {
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
 * Apply inline modifiers to a pattern segment.
 * For (?i:pattern), we convert letters to character classes [Aa].
 */
function applyInlineModifiers(
  pattern: string,
  enableMods: string,
  _disableMods: string
): string {
  let result = pattern;

  // Handle case-insensitive modifier
  if (enableMods.includes("i")) {
    result = makeCaseInsensitive(result);
  }

  // Note: 's' modifier (dotall) would need special handling
  // For now, we rely on the global flag if needed

  return result;
}

/**
 * Convert a pattern to be case-insensitive by replacing letters with character classes.
 * e.g., "abc" -> "[Aa][Bb][Cc]"
 * Character classes like [cd] become [cdCD]
 */
function makeCaseInsensitive(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "\\") {
      // Keep escape sequences as-is
      if (i + 1 < pattern.length) {
        result += char + pattern[i + 1];
        i += 2;
      } else {
        result += char;
        i++;
      }
      continue;
    }

    if (char === "[") {
      // Make character class case-insensitive
      result += char;
      i++;

      // Check for negation
      if (i < pattern.length && pattern[i] === "^") {
        result += pattern[i];
        i++;
      }

      // Collect all characters and make them case-insensitive
      const classChars: string[] = [];
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") {
          // Keep escape sequences as-is
          classChars.push(pattern[i]);
          i++;
          if (i < pattern.length) {
            classChars.push(pattern[i]);
            i++;
          }
        } else if (
          pattern[i] === "-" &&
          classChars.length > 0 &&
          i + 1 < pattern.length &&
          pattern[i + 1] !== "]"
        ) {
          // Range like a-z - keep as-is but also add uppercase range
          const rangeStart = classChars[classChars.length - 1];
          const rangeEnd = pattern[i + 1];
          classChars.push("-");
          classChars.push(rangeEnd);

          // Add uppercase equivalents if both are letters
          if (/[a-z]/.test(rangeStart) && /[a-z]/.test(rangeEnd)) {
            classChars.push(rangeStart.toUpperCase());
            classChars.push("-");
            classChars.push(rangeEnd.toUpperCase());
          } else if (/[A-Z]/.test(rangeStart) && /[A-Z]/.test(rangeEnd)) {
            classChars.push(rangeStart.toLowerCase());
            classChars.push("-");
            classChars.push(rangeEnd.toLowerCase());
          }
          i += 2;
        } else {
          const c = pattern[i];
          classChars.push(c);
          // Add case variant for letters
          if (/[a-zA-Z]/.test(c)) {
            const variant =
              c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
            if (!classChars.includes(variant)) {
              classChars.push(variant);
            }
          }
          i++;
        }
      }

      result += classChars.join("");
      if (i < pattern.length) {
        result += pattern[i]; // ]
        i++;
      }
      continue;
    }

    // Convert letters to case-insensitive character class
    if (/[a-zA-Z]/.test(char)) {
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      result += `[${upper}${lower}]`;
    } else {
      result += char;
    }
    i++;
  }

  return result;
}

/**
 * Handle Perl's \K (keep/reset match start) operator.
 * \K causes everything matched before it to be excluded from the final match result.
 *
 * We emulate this by:
 * 1. Wrapping the part before \K in a non-capturing group
 * 2. Wrapping the part after \K in a capturing group
 * 3. Returning the index of that capturing group so the matcher can use it
 */
function handlePerlKReset(pattern: string): {
  pattern: string;
  kResetGroup?: number;
} {
  // Find \K that's not escaped (not preceded by odd number of backslashes)
  // We need to find \K that represents the reset operator, not a literal \\K
  const kIndex = findUnescapedK(pattern);

  if (kIndex === -1) {
    return { pattern };
  }

  const before = pattern.slice(0, kIndex);
  const after = pattern.slice(kIndex + 2); // Skip \K

  // Count existing capturing groups before the split to determine our group number
  const groupsBefore = countCapturingGroups(before);

  // Wrap: (?:before)(after) - non-capturing for prefix, capturing for the part we want
  const newPattern = `(?:${before})(${after})`;

  return {
    pattern: newPattern,
    // The capturing group for "after" will be groupsBefore + 1
    kResetGroup: groupsBefore + 1
  };
}

/**
 * Find the index of \K in a pattern, ignoring escaped backslashes
 */
function findUnescapedK(pattern: string): number {
  let i = 0;
  while (i < pattern.length - 1) {
    if (pattern[i] === "\\") {
      if (pattern[i + 1] === "K") {
        // Check if the backslash itself is escaped by counting preceding backslashes
        let backslashCount = 0;
        let j = i - 1;
        while (j >= 0 && pattern[j] === "\\") {
          backslashCount++;
          j--;
        }
        // If even number of preceding backslashes, this \K is not escaped
        if (backslashCount % 2 === 0) {
          return i;
        }
      }
      // Skip the escaped character
      i += 2;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Count the number of capturing groups in a regex pattern.
 * Excludes non-capturing groups (?:...), lookahead (?=...), (?!...),
 * lookbehind (?<=...), (?<!...), and named groups (?<name>...) which we count.
 */
function countCapturingGroups(pattern: string): number {
  let count = 0;
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === "\\") {
      // Skip escaped character
      i += 2;
      continue;
    }

    if (pattern[i] === "[") {
      // Skip character class
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      i++; // Skip ]
      continue;
    }

    if (pattern[i] === "(") {
      if (i + 1 < pattern.length && pattern[i + 1] === "?") {
        // Check what kind of group
        if (i + 2 < pattern.length) {
          const nextChar = pattern[i + 2];
          if (nextChar === ":" || nextChar === "=" || nextChar === "!") {
            // Non-capturing or lookahead - don't count
            i++;
            continue;
          }
          if (nextChar === "<") {
            // Could be lookbehind (?<= or (?<! or named group (?<name>
            if (i + 3 < pattern.length) {
              const afterLt = pattern[i + 3];
              if (afterLt === "=" || afterLt === "!") {
                // Lookbehind - don't count
                i++;
                continue;
              }
              // Named group - count it
              count++;
              i++;
              continue;
            }
          }
        }
      } else {
        // Regular capturing group
        count++;
      }
    }
    i++;
  }

  return count;
}

/**
 * Convert replacement string syntax to JavaScript's String.replace format
 *
 * Conversions:
 * - $0 and ${0} -> $& (full match)
 * - $name -> $<name> (named capture groups)
 * - ${name} -> $<name> (braced named capture groups)
 * - Preserves $1, $2, etc. for numbered groups
 */
export function convertReplacement(replacement: string): string {
  // First, convert $0 and ${0} to $& (use $$& to produce literal $& in output)
  let result = replacement.replace(/\$\{0\}|\$0(?![0-9])/g, "$$&");

  // Convert ${name} to $<name> for non-numeric names
  result = result.replace(/\$\{([^0-9}][^}]*)\}/g, "$$<$1>");

  // Convert $name to $<name> for non-numeric names (not followed by > which would already be converted)
  // Match $name where name starts with letter or underscore and contains word chars
  result = result.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)(?![>0-9])/g, "$$<$1>");

  return result;
}

/**
 * Convert Basic Regular Expression (BRE) to JavaScript regex
 *
 * In BRE:
 * - \| is alternation (becomes | in JS)
 * - \( \) are groups (become ( ) in JS)
 * - \{n\}, \{n,\}, \{n,m\} are interval expressions (become {n}, {n,}, {n,m} in JS)
 * - \{,n\} and \{,\} are literal (invalid POSIX interval)
 * - + ? | ( ) { } are literal (must be escaped in JS)
 * - * at pattern start or after ^ is literal
 * - ^ is anchor at start of pattern or start of \(...\) group; literal elsewhere
 * - $ is anchor at end of pattern or end of \(...\) group; literal elsewhere
 */
function escapeRegexForBasicGrep(str: string): string {
  let result = "";
  let i = 0;
  // Track if we're at a position where * would be literal
  // (at start of pattern/group, or right after ^ anchor)
  let atPatternStart = true;
  // Track nesting depth for \( \) groups
  let groupDepth = 0;

  while (i < str.length) {
    const char = str[i];

    // Handle bracket expressions - copy them through without modification
    // Bracket expressions have already been processed by transformPosixCharacterClasses
    if (char === "[") {
      result += char;
      i++;
      // Handle negation or first ] in bracket expression
      if (i < str.length && (str[i] === "^" || str[i] === "!")) {
        result += str[i];
        i++;
      }
      // Handle ] as first char (literal ])
      if (i < str.length && str[i] === "]") {
        result += str[i];
        i++;
      }
      // Copy everything until closing ]
      while (i < str.length && str[i] !== "]") {
        if (str[i] === "\\" && i + 1 < str.length) {
          result += str[i] + str[i + 1];
          i += 2;
        } else {
          result += str[i];
          i++;
        }
      }
      // Copy closing ]
      if (i < str.length && str[i] === "]") {
        result += str[i];
        i++;
      }
      atPatternStart = false;
      continue;
    }

    if (char === "\\" && i + 1 < str.length) {
      const nextChar = str[i + 1];
      // BRE: \| becomes | (alternation)
      if (nextChar === "|") {
        result += "|";
        i += 2;
        atPatternStart = true; // After alternation, ^ and * rules apply at start of alternative
        continue;
      }
      // BRE: \( starts a group
      if (nextChar === "(") {
        result += "(";
        i += 2;
        groupDepth++;
        atPatternStart = true; // ^ and * rules apply at group start
        continue;
      }
      // BRE: \) ends a group
      if (nextChar === ")") {
        result += ")";
        i += 2;
        groupDepth = Math.max(0, groupDepth - 1);
        atPatternStart = false;
        continue;
      }
      if (nextChar === "{") {
        // Check for BRE interval expression: \{n\}, \{n,\}, \{n,m\}
        // Valid intervals start with a digit (not comma)
        const remaining = str.slice(i);
        const intervalMatch = remaining.match(/^\\{(\d+)(,(\d*)?)?\\}/);
        if (intervalMatch) {
          const min = intervalMatch[1];
          const hasComma = intervalMatch[2] !== undefined;
          const max = intervalMatch[3] || "";
          // Convert to JavaScript interval syntax
          if (hasComma) {
            result += `{${min},${max}}`;
          } else {
            result += `{${min}}`;
          }
          i += intervalMatch[0].length;
          atPatternStart = false;
          continue;
        }
        // Not a valid interval - treat \{ as literal {
        result += `\\{`;
        i += 2;
        atPatternStart = false;
        continue;
      }
      if (nextChar === "}") {
        // \} outside of interval - literal }
        result += `\\}`;
        i += 2;
        atPatternStart = false;
        continue;
      }
      // Any other escape - pass through
      result += char + nextChar;
      i += 2;
      atPatternStart = false;
      continue;
    }

    // Handle * - literal at pattern/group start or after ^
    if (char === "*" && atPatternStart) {
      result += "\\*";
      i++;
      // Stay at pattern start so consecutive *'s are also escaped
      continue;
    }

    // Handle ^ - anchor at pattern/group start, literal elsewhere
    if (char === "^") {
      if (atPatternStart) {
        result += "^";
        i++;
        // After ^, we're still at a position where * would be literal
        continue;
      }
      // ^ in middle - literal
      result += "\\^";
      i++;
      continue;
    }

    // Handle $ - anchor at pattern end or before \), literal elsewhere
    if (char === "$") {
      // Check if this is at end of pattern or followed by \)
      const isAtEnd = i === str.length - 1;
      const isBeforeGroupEnd =
        i + 2 < str.length && str[i + 1] === "\\" && str[i + 2] === ")";
      if (isAtEnd || isBeforeGroupEnd) {
        result += "$";
      } else {
        result += "\\$";
      }
      i++;
      atPatternStart = false;
      continue;
    }

    // Escape characters that are special in JavaScript regex but not in BRE
    if (
      char === "+" ||
      char === "?" ||
      char === "|" ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === "}"
    ) {
      result += `\\${char}`;
    } else {
      result += char;
    }
    i++;
    atPatternStart = false;
  }

  return result;
}
