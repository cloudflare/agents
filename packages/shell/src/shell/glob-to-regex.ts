/**
 * Glob Helper Functions
 *
 * Pure helper functions for glob pattern parsing and regex conversion.
 */

import { createUserRegex, type RegexLike } from "../regex/index";

/** POSIX character class name to regex equivalent mapping (Map prevents prototype pollution) */
const POSIX_CLASSES = new Map<string, string>([
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
  ["xdigit", "0-9a-fA-F"]
]);

/**
 * Convert POSIX character class name to regex equivalent.
 */
export function posixClassToRegex(className: string): string {
  return POSIX_CLASSES.get(className) ?? "";
}

/**
 * Split GLOBIGNORE value on colons, but preserve colons inside POSIX character classes.
 * For example: "[[:alnum:]]*:*.txt" should split to ["[[:alnum:]]*", "*.txt"]
 * not ["[[:alnum", "]]*", "*.txt"]
 */
export function splitGlobignorePatterns(globignore: string): string[] {
  const patterns: string[] = [];
  let current = "";
  let i = 0;

  while (i < globignore.length) {
    const c = globignore[i];

    if (c === "[") {
      // Start of character class - find the matching ]
      // Need to handle POSIX classes like [[:alnum:]] inside
      current += c;
      i++;

      // Handle negation [! or [^
      if (
        i < globignore.length &&
        (globignore[i] === "!" || globignore[i] === "^")
      ) {
        current += globignore[i];
        i++;
      }

      // Handle ] as first char (literal ])
      if (i < globignore.length && globignore[i] === "]") {
        current += globignore[i];
        i++;
      }

      // Read until closing ]
      while (i < globignore.length && globignore[i] !== "]") {
        // Check for POSIX class [: ... :]
        if (
          globignore[i] === "[" &&
          i + 1 < globignore.length &&
          globignore[i + 1] === ":"
        ) {
          // Find the closing :]
          const posixEnd = globignore.indexOf(":]", i + 2);
          if (posixEnd !== -1) {
            // Include the entire POSIX class including [:...:]
            current += globignore.slice(i, posixEnd + 2);
            i = posixEnd + 2;
            continue;
          }
        }

        // Handle escaped characters
        if (globignore[i] === "\\" && i + 1 < globignore.length) {
          current += globignore[i] + globignore[i + 1];
          i += 2;
          continue;
        }

        current += globignore[i];
        i++;
      }

      // Include the closing ]
      if (i < globignore.length && globignore[i] === "]") {
        current += globignore[i];
        i++;
      }
    } else if (c === ":") {
      // Colon outside of character class - this is a pattern separator
      if (current !== "") {
        patterns.push(current);
      }
      current = "";
      i++;
    } else if (c === "\\" && i + 1 < globignore.length) {
      // Escaped character
      current += c + globignore[i + 1];
      i += 2;
    } else {
      current += c;
      i++;
    }
  }

  // Don't forget the last pattern
  if (current !== "") {
    patterns.push(current);
  }

  return patterns;
}

/**
 * Convert a GLOBIGNORE pattern to a RegExp.
 * Unlike regular glob patterns, * does NOT match /.
 */
export function globignorePatternToRegex(pattern: string): RegexLike {
  let regex = "^";

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if (c === "*") {
      // In GLOBIGNORE, * does NOT match /
      regex += "[^/]*";
    } else if (c === "?") {
      // ? matches any single character except /
      regex += "[^/]";
    } else if (c === "[") {
      // Character class - find the closing bracket
      let j = i + 1;
      let classContent = "[";

      // Handle negation
      if (j < pattern.length && (pattern[j] === "^" || pattern[j] === "!")) {
        classContent += "^";
        j++;
      }

      // Handle ] as first character (literal])
      if (j < pattern.length && pattern[j] === "]") {
        classContent += "\\]";
        j++;
      }

      // Find the end of the character class first (to check if dash is at end)
      let classEnd = j;
      while (classEnd < pattern.length) {
        if (pattern[classEnd] === "\\" && classEnd + 1 < pattern.length) {
          classEnd += 2;
          continue;
        }
        if (
          pattern[classEnd] === "[" &&
          classEnd + 1 < pattern.length &&
          pattern[classEnd + 1] === ":"
        ) {
          const posixEnd = pattern.indexOf(":]", classEnd + 2);
          if (posixEnd !== -1) {
            classEnd = posixEnd + 2;
            continue;
          }
        }
        if (pattern[classEnd] === "]") {
          break;
        }
        classEnd++;
      }

      // Track position in class content (for determining if dash is at start/end)
      const classStartPos = j;

      // Parse until closing ]
      while (j < pattern.length && pattern[j] !== "]") {
        // Check for POSIX character class [[:name:]]
        if (
          pattern[j] === "[" &&
          j + 1 < pattern.length &&
          pattern[j + 1] === ":"
        ) {
          const posixEnd = pattern.indexOf(":]", j + 2);
          if (posixEnd !== -1) {
            const posixClass = pattern.slice(j + 2, posixEnd);
            const regexClass = posixClassToRegex(posixClass);
            classContent += regexClass;
            j = posixEnd + 2;
            continue;
          }
        }

        // Handle escaped characters in character class
        if (pattern[j] === "\\" && j + 1 < pattern.length) {
          classContent += `\\${pattern[j + 1]}`;
          j += 2;
          continue;
        }

        // Handle - : only escape if at start or end (literal), otherwise keep as range
        if (pattern[j] === "-") {
          const atStart = j === classStartPos;
          const atEnd = j + 1 === classEnd;
          if (atStart || atEnd) {
            // Dash at start or end is literal
            classContent += "\\-";
          } else {
            // Dash in middle is a range operator
            classContent += "-";
          }
        } else {
          classContent += pattern[j];
        }
        j++;
      }

      classContent += "]";
      regex += classContent;
      i = j;
    } else if (c === "\\" && i + 1 < pattern.length) {
      // Escaped character - treat next char as literal
      const nextChar = pattern[i + 1];
      if (/[.+^${}()|\\*?[\]]/.test(nextChar)) {
        regex += `\\${nextChar}`;
      } else {
        regex += nextChar;
      }
      i++;
    } else if (/[.+^${}()|]/.test(c)) {
      // Escape regex special characters
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }

  regex += "$";
  return createUserRegex(regex);
}

/**
 * Find the matching closing parenthesis, handling nesting
 */
export function findMatchingParen(pattern: string, openIdx: number): number {
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
 * Split extglob pattern content on | handling nested patterns and quotes.
 * Single-quoted content is preserved with a special marker for later processing.
 */
export function splitExtglobAlternatives(content: string): string[] {
  const alternatives: string[] = [];
  let current = "";
  let depth = 0;
  let inSingleQuote = false;
  let i = 0;

  while (i < content.length) {
    const c = content[i];

    // Handle single quotes - toggle quote mode
    if (c === "'" && !inSingleQuote) {
      inSingleQuote = true;
      // Mark start of quoted section with special marker
      current += "\x00QUOTE_START\x00";
      i++;
      continue;
    }
    if (c === "'" && inSingleQuote) {
      inSingleQuote = false;
      // Mark end of quoted section
      current += "\x00QUOTE_END\x00";
      i++;
      continue;
    }

    // Inside single quotes, everything is literal
    if (inSingleQuote) {
      current += c;
      i++;
      continue;
    }

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
