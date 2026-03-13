/**
 * Glob Expander - Expands glob patterns to matching file paths
 *
 * Handles:
 * - * (matches any characters except /)
 * - ** (matches any characters including /)
 * - ? (matches single character)
 * - [...] (character classes)
 */

import type { IFileSystem } from "../fs/interface";
import { ExecutionLimitError } from "../interpreter/errors";
import { createUserRegex, type RegexLike } from "../regex/index";
import { DEFAULT_BATCH_SIZE } from "../utils/constants";
import {
  findMatchingParen,
  globignorePatternToRegex,
  posixClassToRegex,
  splitExtglobAlternatives,
  splitGlobignorePatterns
} from "./glob-to-regex";

export interface GlobOptions {
  globstar?: boolean;
  nullglob?: boolean;
  failglob?: boolean;
  dotglob?: boolean;
  extglob?: boolean;
  globskipdots?: boolean;
  /** Maximum number of glob filesystem operations (default: 100000) */
  maxGlobOperations?: number;
}

/**
 * Maximum number of ** (globstar) segments allowed in a single pattern.
 * Prevents combinatorial explosion from deeply nested recursive globs.
 */
const MAX_GLOBSTAR_SEGMENTS = 5;

export class GlobExpander {
  private globignorePatterns: string[] = [];
  private hasGlobignore = false;
  private globstar = false;
  private nullglob = false;
  private failglob = false;
  private dotglob = false;
  private extglob = false;
  private globskipdots = true; // Default to true in bash >=5.2
  private ops: { count: number } = { count: 0 };
  private maxOps: number;

  constructor(
    private fs: IFileSystem,
    private cwd: string,
    env?: Map<string, string>,
    options?: GlobOptions | boolean // boolean for backwards compatibility (globstar)
  ) {
    if (typeof options === "boolean") {
      this.globstar = options;
      this.maxOps = 100000;
    } else if (options) {
      this.globstar = options.globstar ?? false;
      this.nullglob = options.nullglob ?? false;
      this.failglob = options.failglob ?? false;
      this.dotglob = options.dotglob ?? false;
      this.extglob = options.extglob ?? false;
      this.globskipdots = options.globskipdots ?? true;
      this.maxOps = options.maxGlobOperations ?? 100000;
    } else {
      this.maxOps = 100000;
    }
    // Parse GLOBIGNORE if set
    const globignore = env?.get("GLOBIGNORE");
    if (globignore !== undefined && globignore !== "") {
      this.hasGlobignore = true;
      this.globignorePatterns = splitGlobignorePatterns(globignore);
    }
  }

  /**
   * Check and increment the glob operations counter.
   * Throws an error if the limit is exceeded.
   */
  private checkOpsLimit(): void {
    if (++this.ops.count > this.maxOps) {
      throw new ExecutionLimitError(
        `Glob operation limit exceeded (${this.maxOps})`,
        "glob_operations"
      );
    }
  }

  /**
   * Check if nullglob is enabled (return empty for non-matching patterns)
   */
  hasNullglob(): boolean {
    return this.nullglob;
  }

  /**
   * Check if failglob is enabled (throw error for non-matching patterns)
   */
  hasFailglob(): boolean {
    return this.failglob;
  }

  /**
   * Filter results based on GLOBIGNORE patterns and globskipdots option
   * When GLOBIGNORE is set, . and .. are always filtered
   * When globskipdots is enabled (default in bash >=5.2), . and .. are also filtered
   */
  private filterGlobignore(results: string[]): string[] {
    // If neither GLOBIGNORE is set nor globskipdots is enabled, no filtering needed
    if (!this.hasGlobignore && !this.globskipdots) {
      return results;
    }

    return results.filter((path) => {
      // Get the basename for matching
      const basename = path.split("/").pop() || path;

      // Filter . and .. when GLOBIGNORE is set OR globskipdots is enabled
      if (
        (this.hasGlobignore || this.globskipdots) &&
        (basename === "." || basename === "..")
      ) {
        return false;
      }

      // Check if path matches any GLOBIGNORE pattern
      if (this.hasGlobignore) {
        for (const ignorePattern of this.globignorePatterns) {
          if (this.matchGlobignorePattern(path, ignorePattern)) {
            return false;
          }
        }
      }

      return true;
    });
  }

