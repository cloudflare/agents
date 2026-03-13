/**
 * UserRegex - Centralized regex handling for user-provided patterns
 *
 * This module provides a single point of control for all user-provided regex
 * execution. Uses RE2JS for ReDoS protection via linear-time matching.
 *
 * All user-provided regex patterns should go through this module.
 * Internal patterns (those we control) can use ConstantRegex for the same interface.
 */

import { RE2JS, RE2JSSyntaxException } from "re2js";

/**
 * Type for replacement callback functions.
 * Matches the signature of String.prototype.replace callback.
 */
export type ReplaceCallback = (
  match: string,
  ...args: (string | number | Record<string, string>)[]
) => string;

/**
 * Common interface for regex wrappers.
 * Both UserRegex (for user patterns) and ConstantRegex (for internal patterns) implement this.
 */
export interface RegexLike {
  test(input: string): boolean;
  exec(input: string): RegExpExecArray | null;
  match(input: string): RegExpMatchArray | null;
  replace(input: string, replacement: string | ReplaceCallback): string;
  split(input: string, limit?: number): string[];
  search(input: string): number;
  matchAll(input: string): IterableIterator<RegExpMatchArray>;
  readonly native: RegExp;
  readonly source: string;
  readonly flags: string;
  readonly global: boolean;
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  lastIndex: number;
}

/**
 * Convert string flags to RE2JS numeric flags.
 * RE2 doesn't support the 'g' flag - we handle global matching manually.
 */
function convertFlags(flags: string): number {
  let re2Flags = 0;
  if (flags.includes("i")) {
    re2Flags |= RE2JS.CASE_INSENSITIVE;
  }
  if (flags.includes("m")) {
    re2Flags |= RE2JS.MULTILINE;
  }
  if (flags.includes("s")) {
    re2Flags |= RE2JS.DOTALL;
  }
  return re2Flags;
}

/**
 * Translate a JavaScript regex pattern to RE2-compatible syntax.
 * Uses RE2JS.translateRegExp to handle syntax differences.
 */
function translatePattern(pattern: string): string {
  return RE2JS.translateRegExp(pattern);
}

/**
 * A wrapper around RE2JS that provides a RegExp-compatible interface.
 * Uses RE2 for linear-time matching, providing ReDoS protection.
 */
export class UserRegex implements RegexLike {
  private readonly _re2: RE2JS;
  private readonly _pattern: string;
  private readonly _flags: string;
  private readonly _global: boolean;
  private readonly _ignoreCase: boolean;
  private readonly _multiline: boolean;
  private _lastIndex = 0;
  // Cache native RegExp for compatibility - created lazily
  private _nativeRegex: RegExp | null = null;

  constructor(pattern: string, flags = "") {
    this._pattern = pattern;
    this._flags = flags;
    this._global = flags.includes("g");
    this._ignoreCase = flags.includes("i");
    this._multiline = flags.includes("m");

    try {
      const translatedPattern = translatePattern(pattern);
      const re2Flags = convertFlags(flags);
      this._re2 = RE2JS.compile(translatedPattern, re2Flags);
    } catch (e) {
      if (e instanceof RE2JSSyntaxException) {
        // Provide helpful error messages for unsupported RE2 features
        const msg = e.message || "";
        let explanation = "";

        if (
          msg.includes("(?=") ||
          msg.includes("(?!") ||
          msg.includes("(?<") ||
          msg.includes("(?<!") ||
          pattern.includes("(?=") ||
          pattern.includes("(?!") ||
          pattern.includes("(?<=") ||
          pattern.includes("(?<!")
        ) {
          explanation =
            " Lookahead (?=, ?!) and lookbehind (?<=, ?<!) assertions are not supported in this environment because the regex engine uses RE2 for ReDoS protection. RE2 guarantees linear-time matching but cannot support these features.";
        } else if (msg.includes("backreference") || /\\[1-9]/.test(pattern)) {
          explanation =
            " Backreferences (\\1, \\2, etc.) are not supported in this environment because the regex engine uses RE2 for ReDoS protection. RE2 guarantees linear-time matching but cannot support backreferences.";
        }

        throw new SyntaxError(
          `Invalid regular expression: /${pattern}/: ${msg}${explanation}`
        );
      }
      throw e;
    }
  }

