/**
 * Shared glob pattern matching utilities.
 *
 * Used by grep, find, and other commands that need glob matching.
 */

import { createUserRegex, type RegexLike } from "../regex/index";

// Cache compiled regexes for glob patterns (key: pattern + flags).
// Bounded to prevent unbounded memory growth from diverse patterns.
const GLOB_CACHE_MAX = 2048;
const globRegexCache = new Map<string, RegexLike>();

export interface MatchGlobOptions {
  /** Case-insensitive matching */
  ignoreCase?: boolean;
  /** Strip surrounding quotes from pattern before matching */
  stripQuotes?: boolean;
}

/**
 * Match a filename against a glob pattern.
 *
 * Supports:
 * - `*` matches any sequence of characters
 * - `?` matches any single character
 * - `[...]` character classes
 *
 * @param name - The filename to test
 * @param pattern - The glob pattern
 * @param options - Matching options
 * @returns true if the name matches the pattern
 */
export function matchGlob(
  name: string,
  pattern: string,
  options?: MatchGlobOptions | boolean
): boolean {
  // Support legacy signature: matchGlob(name, pattern, ignoreCase)
  // @banned-pattern-ignore: options object with known structure (ignoreCase, stripQuotes, etc.)
  const opts: MatchGlobOptions =
    typeof options === "boolean" ? { ignoreCase: options } : (options ?? {});

  let cleanPattern = pattern;

  // Strip surrounding quotes if requested
  if (opts.stripQuotes) {
    if (
      (cleanPattern.startsWith('"') && cleanPattern.endsWith('"')) ||
      (cleanPattern.startsWith("'") && cleanPattern.endsWith("'"))
    ) {
      cleanPattern = cleanPattern.slice(1, -1);
    }
  }

  // Build cache key
  const cacheKey = opts.ignoreCase ? `i:${cleanPattern}` : cleanPattern;
  let re = globRegexCache.get(cacheKey);

  if (!re) {
    re = globToRegex(cleanPattern, opts.ignoreCase);
    if (globRegexCache.size >= GLOB_CACHE_MAX) {
      // Evict oldest entry (first key in insertion order)
      const oldest = globRegexCache.keys().next().value;
      if (oldest !== undefined) globRegexCache.delete(oldest);
    }
    globRegexCache.set(cacheKey, re);
  }

  return re.test(name);
}

/**
 * Convert a glob pattern to a RegExp.
 */
function globToRegex(pattern: string, ignoreCase?: boolean): RegexLike {
  let regex = "^";

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      regex += ".*";
    } else if (c === "?") {
      regex += ".";
    } else if (c === "[") {
      // Character class - find closing bracket
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "]") j++;
      regex += pattern.slice(i, j + 1);
      i = j;
    } else if (
      c === "." ||
      c === "+" ||
      c === "^" ||
      c === "$" ||
      c === "{" ||
      c === "}" ||
      c === "(" ||
      c === ")" ||
      c === "|" ||
      c === "\\"
    ) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }

  regex += "$";
  return createUserRegex(regex, ignoreCase ? "i" : "");
}