  /**
   * Match a path against a GLOBIGNORE pattern
   * GLOBIGNORE patterns are matched against the complete result path.
   * Unlike regular glob matching, * does NOT match / in GLOBIGNORE patterns.
   * This means *.txt filters "foo.txt" but NOT "dir/foo.txt".
   */
  private matchGlobignorePattern(path: string, pattern: string): boolean {
    const regex = globignorePatternToRegex(pattern);
    return regex.test(path);
  }

  /**
   * Check if a string contains glob characters
   */
  isGlobPattern(str: string): boolean {
    if (str.includes("*") || str.includes("?") || /\[.*\]/.test(str)) {
      return true;
    }
    // Check for extglob patterns: @(...), *(...), +(...), ?(...), !(...)
    if (this.extglob && /[@*+?!]\(/.test(str)) {
      return true;
    }
    return false;
  }

  /**
   * Expand an array of arguments, replacing glob patterns with matched files
   * @param args - Array of argument strings
   * @param quotedFlags - Optional array indicating which args were quoted (should not expand)
   */
  async expandArgs(args: string[], quotedFlags?: boolean[]): Promise<string[]> {
    // Identify which args need glob expansion
    const expansionPromises: (Promise<string[]> | null)[] = args.map(
      (arg, i) => {
        const isQuoted = quotedFlags?.[i] ?? false;
        if (isQuoted || !this.isGlobPattern(arg)) {
          return null; // No expansion needed
        }
        return this.expand(arg);
      }
    );

    // Run all glob expansions in parallel
    const expandedResults = await Promise.all(
      expansionPromises.map((p) => (p ? p : Promise.resolve(null)))
    );

    // Build result array preserving order
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const expanded = expandedResults[i];
      if (expanded === null) {
        result.push(args[i]);
      } else if (expanded.length > 0) {
        result.push(...expanded);
      } else {
        // If no matches, keep the original pattern (bash default behavior)
        result.push(args[i]);
      }
    }

    return result;
  }

  /**
   * Expand a single glob pattern
   */
  async expand(pattern: string): Promise<string[]> {
    // Reject patterns with excessive ** segments to prevent combinatorial explosion
    if (this.globstar) {
      const segments = pattern.split("/");
      let globstarCount = 0;
      for (const seg of segments) {
        if (seg === "**") {
          globstarCount++;
          if (globstarCount > MAX_GLOBSTAR_SEGMENTS) {
            throw new ExecutionLimitError(
              `Glob pattern has too many ** segments (max ${MAX_GLOBSTAR_SEGMENTS})`,
              "glob_operations"
            );
          }
        }
      }
    }

    let results: string[];

    // Handle ** (recursive) patterns - only when globstar is enabled
    // ** must be a complete path segment (surrounded by / or at boundaries)
    if (
      pattern.includes("**") &&
      this.globstar &&
      this.isGlobstarValid(pattern)
    ) {
      results = await this.expandRecursive(pattern);
    } else {
      // When globstar is disabled or ** is not a complete segment, treat ** as *
      const normalizedPattern = pattern.replace(/\*\*+/g, "*");
      results = await this.expandSimple(normalizedPattern);
    }

    // Apply GLOBIGNORE filtering
    return this.filterGlobignore(results);
  }

