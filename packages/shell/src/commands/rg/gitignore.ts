/**
 * .gitignore parser for rg
 *
 * Handles:
 * - Simple patterns (*.log, node_modules/)
 * - Negation patterns (!important.log)
 * - Directory-only patterns (build/)
 * - Rooted patterns (/root-only)
 * - Double-star patterns (for matching across directories)
 */

import type { IFileSystem } from "../../fs/interface";
import { createUserRegex, type RegexLike } from "../../regex/index";

interface GitignorePattern {
  /** Original pattern string */
  pattern: string;
  /** Compiled regex for matching */
  regex: RegexLike;
  /** Whether this is a negation pattern (starts with !) */
  negated: boolean;
  /** Whether this only matches directories (ends with /) */
  directoryOnly: boolean;
  /** Whether this is rooted (starts with / or contains /) */
  rooted: boolean;
}

export class GitignoreParser {
  private patterns: GitignorePattern[] = [];
  private basePath: string;

  constructor(basePath: string = "/") {
    this.basePath = basePath;
  }

  /**
   * Parse .gitignore content and add patterns
   */
  parse(content: string): void {
    const lines = content.split("\n");

    for (const line of lines) {
      // Trim trailing whitespace (but not leading - significant in gitignore)
      let trimmed = line.replace(/\s+$/, "");

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      // Handle negation
      let negated = false;
      if (trimmed.startsWith("!")) {
        negated = true;
        trimmed = trimmed.slice(1);
      }

      // Handle directory-only patterns
      let directoryOnly = false;
      if (trimmed.endsWith("/")) {
        directoryOnly = true;
        trimmed = trimmed.slice(0, -1);
      }

      // Handle rooted patterns
      let rooted = false;
      if (trimmed.startsWith("/")) {
        rooted = true;
        trimmed = trimmed.slice(1);
      } else if (trimmed.includes("/") && !trimmed.startsWith("**/")) {
        // Patterns with / in the middle are rooted
        rooted = true;
      }

      // Convert gitignore pattern to regex
      const regex = this.patternToRegex(trimmed, rooted);

      this.patterns.push({
        pattern: line,
        regex,
        negated,
        directoryOnly,
        rooted
      });
    }
  }

  /**
   * Convert a gitignore pattern to a regex
   */
  private patternToRegex(pattern: string, rooted: boolean): RegexLike {
    let regexStr = "";

    // If not rooted, can match at any depth
    if (!rooted) {
      regexStr = "(?:^|/)";
    } else {
      regexStr = "^";
    }

    let i = 0;
    while (i < pattern.length) {
      const char = pattern[i];

      if (char === "*") {
        if (pattern[i + 1] === "*") {
          // ** matches any number of directories
          if (pattern[i + 2] === "/") {
            // **/ matches zero or more directories
            regexStr += "(?:.*/)?";
            i += 3;
          } else if (i + 2 >= pattern.length) {
            // ** at end matches everything
            regexStr += ".*";
            i += 2;
          } else {
            // ** in middle
            regexStr += ".*";
            i += 2;
          }
        } else {
          // * matches anything except /
          regexStr += "[^/]*";
          i++;
        }
      } else if (char === "?") {
        // ? matches any single character except /
        regexStr += "[^/]";
        i++;
      } else if (char === "[") {
        // Character class - find the closing ]
        let j = i + 1;
        if (j < pattern.length && pattern[j] === "!") j++;
        if (j < pattern.length && pattern[j] === "]") j++;
        while (j < pattern.length && pattern[j] !== "]") j++;

        if (j < pattern.length) {
          // Valid character class
          let charClass = pattern.slice(i, j + 1);
          // Convert [!...] to [^...]
          if (charClass.startsWith("[!")) {
            charClass = `[^${charClass.slice(2)}`;
          }
          regexStr += charClass;
          i = j + 1;
        } else {
          // No closing ], treat [ as literal
          regexStr += "\\[";
          i++;
        }
      } else if (char === "/") {
        regexStr += "/";
        i++;
      } else {
        // Escape regex special characters
        regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        i++;
      }
    }

    // Pattern should match the full path component
    regexStr += "(?:/.*)?$";

    return createUserRegex(regexStr);
  }

