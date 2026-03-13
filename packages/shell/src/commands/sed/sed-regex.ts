/**
 * Regex conversion utilities for sed command
 */

/** POSIX character class to JavaScript regex mapping (Map prevents prototype pollution) */
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
  ["xdigit", "0-9A-Fa-f"]
]);

/**
 * Convert Basic Regular Expression (BRE) to Extended Regular Expression (ERE).
 * In BRE: +, ?, |, (, ) are literal; \+, \?, \|, \(, \) are special
 * In ERE: +, ?, |, (, ) are special; \+, \?, \|, \(, \) are literal
 * Also converts POSIX character classes to JavaScript equivalents.
 */
export function breToEre(pattern: string): string {
  // This conversion handles the main differences between BRE and ERE:
  // 1. Unescape BRE special chars (\+, \?, \|, \(, \)) to make them special in ERE
  // 2. Escape ERE special chars (+, ?, |, (, )) that are literal in BRE
  // 3. Properly handle bracket expressions [...]

  let result = "";
  let i = 0;
  let inBracket = false;

  while (i < pattern.length) {
    // Handle bracket expressions - copy contents mostly verbatim
    if (pattern[i] === "[" && !inBracket) {
      // Check for standalone POSIX character classes like [[:space:]]
      if (pattern[i + 1] === "[" && pattern[i + 2] === ":") {
        const closeIdx = pattern.indexOf(":]]", i + 3);
        if (closeIdx !== -1) {
          const className = pattern.slice(i + 3, closeIdx);
          const jsClass = POSIX_CLASSES.get(className);
          if (jsClass) {
            result += `[${jsClass}]`;
            i = closeIdx + 3;
            continue;
          }
        }
      }

      // Check for negated standalone POSIX classes [^[:space:]]
      if (
        pattern[i + 1] === "^" &&
        pattern[i + 2] === "[" &&
        pattern[i + 3] === ":"
      ) {
        const closeIdx = pattern.indexOf(":]]", i + 4);
        if (closeIdx !== -1) {
          const className = pattern.slice(i + 4, closeIdx);
          const jsClass = POSIX_CLASSES.get(className);
          if (jsClass) {
            result += `[^${jsClass}]`;
            i = closeIdx + 3;
            continue;
          }
        }
      }

      // Start of bracket expression
      result += "[";
      i++;
      inBracket = true;

      // Handle negation at start
      if (i < pattern.length && pattern[i] === "^") {
        result += "^";
        i++;
      }

      // Handle ] at start (it's literal in POSIX, needs escaping for JS)
      if (i < pattern.length && pattern[i] === "]") {
        result += "\\]";
        i++;
      }
      continue;
    }

    // Inside bracket expression - copy verbatim until closing ]
    if (inBracket) {
      if (pattern[i] === "]") {
        result += "]";
        i++;
        inBracket = false;
        continue;
      }

      // Handle POSIX classes inside bracket expressions like [a[:space:]b]
      if (pattern[i] === "[" && pattern[i + 1] === ":") {
        const closeIdx = pattern.indexOf(":]", i + 2);
        if (closeIdx !== -1) {
          const className = pattern.slice(i + 2, closeIdx);
          const jsClass = POSIX_CLASSES.get(className);
          if (jsClass) {
            result += jsClass;
            i = closeIdx + 2;
            continue;
          }
        }
      }

      // Handle backslash escapes inside brackets
      if (pattern[i] === "\\" && i + 1 < pattern.length) {
        result += pattern[i] + pattern[i + 1];
        i += 2;
        continue;
      }

      result += pattern[i];
      i++;
      continue;
    }

    // Outside bracket expressions - handle BRE to ERE conversion
    if (pattern[i] === "\\") {
      if (i + 1 < pattern.length) {
        const next = pattern[i + 1];
        // BRE escaped chars that become special in ERE
        if (next === "+" || next === "?" || next === "|") {
          result += next; // Remove backslash to make it special
          i += 2;
          continue;
        }
        if (next === "(" || next === ")") {
          result += next; // Remove backslash for grouping
          i += 2;
          continue;
        }
        if (next === "{" || next === "}") {
          result += next; // Remove backslash for quantifiers
          i += 2;
          continue;
        }
        // Convert escape sequences to actual characters (GNU extension)
        if (next === "t") {
          result += "\t";
          i += 2;
          continue;
        }
        if (next === "n") {
          result += "\n";
          i += 2;
          continue;
        }
        if (next === "r") {
          result += "\r";
          i += 2;
          continue;
        }
        // Keep other escaped chars as-is
        result += pattern[i] + next;
        i += 2;
        continue;
      }
    }

    // ERE special chars that should be literal in BRE (without backslash)
    if (
      pattern[i] === "+" ||
      pattern[i] === "?" ||
      pattern[i] === "|" ||
      pattern[i] === "(" ||
      pattern[i] === ")"
    ) {
      result += `\\${pattern[i]}`; // Add backslash to make it literal
      i++;
      continue;
    }

    // Handle ^ anchor: In BRE, ^ is only an anchor at the start of the pattern
    // or immediately after \( (which becomes ( in ERE). When ^ appears
    // elsewhere, it should be treated as a literal character.
    if (pattern[i] === "^") {
      // Check if we're at the start of result OR after an opening group paren
      const isAnchor = result === "" || result.endsWith("(");
      if (!isAnchor) {
        result += "\\^"; // Escape to make it literal in ERE
        i++;
        continue;
      }
    }

    // Handle $ anchor: In BRE, $ is only an anchor at the end of the pattern
    // or immediately before \) (which becomes ) in ERE). When $ appears
    // elsewhere, it should be treated as a literal character.
    if (pattern[i] === "$") {
      // Check if we're at the end of pattern OR before a closing group
      const isEnd = i === pattern.length - 1;
      // Check if next char is \) in original BRE pattern
      const beforeGroupClose =
        i + 2 < pattern.length &&
        pattern[i + 1] === "\\" &&
        pattern[i + 2] === ")";
      if (!isEnd && !beforeGroupClose) {
        result += "\\$"; // Escape to make it literal in ERE
        i++;
        continue;
      }
    }

    result += pattern[i];
    i++;
  }

  return result;
}