  /**
   * Check if ** is used as a complete path segment (not adjacent to other chars).
   * ** only recurses when it appears as a standalone segment like:
   *   - ** at start
   *   - / ** / in middle (no spaces)
   *   - / ** at end (no spaces)
   * NOT when adjacent to other characters like d** or **y
   */
  private isGlobstarValid(pattern: string): boolean {
    // Check if all ** occurrences are valid complete segments
    // A ** is valid if it's:
    //   - At the start and followed by / or end
    //   - In the middle surrounded by /
    //   - At the end preceded by /
    const segments = pattern.split("/");
    for (const segment of segments) {
      if (segment.includes("**")) {
        // If segment is not exactly ** (possibly with more *), it's invalid
        // e.g., "d**" or "**y" or "d**y" are invalid
        if (segment !== "**") {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Check if a path segment contains glob characters
   */
  private hasGlobChars(str: string): boolean {
    if (str.includes("*") || str.includes("?") || /\[.*\]/.test(str)) {
      return true;
    }
    // Check for extglob patterns: @(...), *(...), +(...), ?(...), !(...)
    if (this.extglob && /[@*+?!]\(/.test(str)) {
      return true;
    }
    return false;
  }

  /**
   * Expand a simple glob pattern (no **).
   * Handles multi-segment patterns like /dm/star/star.json
   */
  private async expandSimple(pattern: string): Promise<string[]> {
    // Split pattern into segments
    const isAbsolute = pattern.startsWith("/");
    const segments = pattern.split("/").filter((s) => s !== "");

    // Find the first segment with glob characters
    let firstGlobIndex = -1;
    for (let i = 0; i < segments.length; i++) {
      if (this.hasGlobChars(segments[i])) {
        firstGlobIndex = i;
        break;
      }
    }

    // No glob characters - return pattern as-is (shouldn't happen but be safe)
    if (firstGlobIndex === -1) {
      return [pattern];
    }

    // Build the base path for filesystem operations (may include cwd for relative paths)
    // Also track the result prefix (what appears in the output)
    let fsBasePath: string;
    let resultPrefix: string;

    if (firstGlobIndex === 0) {
      if (isAbsolute) {
        fsBasePath = "/";
        resultPrefix = "/";
      } else {
        fsBasePath = this.cwd;
        resultPrefix = ""; // Results should be relative, no prefix
      }
    } else {
      const baseSegments = segments.slice(0, firstGlobIndex);
      if (isAbsolute) {
        fsBasePath = `/${baseSegments.join("/")}`;
        resultPrefix = `/${baseSegments.join("/")}`;
      } else {
        fsBasePath = this.fs.resolvePath(this.cwd, baseSegments.join("/"));
        resultPrefix = baseSegments.join("/");
      }
    }

    // Get the remaining segments to match (from firstGlobIndex onwards)
    const remainingSegments = segments.slice(firstGlobIndex);

    // Recursively expand the pattern
    const results = await this.expandSegments(
      fsBasePath,
      resultPrefix,
      remainingSegments
    );

    return results.sort();
  }

  /**
   * Recursively expand path segments with glob patterns
   * @param fsPath - The actual filesystem path to read from
   * @param resultPrefix - The prefix to use when building result paths
   * @param segments - Remaining glob segments to match
   */
  private async expandSegments(
    fsPath: string,
    resultPrefix: string,
    segments: string[]
  ): Promise<string[]> {
    // Check glob operation limit at entry point
    this.checkOpsLimit();

    if (segments.length === 0) {
      return [resultPrefix];
    }

    const [currentSegment, ...remainingSegments] = segments;
    const results: string[] = [];

    try {
      // Use readdirWithFileTypes if available to avoid stat calls
      if (this.fs.readdirWithFileTypes) {
        this.checkOpsLimit(); // Count readdir operation
        const entriesWithTypes = await this.fs.readdirWithFileTypes(fsPath);
        const matchPromises: Promise<string[]>[] = [];

        // Add . and .. as virtual directory entries if pattern starts with .
        // These are always valid directory entries but may not be returned by readdir
        const allEntries = [...entriesWithTypes];
        // When GLOBIGNORE is set, dotglob is implicitly enabled for regular dotfiles (bash behavior)
        // but . and .. are still excluded unless explicitly matched
        const effectiveDotglob = this.dotglob || this.hasGlobignore;
        // Only add . and .. if pattern explicitly starts with . OR dotglob is explicitly set
        // (not just GLOBIGNORE-implied, since GLOBIGNORE always filters . and ..)
        if (currentSegment.startsWith(".") || this.dotglob) {
          // Check if . and .. are already in entries
          const hasCurrentDir = entriesWithTypes.some((e) => e.name === ".");
          const hasParentDir = entriesWithTypes.some((e) => e.name === "..");
          if (!hasCurrentDir) {
            allEntries.push({
              name: ".",
              isFile: false,
              isDirectory: true,
              isSymbolicLink: false
            });
          }
          if (!hasParentDir) {
            allEntries.push({
              name: "..",
              isFile: false,
              isDirectory: true,
              isSymbolicLink: false
            });
          }
        }

        for (const entry of allEntries) {
          // Skip hidden files unless pattern explicitly matches them or dotglob is enabled
          // When GLOBIGNORE is set, dotglob is implicitly enabled (bash behavior)
          if (
            entry.name.startsWith(".") &&
            !currentSegment.startsWith(".") &&
            !effectiveDotglob
          ) {
            continue;
          }

          if (this.matchPattern(entry.name, currentSegment)) {
            // Build the new filesystem path
            const newFsPath =
              fsPath === "/" ? `/${entry.name}` : `${fsPath}/${entry.name}`;

            // Build the new result prefix
            let newResultPrefix: string;
            if (resultPrefix === "") {
              newResultPrefix = entry.name;
            } else if (resultPrefix === "/") {
              newResultPrefix = `/${entry.name}`;
            } else {
              newResultPrefix = `${resultPrefix}/${entry.name}`;
            }

            if (remainingSegments.length === 0) {
              // No more segments - add this path to results
              matchPromises.push(Promise.resolve([newResultPrefix]));
            } else if (entry.isDirectory) {
              // More segments to match and this is a directory - recurse
              matchPromises.push(
                this.expandSegments(
                  newFsPath,
                  newResultPrefix,
                  remainingSegments
                )
              );
            }
            // If not a directory and more segments remain, skip this entry
          }
        }

        const allResults = await Promise.all(matchPromises);
        for (const pathList of allResults) {
          results.push(...pathList);
        }
      } else {
        // Fall back to readdir + stat
        this.checkOpsLimit(); // Count readdir operation
        const entries = await this.fs.readdir(fsPath);
        const matchPromises: Promise<string[]>[] = [];

        // Add . and .. as virtual directory entries if pattern starts with .
        const allEntries = [...entries];
        // When GLOBIGNORE is set, dotglob is implicitly enabled for regular dotfiles (bash behavior)
        // but . and .. are still excluded unless explicitly matched
        const effectiveDotglobFallback = this.dotglob || this.hasGlobignore;
        // Only add . and .. if pattern explicitly starts with . OR dotglob is explicitly set
        if (currentSegment.startsWith(".") || this.dotglob) {
          if (!entries.includes(".")) {
            allEntries.push(".");
          }
          if (!entries.includes("..")) {
            allEntries.push("..");
          }
        }

        for (const entry of allEntries) {
          // Skip hidden files unless pattern explicitly matches them or dotglob is enabled
          // When GLOBIGNORE is set, dotglob is implicitly enabled (bash behavior)
          if (
            entry.startsWith(".") &&
            !currentSegment.startsWith(".") &&
            !effectiveDotglobFallback
          ) {
            continue;
          }

          if (this.matchPattern(entry, currentSegment)) {
            // Build the new filesystem path
            const newFsPath =
              fsPath === "/" ? `/${entry}` : `${fsPath}/${entry}`;

            // Build the new result prefix
            let newResultPrefix: string;
            if (resultPrefix === "") {
              newResultPrefix = entry;
            } else if (resultPrefix === "/") {
              newResultPrefix = `/${entry}`;
            } else {
              newResultPrefix = `${resultPrefix}/${entry}`;
            }

            if (remainingSegments.length === 0) {
              // No more segments - add this path to results
              matchPromises.push(Promise.resolve([newResultPrefix]));
            } else {
              // More segments to match - check if this is a directory and recurse
              matchPromises.push(
                (async (): Promise<string[]> => {
                  try {
                    this.checkOpsLimit(); // Count stat operation
                    const stat = await this.fs.stat(newFsPath);
                    if (stat.isDirectory) {
                      return this.expandSegments(
                        newFsPath,
                        newResultPrefix,
                        remainingSegments
                      );
                    }
                  } catch (error) {
                    // ExecutionLimitError must propagate
                    if (error instanceof ExecutionLimitError) {
                      throw error;
                    }
                    // Entry doesn't exist or can't be stat'd
                  }
                  return [];
                })()
              );
            }
          }
        }

        const allResults = await Promise.all(matchPromises);
        for (const pathList of allResults) {
          results.push(...pathList);
        }
      }
    } catch (error) {
      // ExecutionLimitError must propagate
      if (error instanceof ExecutionLimitError) {
        throw error;
      }
      // Directory doesn't exist - return empty
    }

    return results;
  }

  /**
   * Expand a recursive glob pattern (contains **)
   */
  private async expandRecursive(pattern: string): Promise<string[]> {
    const results: string[] = [];

    // Split pattern at first **
    const doubleStarIndex = pattern.indexOf("**");
    const beforeDoubleStar =
      pattern.slice(0, doubleStarIndex).replace(/\/$/, "") || ".";
    const afterDoubleStar = pattern.slice(doubleStarIndex + 2);

    // Get the file pattern after **
    const filePattern = afterDoubleStar.replace(/^\//, "");

    // Check if the file pattern contains another ** (multiple globstar)
    // If so, we need to recursively expand from each directory
    if (filePattern.includes("**") && this.isGlobstarValid(filePattern)) {
      await this.walkDirectoryMultiGlobstar(
        beforeDoubleStar,
        filePattern,
        results
      );
      // Dedupe results since multiple ** can match the same file from different paths
      const unique = [...new Set(results)];
      return unique.sort();
    } else {
      await this.walkDirectory(beforeDoubleStar, filePattern, results);
    }

    return results.sort();
  }

  /**
   * Walk directory for patterns with multiple globstar (like dir/star-star/subdir/star-star/etc)
   * At each directory level, recursively expand the sub-pattern that contains globstar
   */
  private async walkDirectoryMultiGlobstar(
    dir: string,
    subPattern: string,
    results: string[]
  ): Promise<void> {
    // Check glob operation limit before directory scan
    this.checkOpsLimit();

    const fullPath = this.fs.resolvePath(this.cwd, dir);

    try {
      // Get all directories at this level
      this.checkOpsLimit(); // Count readdir operation
      const entriesWithTypes = this.fs.readdirWithFileTypes
        ? await this.fs.readdirWithFileTypes(fullPath)
        : null;

      if (entriesWithTypes) {
        const dirs: string[] = [];

        for (const entry of entriesWithTypes) {
          const entryPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
          if (entry.isDirectory) {
            dirs.push(entryPath);
          }
        }

        // From this directory, expand the sub-pattern (which contains **)
        // Build a pattern relative to this directory
        const patternFromHere =
          dir === "." ? subPattern : `${dir}/${subPattern}`;
        const subResults = await this.expandRecursive(patternFromHere);
        results.push(...subResults);

        // Also recurse into subdirectories (because the first ** can match multiple levels)
        for (let i = 0; i < dirs.length; i += DEFAULT_BATCH_SIZE) {
          const batch = dirs.slice(i, i + DEFAULT_BATCH_SIZE);
          await Promise.all(
            batch.map((dirPath) =>
              this.walkDirectoryMultiGlobstar(dirPath, subPattern, results)
            )
          );
        }
      } else {
        // Fall back to readdir + stat
        this.checkOpsLimit(); // Count readdir operation
        const entries = await this.fs.readdir(fullPath);
        const dirs: string[] = [];

        for (const entry of entries) {
          const entryPath = dir === "." ? entry : `${dir}/${entry}`;
          const fullEntryPath = this.fs.resolvePath(this.cwd, entryPath);
          try {
            this.checkOpsLimit(); // Count stat operation
            const stat = await this.fs.stat(fullEntryPath);
            if (stat.isDirectory) {
              dirs.push(entryPath);
            }
          } catch (error) {
            // ExecutionLimitError must propagate
            if (error instanceof ExecutionLimitError) {
              throw error;
            }
            // Entry doesn't exist
          }
        }

        // From this directory, expand the sub-pattern
        const patternFromHere =
          dir === "." ? subPattern : `${dir}/${subPattern}`;
        const subResults = await this.expandRecursive(patternFromHere);
        results.push(...subResults);

        // Recurse into subdirectories
        for (let i = 0; i < dirs.length; i += DEFAULT_BATCH_SIZE) {
          const batch = dirs.slice(i, i + DEFAULT_BATCH_SIZE);
          await Promise.all(
            batch.map((dirPath) =>
              this.walkDirectoryMultiGlobstar(dirPath, subPattern, results)
            )
          );
        }
      }
    } catch (error) {
      // ExecutionLimitError must propagate
      if (error instanceof ExecutionLimitError) {
        throw error;
      }
      // Directory doesn't exist
    }
  }

  /**
   * Recursively walk a directory and collect matching files
   */
  private async walkDirectory(
    dir: string,
    filePattern: string,
    results: string[]
  ): Promise<void> {
    // Check glob operation limit before directory scan
    this.checkOpsLimit();

    const fullPath = this.fs.resolvePath(this.cwd, dir);

    try {
      // Use readdirWithFileTypes if available to avoid stat calls
      if (this.fs.readdirWithFileTypes) {
        this.checkOpsLimit(); // Count readdir operation
        const entriesWithTypes = await this.fs.readdirWithFileTypes(fullPath);

        // Separate files and directories
        const files: string[] = [];
        const dirs: string[] = [];

        for (const entry of entriesWithTypes) {
          const entryPath = dir === "." ? entry.name : `${dir}/${entry.name}`;
          if (entry.isDirectory) {
            dirs.push(entryPath);
          } else if (
            filePattern &&
            this.matchPattern(entry.name, filePattern)
          ) {
            files.push(entryPath);
          }
        }

        // Add matched files to results
        results.push(...files);

        // Process directories in parallel batches
        for (let i = 0; i < dirs.length; i += DEFAULT_BATCH_SIZE) {
          const batch = dirs.slice(i, i + DEFAULT_BATCH_SIZE);
          await Promise.all(
            batch.map((dirPath) =>
              this.walkDirectory(dirPath, filePattern, results)
            )
          );
        }
      } else {
        // Fall back to readdir + parallel stat
        this.checkOpsLimit(); // Count readdir operation
        const entries = await this.fs.readdir(fullPath);

        // Get entry info in parallel batches
        interface EntryInfo {
          name: string;
          path: string;
          isDirectory: boolean;
        }
        const entryInfos: EntryInfo[] = [];

        for (let i = 0; i < entries.length; i += DEFAULT_BATCH_SIZE) {
          const batch = entries.slice(i, i + DEFAULT_BATCH_SIZE);
          const batchResults = await Promise.all(
            batch.map(async (entry) => {
              const entryPath = dir === "." ? entry : `${dir}/${entry}`;
              const fullEntryPath = this.fs.resolvePath(this.cwd, entryPath);
              try {
                this.checkOpsLimit(); // Count stat operation
                const stat = await this.fs.stat(fullEntryPath);
                return {
                  name: entry,
                  path: entryPath,
                  isDirectory: stat.isDirectory
                };
              } catch (error) {
                // ExecutionLimitError must propagate
                if (error instanceof ExecutionLimitError) {
                  throw error;
                }
                return null;
              }
            })
          );
          entryInfos.push(
            ...(batchResults.filter((r) => r !== null) as EntryInfo[])
          );
        }

        // Process files
        for (const entry of entryInfos) {
          if (!entry.isDirectory && filePattern) {
            if (this.matchPattern(entry.name, filePattern)) {
              results.push(entry.path);
            }
          }
        }

        // Recurse into directories in parallel batches
        const dirs = entryInfos.filter((e) => e.isDirectory);
        for (let i = 0; i < dirs.length; i += DEFAULT_BATCH_SIZE) {
          const batch = dirs.slice(i, i + DEFAULT_BATCH_SIZE);
          await Promise.all(
            batch.map((entry) =>
              this.walkDirectory(entry.path, filePattern, results)
            )
          );
        }
      }
    } catch (error) {
      // ExecutionLimitError must propagate
      if (error instanceof ExecutionLimitError) {
        throw error;
      }
      // Directory doesn't exist
    }
  }

  /**
   * Match a filename against a glob pattern
   */
  matchPattern(name: string, pattern: string): boolean {
    const regex = this.patternToRegex(pattern);
    return regex.test(name);
  }

  /**
   * Convert a glob pattern to a RegExp
   */
  private patternToRegex(pattern: string): RegexLike {
    const regex = this.patternToRegexStr(pattern);
    return createUserRegex(`^${regex}$`);
  }

  /**
   * Convert a glob pattern to a regex string (without anchors)
   */
  private patternToRegexStr(pattern: string): string {
    let regex = "";
    let inQuotedSection = false;

    for (let i = 0; i < pattern.length; i++) {
      // Check for quote markers (from splitExtglobAlternatives)
      // \x00QUOTE_START\x00 is 13 chars, \x00QUOTE_END\x00 is 11 chars
      if (pattern.slice(i, i + 13) === "\x00QUOTE_START\x00") {
        inQuotedSection = true;
        i += 12; // Will be incremented by loop
        continue;
      }
      if (pattern.slice(i, i + 11) === "\x00QUOTE_END\x00") {
        inQuotedSection = false;
        i += 10; // Will be incremented by loop
        continue;
      }

      const c = pattern[i];

      // Inside quoted section, all characters are literal (escape regex special chars)
      if (inQuotedSection) {
        if (/[.+^${}()|\\*?[\]]/.test(c)) {
          regex += `\\${c}`;
        } else {
          regex += c;
        }
        continue;
      }

      // Check for extglob patterns: @(...), *(...), +(...), ?(...), !(...)
      if (
        this.extglob &&
        (c === "@" || c === "*" || c === "+" || c === "?" || c === "!") &&
        i + 1 < pattern.length &&
        pattern[i + 1] === "("
      ) {
        // Find the matching closing paren (handle nesting)
        const closeIdx = findMatchingParen(pattern, i + 1);
        if (closeIdx !== -1) {
          const content = pattern.slice(i + 2, closeIdx);
          // Split on | but handle nested extglob patterns
          const alternatives = splitExtglobAlternatives(content);
          // Convert each alternative recursively
          const altRegexes = alternatives.map((alt) =>
            this.patternToRegexStr(alt)
          );
          const altGroup =
            altRegexes.length > 0 ? altRegexes.join("|") : "(?:)";

          if (c === "@") {
            // @(...) - match exactly one of the patterns
            regex += `(?:${altGroup})`;
          } else if (c === "*") {
            // *(...) - match zero or more occurrences
            regex += `(?:${altGroup})*`;
          } else if (c === "+") {
            // +(...) - match one or more occurrences
            regex += `(?:${altGroup})+`;
          } else if (c === "?") {
            // ?(...) - match zero or one occurrence
            regex += `(?:${altGroup})?`;
          } else if (c === "!") {
            // !(...) - match anything except the patterns
            // When !(pattern) is followed by more pattern content, we need special handling
            // to ensure proper backtracking. Check if there's more pattern after this.
            const hasMorePattern = closeIdx < pattern.length - 1;
            if (hasMorePattern) {
              // Try to compute fixed lengths for the alternatives
              // If all alternatives have the same fixed length, use length-based matching
              const lengths = alternatives.map((alt) =>
                this.computePatternLength(alt)
              );
              const allSameLength =
                lengths.every((l) => l !== null) &&
                lengths.every((l) => l === lengths[0]);

              if (allSameLength && lengths[0] !== null) {
                const n = lengths[0];
                if (n === 0) {
                  // !(empty) followed by more - matches any non-empty string
                  regex += "(?:.+)";
                } else {
                  // Match: <n chars OR >n chars OR exactly n chars that aren't the pattern
                  // .{0,n-1} handles 0 to n-1 chars
                  // .{n+1,} handles n+1 or more chars
                  // (?!pattern).{n} handles exactly n chars that don't match pattern
                  const parts: string[] = [];
                  if (n > 0) {
                    parts.push(`.{0,${n - 1}}`);
                  }
                  parts.push(`.{${n + 1},}`);
                  parts.push(`(?!(?:${altGroup})).{${n}}`);
                  regex += `(?:${parts.join("|")})`;
                }
              } else {
                // Complex case: different lengths or variable-length patterns
                // Use character-by-character matching with negative lookahead
                // This works for simple patterns but may be imprecise for complex ones
                regex += `(?:(?!(?:${altGroup})).)*?`;
              }
            } else {
              // At end of pattern - use simple negative lookahead
              regex += `(?!(?:${altGroup})$).*`;
            }
          }
          i = closeIdx;
          continue;
        }
      }

      if (c === "*") {
        regex += ".*";
      } else if (c === "?") {
        regex += ".";
      } else if (c === "[") {
        // Character class - find the closing bracket
        // Handle negation [^...] or [!...]
        // Handle POSIX classes [[:alpha:]], [[:punct:]], etc.
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

    return regex;
  }

  /**
   * Compute the fixed length of a pattern, if it has one.
   * Returns null if the pattern has variable length (contains *, +, etc.).
   * Used to optimize !() extglob patterns.
   */
  private computePatternLength(pattern: string): number | null {
    let length = 0;
    let i = 0;
    let inQuotedSection = false;

    while (i < pattern.length) {
      // Check for quote markers (from splitExtglobAlternatives)
      // \x00QUOTE_START\x00 is 13 chars, \x00QUOTE_END\x00 is 11 chars
      if (pattern.slice(i, i + 13) === "\x00QUOTE_START\x00") {
        inQuotedSection = true;
        i += 13;
        continue;
      }
      if (pattern.slice(i, i + 11) === "\x00QUOTE_END\x00") {
        inQuotedSection = false;
        i += 11;
        continue;
      }

      const c = pattern[i];

      // Inside quoted section, all characters count as literal (fixed length 1 each)
      if (inQuotedSection) {
        length += 1;
        i++;
        continue;
      }

      // Check for extglob patterns
      if (
        (c === "@" || c === "*" || c === "+" || c === "?" || c === "!") &&
        i + 1 < pattern.length &&
        pattern[i + 1] === "("
      ) {
        const closeIdx = findMatchingParen(pattern, i + 1);
        if (closeIdx !== -1) {
          if (c === "@") {
            // @() matches exactly one occurrence - get length of alternatives
            const content = pattern.slice(i + 2, closeIdx);
            const alts = splitExtglobAlternatives(content);
            const altLengths = alts.map((a) => this.computePatternLength(a));
            // All alternatives must have same length for fixed length
            if (
              altLengths.every((l) => l !== null) &&
              altLengths.every((l) => l === altLengths[0])
            ) {
              length += altLengths[0] as number;
              i = closeIdx + 1;
              continue;
            }
            return null; // Variable length
          }
          // *, +, ?, ! all have variable length
          return null;
        }
      }

      if (c === "*") {
        return null; // Variable length
      }
      if (c === "?") {
        length += 1;
        i++;
        continue;
      }
      if (c === "[") {
        // Character class matches exactly 1 char
        const closeIdx = pattern.indexOf("]", i + 1);
        if (closeIdx !== -1) {
          length += 1;
          i = closeIdx + 1;
          continue;
        }
        // No closing bracket - treat as literal
        length += 1;
        i++;
        continue;
      }
      if (c === "\\") {
        // Escaped char
        length += 1;
        i += 2;
        continue;
      }
      // Regular character
      length += 1;
      i++;
    }

    return length;
  }
}