  /**
   * Test if the pattern matches the input string.
   */
  test(input: string): boolean {
    // Reset lastIndex for global regexes to ensure consistent behavior
    if (this._global) {
      this._lastIndex = 0;
    }
    const matcher = this._re2.matcher(input);
    return matcher.find();
  }

  /**
   * Execute the pattern against the input string.
   * Returns match array with capture groups, or null if no match.
   */
  exec(input: string): RegExpExecArray | null {
    const matcher = this._re2.matcher(input);

    // For global regex, start from lastIndex
    const startPos = this._global ? this._lastIndex : 0;
    if (!matcher.find(startPos)) {
      if (this._global) {
        this._lastIndex = 0;
      }
      return null;
    }

    // Build result array
    const groupCount = this._re2.groupCount();
    const result: string[] = [];

    // Group 0 is the full match
    result.push(matcher.group(0) ?? "");

    // Add capture groups
    for (let i = 1; i <= groupCount; i++) {
      const group = matcher.group(i);
      result.push(group as string);
    }

    // Add RegExpExecArray properties
    const execResult = result as unknown as RegExpExecArray;
    execResult.index = matcher.start(0);
    execResult.input = input;

    // Add named groups if any
    const namedGroups = this._re2.namedGroups();
    if (namedGroups && Object.keys(namedGroups).length > 0) {
      // Use Object.create(null) to prevent prototype pollution from names like __proto__
      const groups: { [key: string]: string } = Object.create(null);
      for (const [name, index] of Object.entries(namedGroups)) {
        const value = matcher.group(index as number);
        if (value !== null) {
          groups[name] = value;
        }
      }
      execResult.groups = groups;
    }

    // Update lastIndex for global regex
    if (this._global) {
      this._lastIndex = matcher.end(0);
      // Handle zero-length matches
      if (matcher.start(0) === matcher.end(0)) {
        this._lastIndex++;
      }
    }

    return execResult;
  }

  /**
   * Match the input string against the pattern.
   * With global flag, returns all matches. Without, returns first match with groups.
   */
  match(input: string): RegExpMatchArray | null {
    // Reset lastIndex for consistent behavior
    if (this._global) {
      this._lastIndex = 0;
    }

    if (!this._global) {
      // Non-global: return first match with groups (same as exec)
      return this.exec(input);
    }

    // Global: return all matches without groups
    const matches: string[] = [];
    const matcher = this._re2.matcher(input);
    let pos = 0;

    while (matcher.find(pos)) {
      const matchStr = matcher.group(0) ?? "";
      matches.push(matchStr);
      pos = matcher.end(0);
      // Handle zero-length matches
      if (matcher.start(0) === matcher.end(0)) {
        pos++;
      }
      if (pos > input.length) break;
    }

    return matches.length > 0 ? (matches as RegExpMatchArray) : null;
  }

