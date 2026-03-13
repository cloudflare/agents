/**
 * Core search logic for rg command
 */

import { gunzipSync } from "node:zlib";
import { shellJoinArgs } from "../../helpers/shell-quote";
import { createUserRegex, type UserRegex } from "../../regex/index";
import type { CommandContext, ExecResult } from "../../types";
import {
  buildRegex,
  convertReplacement,
  type RegexResult,
  searchContent
} from "../search-engine/index";
import { FileTypeRegistry } from "./file-types";
import { GitignoreManager, loadGitignores } from "./gitignore";
import type { RgOptions } from "./rg-options";

/**
 * Check if data is gzip compressed (magic bytes)
 */
function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/**
 * Validate glob pattern for errors (e.g., unclosed character class)
 * Returns error message if invalid, null if valid
 */
function validateGlob(glob: string): string | null {
  // Check for unclosed character class
  let inClass = false;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "[" && !inClass) {
      inClass = true;
    } else if (char === "]" && inClass) {
      inClass = false;
    }
  }
  if (inClass) {
    return `rg: glob '${glob}' has an unclosed character class`;
  }
  return null;
}

export interface SearchContext {
  ctx: CommandContext;
  options: RgOptions;
  paths: string[];
  explicitLineNumbers: boolean;
}

/**
 * Execute the search with parsed options
 */