  /**
   * Check if a path should be ignored
   *
   * @param relativePath Path relative to the gitignore location
   * @param isDirectory Whether the path is a directory
   * @returns true if the path should be ignored
   */
  matches(relativePath: string, isDirectory: boolean): boolean {
    // Normalize path - remove leading ./
    let path = relativePath.replace(/^\.\//, "");

    // Ensure path starts without /
    path = path.replace(/^\//, "");

    let ignored = false;

    for (const pattern of this.patterns) {
      // Skip directory-only patterns for files
      if (pattern.directoryOnly && !isDirectory) {
        continue;
      }

      if (pattern.regex.test(path)) {
        ignored = !pattern.negated;
      }
    }

    return ignored;
  }

  /**
   * Check if a path is explicitly whitelisted by a negation pattern
   *
   * @param relativePath Path relative to the gitignore location
   * @param isDirectory Whether the path is a directory
   * @returns true if the path is whitelisted by a negation pattern
   */
  isWhitelisted(relativePath: string, isDirectory: boolean): boolean {
    // Normalize path - remove leading ./
    let path = relativePath.replace(/^\.\//, "");

    // Ensure path starts without /
    path = path.replace(/^\//, "");

    for (const pattern of this.patterns) {
      // Skip directory-only patterns for files
      if (pattern.directoryOnly && !isDirectory) {
        continue;
      }

      // Check if a negation pattern matches
      if (pattern.negated && pattern.regex.test(path)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the base path for this gitignore
   */
  getBasePath(): string {
    return this.basePath;
  }
}

/**
 * Hierarchical gitignore manager
 *
 * Loads .gitignore and .ignore files from the root down to the current directory,
 * applying patterns in order (child patterns override parent patterns).
 */
export class GitignoreManager {
  private parsers: GitignoreParser[] = [];
  private fs: IFileSystem;
  private skipDotIgnore: boolean;
  private skipVcsIgnore: boolean;
  private loadedDirs = new Set<string>();

  constructor(
    fs: IFileSystem,
    _rootPath: string,
    skipDotIgnore = false,
    skipVcsIgnore = false
  ) {
    this.fs = fs;
    this.skipDotIgnore = skipDotIgnore;
    this.skipVcsIgnore = skipVcsIgnore;
  }

  /**
   * Load all .gitignore and .ignore files from root to the specified path
   */
  async load(targetPath: string): Promise<void> {
    // Build list of directories from filesystem root to target
    // ripgrep loads ignore files from all parent directories
    const dirs: string[] = [];
    let current = targetPath;

    while (true) {
      dirs.unshift(current);
      const parent = this.fs.resolvePath(current, "..");
      if (parent === current) break; // Reached filesystem root
      current = parent;
    }

    // Load ignore files from each directory
    // ripgrep loads them in order: .gitignore, then .rgignore, then .ignore
    // --no-ignore-dot skips .rgignore and .ignore
    // --no-ignore-vcs skips .gitignore
    const ignoreFiles: string[] = [];
    if (!this.skipVcsIgnore) {
      ignoreFiles.push(".gitignore");
    }
    if (!this.skipDotIgnore) {
      ignoreFiles.push(".rgignore", ".ignore");
    }
    for (const dir of dirs) {
      this.loadedDirs.add(dir);
      for (const filename of ignoreFiles) {
        const ignorePath = this.fs.resolvePath(dir, filename);
        try {
          const content = await this.fs.readFile(ignorePath);
          const parser = new GitignoreParser(dir);
          parser.parse(content);
          this.parsers.push(parser);
        } catch {
          // No ignore file in this directory
        }
      }
    }
  }

  /**
   * Load ignore files for a directory during traversal.
   * Only loads if the directory hasn't been loaded before.
   */
  async loadForDirectory(dir: string): Promise<void> {
    if (this.loadedDirs.has(dir)) return;
    this.loadedDirs.add(dir);

    const ignoreFiles: string[] = [];
    if (!this.skipVcsIgnore) {
      ignoreFiles.push(".gitignore");
    }
    if (!this.skipDotIgnore) {
      ignoreFiles.push(".rgignore", ".ignore");
    }

    for (const filename of ignoreFiles) {
      const ignorePath = this.fs.resolvePath(dir, filename);
      try {
        const content = await this.fs.readFile(ignorePath);
        const parser = new GitignoreParser(dir);
        parser.parse(content);
        this.parsers.push(parser);
      } catch {
        // No ignore file in this directory
      }
    }
  }

  /**
   * Add patterns from raw content at the specified base path.
   * Used for --ignore-file flag.
   */
  addPatternsFromContent(content: string, basePath: string): void {
    const parser = new GitignoreParser(basePath);
    parser.parse(content);
    this.parsers.push(parser);
  }

  /**
   * Check if a path should be ignored
   *
   * @param absolutePath Absolute path to check
   * @param isDirectory Whether the path is a directory
   * @returns true if the path should be ignored
   */
  matches(absolutePath: string, isDirectory: boolean): boolean {
    for (const parser of this.parsers) {
      // Get path relative to the gitignore location
      const basePath = parser.getBasePath();
      if (!absolutePath.startsWith(basePath)) continue;

      const relativePath = absolutePath
        .slice(basePath.length)
        .replace(/^\//, "");
      if (parser.matches(relativePath, isDirectory)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a path is explicitly whitelisted by a negation pattern.
   * Used to include hidden files that have negation patterns like "!.foo"
   *
   * @param absolutePath Absolute path to check
   * @param isDirectory Whether the path is a directory
   * @returns true if the path is whitelisted by a negation pattern
   */
  isWhitelisted(absolutePath: string, isDirectory: boolean): boolean {
    for (const parser of this.parsers) {
      // Get path relative to the gitignore location
      const basePath = parser.getBasePath();
      if (!absolutePath.startsWith(basePath)) continue;

      const relativePath = absolutePath
        .slice(basePath.length)
        .replace(/^\//, "");
      if (parser.isWhitelisted(relativePath, isDirectory)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Quick check for common ignored directories
   * Used for early pruning during traversal
   */
  static isCommonIgnored(name: string): boolean {
    // Only include VCS directories and very common dependency directories
    // that are almost never searched. Don't include build/dist/target
    // as these are often legitimately searched or have negation patterns.
    const common = new Set([
      "node_modules",
      ".git",
      ".svn",
      ".hg",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      "venv",
      ".venv",
      ".next",
      ".nuxt",
      ".cargo"
    ]);
    return common.has(name);
  }
}

/**
 * Load gitignore files for a search starting at the given path
 */
export async function loadGitignores(
  fs: IFileSystem,
  startPath: string,
  skipDotIgnore = false,
  skipVcsIgnore = false,
  customIgnoreFiles: string[] = []
): Promise<GitignoreManager> {
  const manager = new GitignoreManager(
    fs,
    startPath,
    skipDotIgnore,
    skipVcsIgnore
  );
  await manager.load(startPath);

  // Load custom ignore files (--ignore-file)
  for (const ignoreFile of customIgnoreFiles) {
    try {
      const absolutePath = fs.resolvePath(startPath, ignoreFile);
      const content = await fs.readFile(absolutePath);
      // Add patterns from custom ignore file at the root level
      manager.addPatternsFromContent(content, startPath);
    } catch {
      // Ignore missing files
    }
  }

  return manager;
}