  /**
   * Replace matches in the input string.
   * @param input - The string to search in
   * @param replacement - A string or callback function
   */
  replace(input: string, replacement: string | ReplaceCallback): string {
    // Reset lastIndex for global regexes
    if (this._global) {
      this._lastIndex = 0;
    }

    if (typeof replacement === "string") {
      const matcher = this._re2.matcher(input);
      // Use perlMode=true for JavaScript-style replacement ($1, $2, etc.)
      if (this._global) {
        return matcher.replaceAll(replacement, true);
      }
      return matcher.replaceFirst(replacement, true);
    }

    // Callback replacement - we need to do this manually
    const result: string[] = [];
    const matcher = this._re2.matcher(input);
    let lastEnd = 0;
    let pos = 0;
    const groupCount = this._re2.groupCount();
    const namedGroups = this._re2.namedGroups();

    while (matcher.find(pos)) {
      // Add text before match
      result.push(input.slice(lastEnd, matcher.start(0)));

      // Build callback arguments
      const args: (string | number | Record<string, string>)[] = [];
      const fullMatch = matcher.group(0) ?? "";

      // Add capture groups
      for (let i = 1; i <= groupCount; i++) {
        args.push(matcher.group(i) as string);
      }

      // Add index and input
      args.push(matcher.start(0));
      args.push(input);

      // Add named groups if present
      if (namedGroups && Object.keys(namedGroups).length > 0) {
        // Use Object.create(null) to prevent prototype pollution from names like __proto__
        const groups: Record<string, string> = Object.create(null);
        for (const [name, index] of Object.entries(namedGroups)) {
          groups[name] = matcher.group(index as number) ?? "";
        }
        args.push(groups);
      }

      // Call replacement function
      result.push(replacement(fullMatch, ...args));

      lastEnd = matcher.end(0);
      pos = lastEnd;
      // Handle zero-length matches
      if (matcher.start(0) === matcher.end(0)) {
        pos++;
      }

      if (!this._global) break;
      if (pos > input.length) break;
    }

    // Add remaining text
    result.push(input.slice(lastEnd));

    return result.join("");
  }

  /**
   * Split the input string by the pattern.
   * Note: RE2JS split with limit includes remainder in last element (Java-style),
   * but JS split truncates to exactly limit elements. We implement JS behavior.
   */
  split(input: string, limit?: number): string[] {
    if (limit === undefined || limit < 0) {
      return this._re2.split(input, -1);
    }
    if (limit === 0) {
      return [];
    }
    // RE2JS returns remainder in last element; JS just takes first N elements
    const result = this._re2.split(input, -1);
    return result.slice(0, limit);
  }

  /**
   * Search for the pattern in the input string.
   * Returns the index of the first match, or -1 if not found.
   */
  search(input: string): number {
    const matcher = this._re2.matcher(input);
    if (matcher.find()) {
      return matcher.start(0);
    }
    return -1;
  }

  /**
   * Get all matches using an iterator (for global regexes).
   */
  *matchAll(input: string): IterableIterator<RegExpMatchArray> {
    if (!this._global) {
      throw new Error("matchAll requires global flag");
    }

    this._lastIndex = 0;
    const matcher = this._re2.matcher(input);
    const groupCount = this._re2.groupCount();
    const namedGroups = this._re2.namedGroups();
    let pos = 0;

    while (matcher.find(pos)) {
      // Build result array
      const result: string[] = [];
      result.push(matcher.group(0) ?? "");

      for (let i = 1; i <= groupCount; i++) {
        result.push(matcher.group(i) as string);
      }

      const execResult = result as unknown as RegExpMatchArray;
      execResult.index = matcher.start(0);
      execResult.input = input;

      // Add named groups if any
      if (namedGroups && Object.keys(namedGroups).length > 0) {
        // Use Object.create(null) to prevent prototype pollution from names like __proto__
        const groups: { [key: string]: string } = Object.create(null);
        for (const [name, index] of Object.entries(namedGroups)) {
          const value = matcher.group(index as number);
          if (value !== null) {
            groups[name] = value;
          }
        }
        execResult.groups = groups;
      }

      yield execResult;

      pos = matcher.end(0);
      // Prevent infinite loop on zero-length matches
      if (matcher.start(0) === matcher.end(0)) {
        pos++;
      }
      if (pos > input.length) break;
    }
  }