export async function executeSearch(
  searchCtx: SearchContext
): Promise<ExecResult> {
  const { ctx, options, paths: inputPaths, explicitLineNumbers } = searchCtx;

  // Validate glob patterns for errors
  for (const glob of options.globs) {
    const globToValidate = glob.startsWith("!") ? glob.slice(1) : glob;
    const error = validateGlob(globToValidate);
    if (error) {
      return { stdout: "", stderr: `${error}\n`, exitCode: 1 };
    }
  }

  // Handle --files mode: list files without searching
  // In --files mode, positional args (including what would be the pattern) are paths
  if (options.files) {
    const filesPaths = [...options.patterns, ...inputPaths];
    return listFiles(ctx, filesPaths, options);
  }

  // Combine -e patterns with patterns from files
  const patterns = [...options.patterns];

  // Read patterns from files (-f/--file)
  for (const patternFile of options.patternFiles) {
    try {
      let content: string;
      if (patternFile === "-") {
        // Read from stdin
        content = ctx.stdin;
      } else {
        const filePath = ctx.fs.resolvePath(ctx.cwd, patternFile);
        content = await ctx.fs.readFile(filePath);
      }
      const filePatterns = content
        .split("\n")
        .filter((line) => line.length > 0);
      patterns.push(...filePatterns);
    } catch {
      return {
        stdout: "",
        stderr: `rg: ${patternFile}: No such file or directory\n`,
        exitCode: 2
      };
    }
  }

  if (patterns.length === 0) {
    // If patterns came from files but all were empty, return no-match (exit 1)
    // Otherwise return error for no pattern given (exit 2)
    if (options.patternFiles.length > 0) {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    return {
      stdout: "",
      stderr: "rg: no pattern given\n",
      exitCode: 2
    };
  }

  // Default to current directory
  const paths = inputPaths.length === 0 ? ["."] : inputPaths;

  // Determine case sensitivity
  const effectiveIgnoreCase = determineIgnoreCase(options, patterns);

  // Build regex
  let regex: UserRegex;
  let kResetGroup: number | undefined;
  try {
    const regexResult = buildSearchRegex(
      patterns,
      options,
      effectiveIgnoreCase
    );
    regex = regexResult.regex;
    kResetGroup = regexResult.kResetGroup;
  } catch {
    return {
      stdout: "",
      stderr: `rg: invalid regex: ${patterns.join(", ")}\n`,
      exitCode: 2
    };
  }

  // Load gitignore files
  let gitignore: GitignoreManager | null = null;
  if (!options.noIgnore) {
    gitignore = await loadGitignores(
      ctx.fs,
      ctx.cwd,
      options.noIgnoreDot,
      options.noIgnoreVcs,
      options.ignoreFiles
    );
  }

  // Create file type registry and apply --type-clear and --type-add
  const typeRegistry = new FileTypeRegistry();
  for (const name of options.typeClear) {
    typeRegistry.clearType(name);
  }
  for (const spec of options.typeAdd) {
    typeRegistry.addType(spec);
  }

  // Collect files to search
  const { files, singleExplicitFile } = await collectFiles(
    ctx,
    paths,
    options,
    gitignore,
    typeRegistry
  );

  if (files.length === 0) {
    return { stdout: "", stderr: "", exitCode: 1 };
  }

  // Determine output settings
  const showFilename =
    !options.noFilename &&
    (options.withFilename || !singleExplicitFile || files.length > 1);

  let effectiveLineNumbers = options.lineNumber;
  if (!explicitLineNumbers) {
    if (singleExplicitFile && files.length === 1) {
      effectiveLineNumbers = false;
    }
    if (options.onlyMatching) {
      effectiveLineNumbers = false;
    }
  }

  // Search files
  return searchFiles(
    ctx,
    files,
    regex,
    options,
    showFilename,
    effectiveLineNumbers,
    kResetGroup
  );
}

/**
 * Determine effective case sensitivity based on options
 */
function determineIgnoreCase(options: RgOptions, patterns: string[]): boolean {
  if (options.caseSensitive) {
    return false;
  }
  if (options.ignoreCase) {
    return true;
  }
  if (options.smartCase) {
    return !patterns.some((p) => /[A-Z]/.test(p));
  }
  return false;
}

/**
 * Build the search regex from patterns
 */
function buildSearchRegex(
  patterns: string[],
  options: RgOptions,
  ignoreCase: boolean
): RegexResult {
  let combinedPattern: string;
  if (patterns.length === 1) {
    combinedPattern = patterns[0];
  } else {
    combinedPattern = patterns
      .map((p) =>
        options.fixedStrings
          ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          : `(?:${p})`
      )
      .join("|");
  }

  return buildRegex(combinedPattern, {
    mode: options.fixedStrings && patterns.length === 1 ? "fixed" : "perl",
    ignoreCase,
    wholeWord: options.wordRegexp,
    lineRegexp: options.lineRegexp,
    multiline: options.multiline,
    multilineDotall: options.multilineDotall
  });
}

interface CollectFilesResult {
  files: string[];
  singleExplicitFile: boolean;
}

/**
 * Collect files to search based on paths and options
 */
async function collectFiles(
  ctx: CommandContext,
  paths: string[],
  options: RgOptions,
  gitignore: GitignoreManager | null,
  typeRegistry: FileTypeRegistry
): Promise<CollectFilesResult> {
  const files: string[] = [];
  let explicitFileCount = 0;
  let directoryCount = 0;

  for (const path of paths) {
    const fullPath = ctx.fs.resolvePath(ctx.cwd, path);

    try {
      const stat = await ctx.fs.stat(fullPath);

      if (stat.isFile) {
        explicitFileCount++;
        // Check max filesize
        if (options.maxFilesize > 0 && stat.size > options.maxFilesize) {
          continue;
        }
        if (
          shouldIncludeFile(path, options, gitignore, fullPath, typeRegistry)
        ) {
          files.push(path);
        }
      } else if (stat.isDirectory) {
        directoryCount++;
        await walkDirectory(
          ctx,
          path,
          fullPath,
          0,
          options,
          gitignore,
          typeRegistry,
          files
        );
      }
    } catch {
      // Path doesn't exist - skip silently
    }
  }

  const sortedFiles = options.sort === "path" ? files.sort() : files;

  return {
    files: sortedFiles,
    singleExplicitFile: explicitFileCount === 1 && directoryCount === 0
  };
}

/**
 * Recursively walk a directory and collect matching files
 */
async function walkDirectory(
  ctx: CommandContext,
  relativePath: string,
  absolutePath: string,
  depth: number,
  options: RgOptions,
  gitignore: GitignoreManager | null,
  typeRegistry: FileTypeRegistry,
  files: string[]
): Promise<void> {
  if (depth >= options.maxDepth) {
    return;
  }

  // Load ignore files for this directory (per-directory ignore loading)
  if (gitignore) {
    await gitignore.loadForDirectory(absolutePath);
  }

  try {
    const entries = ctx.fs.readdirWithFileTypes
      ? await ctx.fs.readdirWithFileTypes(absolutePath)
      : (await ctx.fs.readdir(absolutePath)).map((name) => ({
          name,
          isFile: undefined as boolean | undefined
        }));

    for (const entry of entries) {
      const name = entry.name;

      // Skip common ignored directories (VCS, node_modules, etc.)
      if (!options.noIgnore && GitignoreManager.isCommonIgnored(name)) {
        continue;
      }

      // Hidden file check is done after gitignore to allow negation patterns
      // to whitelist specific hidden files (e.g., "!.foo" in .gitignore)
      const isHidden = name.startsWith(".");

      const entryRelativePath =
        relativePath === "."
          ? name
          : relativePath === "./"
            ? `./${name}`
            : relativePath.endsWith("/")
              ? `${relativePath}${name}`
              : `${relativePath}/${name}`;
      const entryAbsolutePath = ctx.fs.resolvePath(absolutePath, name);

      let isFile: boolean;
      let isDirectory: boolean;
      let isSymlink = false;

      // Check if entry has type info from readdirWithFileTypes
      const hasTypeInfo = entry.isFile !== undefined && "isDirectory" in entry;

      if (hasTypeInfo) {
        // Use type info from readdirWithFileTypes
        const dirent = entry as {
          name: string;
          isFile: boolean;
          isDirectory: boolean;
          isSymbolicLink?: boolean;
        };
        isSymlink = dirent.isSymbolicLink === true;

        if (isSymlink && !options.followSymlinks) {
          continue; // Skip symlinks unless -L is specified
        }

        if (isSymlink && options.followSymlinks) {
          // For symlinks with -L, stat the target to get actual type
          try {
            const stat = await ctx.fs.stat(entryAbsolutePath);
            isFile = stat.isFile;
            isDirectory = stat.isDirectory;
          } catch {
            continue; // Broken symlink, skip
          }
        } else {
          isFile = dirent.isFile;
          isDirectory = dirent.isDirectory;
        }
      } else {
        try {
          // Use lstat to detect symlinks
          const lstat = ctx.fs.lstat
            ? await ctx.fs.lstat(entryAbsolutePath)
            : await ctx.fs.stat(entryAbsolutePath);
          isSymlink = lstat.isSymbolicLink === true;

          if (isSymlink && !options.followSymlinks) {
            continue; // Skip symlinks unless -L is specified
          }

          // For symlinks with -L, stat the target
          const stat =
            isSymlink && options.followSymlinks
              ? await ctx.fs.stat(entryAbsolutePath)
              : lstat;
          isFile = stat.isFile;
          isDirectory = stat.isDirectory;
        } catch {
          continue;
        }
      }

      // Check gitignore patterns first
      const gitignoreIgnored = gitignore?.matches(
        entryAbsolutePath,
        isDirectory
      );
      if (gitignoreIgnored) {
        continue;
      }

      // Skip hidden files unless:
      // - --hidden is set, OR
      // - gitignore explicitly whitelists this file with a negation pattern (e.g., "!.foo")
      if (isHidden && !options.hidden) {
        const isWhitelisted = gitignore?.isWhitelisted(
          entryAbsolutePath,
          isDirectory
        );
        if (!isWhitelisted) {
          continue;
        }
      }

      if (isDirectory) {
        await walkDirectory(
          ctx,
          entryRelativePath,
          entryAbsolutePath,
          depth + 1,
          options,
          gitignore,
          typeRegistry,
          files
        );
      } else if (isFile) {
        // Check max filesize
        if (options.maxFilesize > 0) {
          try {
            const fileStat = await ctx.fs.stat(entryAbsolutePath);
            if (fileStat.size > options.maxFilesize) {
              continue;
            }
          } catch {
            continue;
          }
        }
        if (
          shouldIncludeFile(
            entryRelativePath,
            options,
            gitignore,
            entryAbsolutePath,
            typeRegistry
          )
        ) {
          files.push(entryRelativePath);
        }
      }
    }
  } catch {
    // Directory read failed - skip
  }
}

/**
 * Check if a file should be included based on filters
 */
function shouldIncludeFile(
  relativePath: string,
  options: RgOptions,
  gitignore: GitignoreManager | null,
  absolutePath: string,
  typeRegistry: FileTypeRegistry
): boolean {
  const filename = relativePath.split("/").pop() || relativePath;

  if (gitignore?.matches(absolutePath, false)) {
    return false;
  }

  if (
    options.types.length > 0 &&
    !typeRegistry.matchesType(filename, options.types)
  ) {
    return false;
  }

  if (
    options.typesNot.length > 0 &&
    typeRegistry.matchesType(filename, options.typesNot)
  ) {
    return false;
  }

  if (options.globs.length > 0) {
    const ignoreCase = options.globCaseInsensitive;
    const positiveGlobs = options.globs.filter((g) => !g.startsWith("!"));
    const negativeGlobs = options.globs
      .filter((g) => g.startsWith("!"))
      .map((g) => g.slice(1));

    if (positiveGlobs.length > 0) {
      let matchesPositive = false;
      for (const glob of positiveGlobs) {
        if (
          matchGlob(filename, glob, ignoreCase) ||
          matchGlob(relativePath, glob, ignoreCase)
        ) {
          matchesPositive = true;
          break;
        }
      }
      if (!matchesPositive) {
        return false;
      }
    }

    for (const glob of negativeGlobs) {
      if (glob.startsWith("/")) {
        const rootedGlob = glob.slice(1);
        if (matchGlob(relativePath, rootedGlob, ignoreCase)) {
          return false;
        }
      } else if (
        matchGlob(filename, glob, ignoreCase) ||
        matchGlob(relativePath, glob, ignoreCase)
      ) {
        return false;
      }
    }
  }

  // Handle iglobs (case-insensitive globs)
  if (options.iglobs.length > 0) {
    const positiveIglobs = options.iglobs.filter((g) => !g.startsWith("!"));
    const negativeIglobs = options.iglobs
      .filter((g) => g.startsWith("!"))
      .map((g) => g.slice(1));

    if (positiveIglobs.length > 0) {
      let matchesPositive = false;
      for (const glob of positiveIglobs) {
        if (
          matchGlob(filename, glob, true) ||
          matchGlob(relativePath, glob, true)
        ) {
          matchesPositive = true;
          break;
        }
      }
      if (!matchesPositive) {
        return false;
      }
    }

    for (const glob of negativeIglobs) {
      if (glob.startsWith("/")) {
        const rootedGlob = glob.slice(1);
        if (matchGlob(relativePath, rootedGlob, true)) {
          return false;
        }
      } else if (
        matchGlob(filename, glob, true) ||
        matchGlob(relativePath, glob, true)
      ) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Simple glob matching
 */
function matchGlob(str: string, pattern: string, ignoreCase = false): boolean {
  let regexStr = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        regexStr += ".*";
        i++;
      } else {
        regexStr += "[^/]*";
      }
    } else if (char === "?") {
      regexStr += "[^/]";
    } else if (char === "[") {
      let j = i + 1;
      if (j < pattern.length && pattern[j] === "!") j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j < pattern.length) {
        let charClass = pattern.slice(i, j + 1);
        if (charClass.startsWith("[!")) {
          charClass = `[^${charClass.slice(2)}`;
        }
        regexStr += charClass;
        i = j;
      } else {
        regexStr += "\\[";
      }
    } else {
      regexStr += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  regexStr += "$";

  return createUserRegex(regexStr, ignoreCase ? "i" : "").test(str);
}

/**
 * List files that would be searched (--files mode)
 */
async function listFiles(
  ctx: CommandContext,
  inputPaths: string[],
  options: RgOptions
): Promise<ExecResult> {
  // Load gitignore files
  let gitignore: GitignoreManager | null = null;
  if (!options.noIgnore) {
    gitignore = await loadGitignores(
      ctx.fs,
      ctx.cwd,
      options.noIgnoreDot,
      options.noIgnoreVcs,
      options.ignoreFiles
    );
  }

  // Create file type registry and apply --type-clear and --type-add
  const typeRegistry = new FileTypeRegistry();
  for (const name of options.typeClear) {
    typeRegistry.clearType(name);
  }
  for (const spec of options.typeAdd) {
    typeRegistry.addType(spec);
  }

  // Default to current directory
  const paths = inputPaths.length === 0 ? ["."] : inputPaths;

  // Collect files
  const { files } = await collectFiles(
    ctx,
    paths,
    options,
    gitignore,
    typeRegistry
  );

  if (files.length === 0) {
    return { stdout: "", stderr: "", exitCode: 1 };
  }

  // In quiet mode, just indicate success without output
  if (options.quiet) {
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  // Output file list
  const sep = options.nullSeparator ? "\0" : "\n";
  const stdout = files.map((f) => f + sep).join("");

  return { stdout, stderr: "", exitCode: 0 };
}

/**
 * Check if a file matches any pre-glob patterns
 */
function matchesPreGlob(filename: string, preGlobs: string[]): boolean {
  if (preGlobs.length === 0) return true; // No patterns = match all

  for (const glob of preGlobs) {
    if (matchGlob(filename, glob, false)) {
      return true;
    }
  }
  return false;
}

/**
 * Read file content, handling preprocessing and gzip decompression if needed
 */
async function readFileContent(
  ctx: CommandContext,
  filePath: string,
  file: string,
  options: RgOptions
): Promise<{ content: string; isBinary: boolean } | null> {
  try {
    // Check for preprocessing with --pre
    if (options.preprocessor && ctx.exec) {
      const filename = file.split("/").pop() || file;
      if (matchesPreGlob(filename, options.preprocessorGlobs)) {
        // Run preprocessor on this file
        const result = await ctx.exec(shellJoinArgs([options.preprocessor]), {
          cwd: ctx.cwd,
          signal: ctx.signal,
          args: [filePath]
        });
        if (result.exitCode === 0 && result.stdout) {
          const sample = result.stdout.slice(0, 8192);
          return { content: result.stdout, isBinary: sample.includes("\0") };
        }
        // Preprocessing failed, fall through to normal file read
      }
    }

    // For -z option, try to decompress gzip files
    if (options.searchZip && file.endsWith(".gz")) {
      const buffer = await ctx.fs.readFileBuffer(filePath);
      if (isGzip(buffer)) {
        try {
          const decompressed = gunzipSync(buffer);
          const content = new TextDecoder().decode(decompressed);
          const sample = content.slice(0, 8192);
          return { content, isBinary: sample.includes("\0") };
        } catch {
          return null; // Decompression failed
        }
      }
    }

    // Regular file read
    const content = await ctx.fs.readFile(filePath);
    const sample = content.slice(0, 8192);
    return { content, isBinary: sample.includes("\0") };
  } catch {
    return null;
  }
}

/**
 * Format a single match for JSON output
 */
interface JsonSubmatch {
  match: { text: string };
  start: number;
  end: number;
  replacement?: { text: string };
}

interface JsonMatch {
  type: "match";
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    absolute_offset: number;
    submatches: JsonSubmatch[];
  };
}

/**
 * Search files and produce output
 */
async function searchFiles(
  ctx: CommandContext,
  files: string[],
  regex: UserRegex,
  options: RgOptions,
  showFilename: boolean,
  effectiveLineNumbers: boolean,
  kResetGroup?: number
): Promise<ExecResult> {
  let stdout = "";
  let anyMatch = false;

  // JSON mode tracking
  const jsonMessages: string[] = [];
  let totalMatches = 0;
  let filesWithMatch = 0;
  let bytesSearched = 0;

  const BATCH_SIZE = 50;
  outer: for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (file) => {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const fileData = await readFileContent(ctx, filePath, file, options);

        if (!fileData) return null;

        const { content, isBinary } = fileData;
        bytesSearched += content.length;

        // Skip binary files unless -a/--text is specified
        if (isBinary && !options.searchBinary) {
          return null;
        }

        const filenameForSearch = showFilename && !options.heading ? file : "";

        const result = searchContent(content, regex, {
          invertMatch: options.invertMatch,
          showLineNumbers: effectiveLineNumbers,
          countOnly: options.count,
          countMatches: options.countMatches,
          filename: filenameForSearch,
          onlyMatching: options.onlyMatching,
          beforeContext: options.beforeContext,
          afterContext: options.afterContext,
          maxCount: options.maxCount,
          contextSeparator: options.contextSeparator,
          showColumn: options.column,
          vimgrep: options.vimgrep,
          showByteOffset: options.byteOffset,
          replace:
            options.replace !== null
              ? convertReplacement(options.replace)
              : null,
          passthru: options.passthru,
          multiline: options.multiline,
          kResetGroup
        });

        // For JSON mode, we need to track matches differently
        if (options.json && result.matched) {
          return { file, result, content, isBinary: false };
        }

        return { file, result };
      })
    );

    for (const res of results) {
      if (!res) continue;

      const { file, result } = res;

      if (result.matched) {
        anyMatch = true;
        filesWithMatch++;
        totalMatches += result.matchCount;

        if (options.quiet && !options.json) {
          // Quiet mode without JSON: exit early on first match
          break outer;
        }

        if (options.json && !options.quiet) {
          // JSON mode without quiet: output begin/match/end messages
          const content = (res as { content?: string }).content || "";
          jsonMessages.push(
            JSON.stringify({ type: "begin", data: { path: { text: file } } })
          );

          // Find matches and output them
          const lines = content.split("\n");
          regex.lastIndex = 0;
          let lineOffset = 0;
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];
            regex.lastIndex = 0;
            const submatches: JsonSubmatch[] = [];

            for (
              let match = regex.exec(line);
              match !== null;
              match = regex.exec(line)
            ) {
              const submatch: JsonSubmatch = {
                match: { text: match[0] },
                start: match.index,
                end: match.index + match[0].length
              };
              if (options.replace !== null) {
                submatch.replacement = { text: options.replace };
              }
              submatches.push(submatch);
              if (match[0].length === 0) regex.lastIndex++;
            }

            if (submatches.length > 0) {
              const matchMsg: JsonMatch = {
                type: "match",
                data: {
                  path: { text: file },
                  lines: { text: `${line}\n` },
                  line_number: lineIdx + 1,
                  absolute_offset: lineOffset,
                  submatches
                }
              };
              jsonMessages.push(JSON.stringify(matchMsg));
            }
            lineOffset += line.length + 1;
          }

          jsonMessages.push(
            JSON.stringify({
              type: "end",
              data: {
                path: { text: file },
                binary_offset: null,
                stats: {
                  elapsed: { secs: 0, nanos: 0, human: "0s" },
                  searches: 1,
                  searches_with_match: 1,
                  bytes_searched: content.length,
                  bytes_printed: 0,
                  matched_lines: result.matchCount,
                  matches: result.matchCount
                }
              }
            })
          );
        } else if (options.filesWithMatches) {
          const sep = options.nullSeparator ? "\0" : "\n";
          stdout += `${file}${sep}`;
        } else if (!options.filesWithoutMatch) {
          // In heading mode, always show filename header (even for single files)
          if (options.heading && !options.noFilename) {
            stdout += `${file}\n`;
          }
          stdout += result.output;
        }
      } else if (options.filesWithoutMatch) {
        const sep = options.nullSeparator ? "\0" : "\n";
        stdout += `${file}${sep}`;
      } else if (
        options.includeZero &&
        (options.count || options.countMatches)
      ) {
        stdout += result.output;
      }
    }
  }

  // Finalize JSON output
  if (options.json) {
    jsonMessages.push(
      JSON.stringify({
        type: "summary",
        data: {
          elapsed_total: { secs: 0, nanos: 0, human: "0s" },
          stats: {
            elapsed: { secs: 0, nanos: 0, human: "0s" },
            searches: files.length,
            searches_with_match: filesWithMatch,
            bytes_searched: bytesSearched,
            bytes_printed: 0,
            matched_lines: totalMatches,
            matches: totalMatches
          }
        }
      })
    );
    stdout = `${jsonMessages.join("\n")}\n`;
  }

  // In JSON + quiet mode, output only the summary (already built above)
  // In non-JSON quiet mode, output nothing
  let finalStdout = options.quiet && !options.json ? "" : stdout;

  // Add stats output if requested
  if (options.stats && !options.json) {
    const statsOutput = [
      "",
      `${totalMatches} matches`,
      `${totalMatches} matched lines`,
      `${filesWithMatch} files contained matches`,
      `${files.length} files searched`,
      `${bytesSearched} bytes searched`
    ].join("\n");
    finalStdout += `${statsOutput}\n`;
  }

  // Exit codes:
  // - For --files-without-match: 0 if files without matches found, 1 otherwise
  // - For normal mode: 0 if any matches found, 1 otherwise
  let exitCode: number;
  if (options.filesWithoutMatch) {
    // Success means we found files without matches (stdout has content)
    exitCode = stdout.length > 0 ? 0 : 1;
  } else {
    exitCode = anyMatch ? 0 : 1;
  }

  return {
    stdout: finalStdout,
    stderr: "",
    exitCode
  };
}