/**
 * Normalize regex patterns for JavaScript RegExp.
 * Converts GNU sed extensions to JavaScript-compatible syntax.
 *
 * Handles:
 * - {,n} → {0,n} (GNU extension: "0 to n times")
 */
export function normalizeForJs(pattern: string): string {
  // Convert {,n} to {0,n} - handles quantifiers like {,2} meaning "0 to 2 times"
  // Be careful not to match inside bracket expressions
  let result = "";
  let inBracket = false;

  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "[" && !inBracket) {
      inBracket = true;
      result += "[";
      i++;
      // Handle negation and ] at start
      if (i < pattern.length && pattern[i] === "^") {
        result += "^";
        i++;
      }
      if (i < pattern.length && pattern[i] === "]") {
        result += "]";
        i++;
      }
      i--; // Will be incremented by loop
    } else if (pattern[i] === "]" && inBracket) {
      inBracket = false;
      result += "]";
    } else if (!inBracket && pattern[i] === "{" && pattern[i + 1] === ",") {
      // Found {,n} pattern - convert to {0,n}
      result += "{0,";
      i++; // Skip the comma
    } else {
      result += pattern[i];
    }
  }

  return result;
}

/**
 * Escape pattern space for the `l` (list) command.
 * Shows non-printable characters as escape sequences and ends with $.
 */
export function escapeForList(input: string): string {
  let result = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const code = ch.charCodeAt(0);

    if (ch === "\\") {
      result += "\\\\";
    } else if (ch === "\t") {
      result += "\\t";
    } else if (ch === "\n") {
      result += "$\n";
    } else if (ch === "\r") {
      result += "\\r";
    } else if (ch === "\x07") {
      result += "\\a";
    } else if (ch === "\b") {
      result += "\\b";
    } else if (ch === "\f") {
      result += "\\f";
    } else if (ch === "\v") {
      result += "\\v";
    } else if (code < 32 || code >= 127) {
      // Non-printable: show as octal
      result += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      result += ch;
    }
  }
  return `${result}$`;
}