  /**
   * Get the underlying RegExp object.
   * Creates a native RegExp lazily for compatibility with code that needs it.
   * Note: The native RegExp is only for compatibility - actual matching uses RE2.
   */
  get native(): RegExp {
    if (!this._nativeRegex) {
      // Create a native RegExp for compatibility
      // This may fail for RE2-specific patterns, but most patterns work
      try {
        this._nativeRegex = new RegExp(this._pattern, this._flags);
      } catch {
        // If the pattern doesn't work in native RegExp, create a dummy
        // that at least has the same source/flags
        this._nativeRegex = new RegExp("", this._flags);
        Object.defineProperty(this._nativeRegex, "source", {
          value: this._pattern,
          writable: false
        });
      }
    }
    return this._nativeRegex;
  }

  /**
   * Get the pattern string.
   */
  get source(): string {
    return this._pattern;
  }

  /**
   * Get the flags string.
   */
  get flags(): string {
    return this._flags;
  }

  /**
   * Check if this is a global regex.
   */
  get global(): boolean {
    return this._global;
  }

  /**
   * Check if this is a case-insensitive regex.
   */
  get ignoreCase(): boolean {
    return this._ignoreCase;
  }

  /**
   * Check if this is a multiline regex.
   */
  get multiline(): boolean {
    return this._multiline;
  }

  /**
   * Get/set lastIndex for global regexes.
   */
  get lastIndex(): number {
    return this._lastIndex;
  }

  set lastIndex(value: number) {
    this._lastIndex = value;
  }
}

/**
 * Create a UserRegex from a pattern string and flags.
 * This is the primary entry point for user-provided regex patterns.
 * Uses RE2 for ReDoS protection.
 *
 * @param pattern - The regex pattern string
 * @param flags - Optional regex flags (g, i, m, s, u)
 * @returns A UserRegex instance
 * @throws Error if the pattern is invalid
 */
export function createUserRegex(pattern: string, flags = ""): UserRegex {
  return new UserRegex(pattern, flags);
}

/**
 * A wrapper around native RegExp for constant/internal patterns.
 * Use this for patterns we control (not user-provided) that don't need ReDoS protection.
 * Implements the same interface as UserRegex for consistency.
 */
export class ConstantRegex implements RegexLike {
  private readonly _regex: RegExp;

  constructor(regex: RegExp) {
    this._regex = regex;
  }

  test(input: string): boolean {
    if (this._regex.global) {
      this._regex.lastIndex = 0;
    }
    return this._regex.test(input);
  }

  exec(input: string): RegExpExecArray | null {
    return this._regex.exec(input);
  }

  match(input: string): RegExpMatchArray | null {
    if (this._regex.global) {
      this._regex.lastIndex = 0;
    }
    return input.match(this._regex);
  }

  replace(input: string, replacement: string | ReplaceCallback): string {
    if (this._regex.global) {
      this._regex.lastIndex = 0;
    }
    return input.replace(
      this._regex,
      replacement as (substring: string, ...args: unknown[]) => string
    );
  }

  split(input: string, limit?: number): string[] {
    return input.split(this._regex, limit);
  }

  search(input: string): number {
    return input.search(this._regex);
  }

  *matchAll(input: string): IterableIterator<RegExpMatchArray> {
    if (!this._regex.global) {
      throw new Error("matchAll requires global flag");
    }
    this._regex.lastIndex = 0;
    let match = this._regex.exec(input);
    while (match !== null) {
      yield match;
      if (match[0].length === 0) {
        this._regex.lastIndex++;
      }
      match = this._regex.exec(input);
    }
  }

  get native(): RegExp {
    return this._regex;
  }

  get source(): string {
    return this._regex.source;
  }

  get flags(): string {
    return this._regex.flags;
  }

  get global(): boolean {
    return this._regex.global;
  }

  get ignoreCase(): boolean {
    return this._regex.ignoreCase;
  }

  get multiline(): boolean {
    return this._regex.multiline;
  }

  get lastIndex(): number {
    return this._regex.lastIndex;
  }

  set lastIndex(value: number) {
    this._regex.lastIndex = value;
  }
}
