import type { UserRegex } from "../../regex/index";
import type { Command, CommandContext, ExecResult } from "../../types";
import { matchGlob } from "../../utils/glob";
import { hasHelpFlag, showHelp, unknownOption } from "../help";
import { buildRegex, searchContent } from "../search-engine/index";

/** File entry with optional type info from glob expansion */
interface FileEntry {
  path: string;
  isFile?: boolean; // undefined means we need to stat
}

const grepHelp = {
  name: "grep",
  summary: "print lines that match patterns",
  usage: "grep [OPTION]... PATTERN [FILE]...",
  options: [
    "-E, --extended-regexp    PATTERN is an extended regular expression",
    "-P, --perl-regexp        PATTERN is a Perl regular expression",
    "-F, --fixed-strings      PATTERN is a set of newline-separated strings",
    "-i, --ignore-case        ignore case distinctions",
    "-v, --invert-match       select non-matching lines",
    "-w, --word-regexp        match only whole words",
    "-x, --line-regexp        match only whole lines",
    "-c, --count              print only a count of matching lines",
    "-l, --files-with-matches print only names of files with matches",
    "-L, --files-without-match print names of files with no matches",
    "-m NUM, --max-count=NUM  stop after NUM matches",
    "-n, --line-number        print line number with output lines",
    "-h, --no-filename        suppress the file name prefix on output",
    "-o, --only-matching      show only nonempty parts of lines that match",
    "-q, --quiet, --silent    suppress all normal output",
    "-r, -R, --recursive      search directories recursively",
    "-A NUM                   print NUM lines of trailing context",
    "-B NUM                   print NUM lines of leading context",
    "-C NUM                   print NUM lines of context",
    "-e PATTERN               use PATTERN for matching",
    "    --include=GLOB       search only files matching GLOB",
    "    --exclude=GLOB       skip files matching GLOB",
    "    --exclude-dir=DIR    skip directories matching DIR",
    "    --help               display this help and exit"
  ]
};

export const grepCommand: Command = {
  name: "grep",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(grepHelp);
    }

    let ignoreCase = false;
    let showLineNumbers = false;
    let invertMatch = false;
    let countOnly = false;
    let filesWithMatches = false;
    let filesWithoutMatch = false;
    let recursive = false;
    let wholeWord = false;
    let lineRegexp = false;
    let extendedRegex = false;
    let perlRegex = false;
    let fixedStrings = false;
    let onlyMatching = false;
    let noFilename = false;
    let quietMode = false;
    let maxCount = 0; // 0 means unlimited
    let beforeContext = 0;
    let afterContext = 0;
    const includePatterns: string[] = [];
    const excludePatterns: string[] = [];
    const excludeDirPatterns: string[] = [];
    let pattern: string | null = null;
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg.startsWith("-") && arg !== "-") {
        if (arg === "-e" && i + 1 < args.length) {
          pattern = args[++i];
          continue;
        }

        // Handle --include=pattern (can be specified multiple times)
        if (arg.startsWith("--include=")) {
          includePatterns.push(arg.slice("--include=".length));
          continue;
        }

        // Handle --exclude=pattern (can be specified multiple times)
        if (arg.startsWith("--exclude=")) {
          excludePatterns.push(arg.slice("--exclude=".length));
          continue;
        }

        // Handle --exclude-dir=pattern (can be specified multiple times)
        if (arg.startsWith("--exclude-dir=")) {
          excludeDirPatterns.push(arg.slice("--exclude-dir=".length));
          continue;
        }

        // Handle --max-count=N
        if (arg.startsWith("--max-count=")) {
          maxCount = parseInt(arg.slice("--max-count=".length), 10);
          continue;
        }

        // Handle -m N or -mN
        const maxCountMatch = arg.match(/^-m(\d+)$/);
        if (maxCountMatch) {
          maxCount = parseInt(maxCountMatch[1], 10);
          continue;
        }
        if (arg === "-m" && i + 1 < args.length) {
          maxCount = parseInt(args[++i], 10);
          continue;
        }

        // Handle -A, -B, -C with numbers
        const contextMatch = arg.match(/^-([ABC])(\d+)$/);
        if (contextMatch) {
          const num = parseInt(contextMatch[2], 10);
          if (contextMatch[1] === "A") afterContext = num;
          else if (contextMatch[1] === "B") beforeContext = num;
          else if (contextMatch[1] === "C") {
            beforeContext = num;
            afterContext = num;
          }
          continue;
        }

        // Handle -A n, -B n, -C n
        if (
          (arg === "-A" || arg === "-B" || arg === "-C") &&
          i + 1 < args.length
        ) {
          const num = parseInt(args[++i], 10);
          if (arg === "-A") afterContext = num;
          else if (arg === "-B") beforeContext = num;
          else {
            beforeContext = num;
            afterContext = num;
          }
          continue;
        }

        const flags = arg.startsWith("--") ? [arg] : arg.slice(1).split("");

        for (const flag of flags) {
          if (flag === "i" || flag === "--ignore-case") ignoreCase = true;
          else if (flag === "n" || flag === "--line-number")
            showLineNumbers = true;
          else if (flag === "v" || flag === "--invert-match")
            invertMatch = true;
          else if (flag === "c" || flag === "--count") countOnly = true;
          else if (flag === "l" || flag === "--files-with-matches")
            filesWithMatches = true;
          else if (flag === "L" || flag === "--files-without-match")
            filesWithoutMatch = true;
          else if (flag === "r" || flag === "R" || flag === "--recursive")
            recursive = true;
          else if (flag === "w" || flag === "--word-regexp") wholeWord = true;
          else if (flag === "x" || flag === "--line-regexp") lineRegexp = true;
          else if (flag === "E" || flag === "--extended-regexp")
            extendedRegex = true;
          else if (flag === "P" || flag === "--perl-regexp") perlRegex = true;
          else if (flag === "F" || flag === "--fixed-strings")
            fixedStrings = true;
          else if (flag === "o" || flag === "--only-matching")
            onlyMatching = true;
          else if (flag === "h" || flag === "--no-filename") noFilename = true;
          else if (flag === "q" || flag === "--quiet" || flag === "--silent")
            quietMode = true;
          else if (flag.startsWith("--")) {
            return unknownOption("grep", flag);
          } else if (flag.length === 1) {
            return unknownOption("grep", `-${flag}`);
          }
        }
      } else if (pattern === null) {
        pattern = arg;
      } else {
        files.push(arg);
      }
    }

    if (pattern === null) {
      return {
        stdout: "",
        stderr: "grep: missing pattern\n",
        exitCode: 2
      };
    }

    // Build regex using shared search-engine
    const regexMode = fixedStrings
      ? "fixed"
      : extendedRegex
        ? "extended"
        : perlRegex
          ? "perl"
          : "basic";

    let regex: UserRegex;
    let kResetGroup: number | undefined;
    try {
      const regexResult = buildRegex(pattern, {
        mode: regexMode,
        ignoreCase,
        wholeWord,
        lineRegexp
      });
      regex = regexResult.regex;
      kResetGroup = regexResult.kResetGroup;
    } catch {
      return {
        stdout: "",
        stderr: `grep: invalid regular expression: ${pattern}\n`,
        exitCode: 2
      };
    }

    // If no files and stdin is provided (including empty string), read from stdin
    if (files.length === 0 && ctx.stdin !== undefined) {
      const result = searchContent(ctx.stdin, regex, {
        invertMatch,
        showLineNumbers,
        countOnly,
        filename: "",
        onlyMatching,
        beforeContext,
        afterContext,
        maxCount,
        kResetGroup
      });
      if (quietMode) {
        return { stdout: "", stderr: "", exitCode: result.matched ? 0 : 1 };
      }
      return {
        stdout: result.output,
        stderr: "",
        exitCode: result.matched ? 0 : 1
      };
    }

    if (files.length === 0) {
      return {
        stdout: "",
        stderr: "grep: no input files\n",
        exitCode: 2
      };
    }

    let stdout = "";
    let stderr = "";
    let anyMatch = false;
    let anyError = false;

    // Collect all files to search (expand globs first)
    // FileEntry includes type info when available to skip stat calls
    const filesToSearch: FileEntry[] = [];
    for (const file of files) {
      // Check if this is a glob pattern
      if (file.includes("*") || file.includes("?") || file.includes("[")) {
        const expanded = await expandGlobPatternWithTypes(file, ctx);
        if (recursive) {
          for (const f of expanded) {
            const recursiveExpanded = await expandRecursiveWithTypes(
              f.path,
              ctx,
              includePatterns,
              excludePatterns,
              excludeDirPatterns,
              f.isFile
            );
            filesToSearch.push(...recursiveExpanded);
          }
        } else {
          filesToSearch.push(...expanded);
        }
      } else if (recursive) {
        const expanded = await expandRecursiveWithTypes(
          file,
          ctx,
          includePatterns,
          excludePatterns,
          excludeDirPatterns
        );
        filesToSearch.push(...expanded);
      } else {
        filesToSearch.push({ path: file });
      }
    }

    // Determine if we should show filename (after glob expansion)
    const showFilename = (filesToSearch.length > 1 || recursive) && !noFilename;

    // Process files in parallel batches for better performance
    const BATCH_SIZE = 50;
    for (let i = 0; i < filesToSearch.length; i += BATCH_SIZE) {
      const batch = filesToSearch.slice(i, i + BATCH_SIZE);

      // Process batch in parallel
      const results = await Promise.all(
        batch.map(async (fileEntry) => {
          const file = fileEntry.path;
          const basename = file.split("/").pop() || file;

          // Check exclude patterns for non-recursive case
          if (excludePatterns.length > 0 && !recursive) {
            if (
              excludePatterns.some((p) =>
                matchGlob(basename, p, { stripQuotes: true })
              )
            ) {
              return null;
            }
          }

          // Check include patterns for non-recursive case
          if (includePatterns.length > 0 && !recursive) {
            if (
              !includePatterns.some((p) =>
                matchGlob(basename, p, { stripQuotes: true })
              )
            ) {
              return null;
            }
          }

          try {
            const filePath = ctx.fs.resolvePath(ctx.cwd, file);

            // Skip stat if we already know it's a file from glob expansion
            let isDirectory = false;
            if (fileEntry.isFile === undefined) {
              const stat = await ctx.fs.stat(filePath);
              isDirectory = stat.isDirectory;
            } else {
              isDirectory = !fileEntry.isFile;
            }

            if (isDirectory) {
              if (!recursive) {
                return { error: `grep: ${file}: Is a directory\n` };
              }
              return null;
            }

            const content = await ctx.fs.readFile(filePath);
            const result = searchContent(content, regex, {
              invertMatch,
              showLineNumbers,
              countOnly,
              filename: showFilename ? file : "",
              onlyMatching,
              beforeContext,
              afterContext,
              maxCount,
              kResetGroup
            });

            return { file, result };
          } catch {
            return { error: `grep: ${file}: No such file or directory\n` };
          }
        })
      );

      // Process results from batch
      for (const res of results) {
        if (res === null) continue;

        if ("error" in res && res.error) {
          stderr += res.error;
          if (!res.error.includes("Is a directory")) {
            anyError = true;
          }
          continue;
        }

        if (!("file" in res) || !res.result) continue;

        const { file, result } = res;
        if (result.matched) {
          anyMatch = true;
          if (quietMode) {
            // In quiet mode, exit immediately on first match
            return { stdout: "", stderr: "", exitCode: 0 };
          }
          if (filesWithMatches) {
            stdout += `${file}\n`;
          } else if (!filesWithoutMatch) {
            stdout += result.output;
          }
        } else {
          // No match in this file
          if (filesWithoutMatch) {
            stdout += `${file}\n`;
          } else if (countOnly && !filesWithMatches) {
            stdout += result.output;
          }
        }
      }
    }

    // Exit codes: 0 = match found (or files without match for -L), 1 = no match, 2 = error
    // For -L, success means we found files without matches (stdout has content)
    let exitCode: number;
    if (anyError) {
      exitCode = 2;
    } else if (filesWithoutMatch) {
      exitCode = stdout.length > 0 ? 0 : 1;
    } else {
      exitCode = anyMatch ? 0 : 1;
    }

    if (quietMode) {
      return { stdout: "", stderr: "", exitCode };
    }

    return {
      stdout,
      stderr,
      exitCode
    };
  }
};

/** Safety limit to prevent stack overflow on deeply nested directories */
const MAX_GREP_DEPTH = 256;

async function expandRecursiveGlob(
  baseDir: string,
  afterGlob: string,
  ctx: CommandContext,
  result: string[],
  depth = 0
): Promise<void> {
  if (depth >= MAX_GREP_DEPTH) return;
  const fullBasePath = ctx.fs.resolvePath(ctx.cwd, baseDir);

  try {
    const stat = await ctx.fs.stat(fullBasePath);

    if (!stat.isDirectory) {
      // Check if the file matches afterGlob pattern
      const filename = baseDir.split("/").pop() || "";
      if (afterGlob) {
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(filename, pattern, { stripQuotes: true })) {
          result.push(baseDir);
        }
      }
      return;
    }

    // Check files in current directory
    const entries = await ctx.fs.readdir(fullBasePath);
    for (const entry of entries) {
      const entryPath = baseDir === "." ? entry : `${baseDir}/${entry}`;
      const fullEntryPath = ctx.fs.resolvePath(ctx.cwd, entryPath);
      const entryStat = await ctx.fs.stat(fullEntryPath);

      if (entryStat.isDirectory) {
        // Recurse into directory
        await expandRecursiveGlob(entryPath, afterGlob, ctx, result, depth + 1);
      } else if (afterGlob) {
        // Check if file matches afterGlob pattern
        const pattern = afterGlob.replace(/^\//, "");
        if (matchGlob(entry, pattern, { stripQuotes: true })) {
          result.push(entryPath);
        }
      }
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Optimized glob expansion that returns FileEntry with type info
 * Uses readdirWithFileTypes when available to avoid stat calls
 */
async function expandGlobPatternWithTypes(
  pattern: string,
  ctx: CommandContext
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];

  // Find the directory part and the glob part
  const lastSlash = pattern.lastIndexOf("/");
  let dirPath: string;
  let globPart: string;

  if (lastSlash === -1) {
    dirPath = ctx.cwd;
    globPart = pattern;
  } else {
    dirPath = pattern.slice(0, lastSlash) || "/";
    globPart = pattern.slice(lastSlash + 1);
  }

  // Handle ** (recursive glob) - fall back to old method
  if (pattern.includes("**")) {
    const oldResult: string[] = [];
    const parts = pattern.split("**");
    const baseDir = parts[0].replace(/\/$/, "") || ".";
    const afterGlob = parts[1] || "";
    await expandRecursiveGlob(baseDir, afterGlob, ctx, oldResult);
    return oldResult.map((p) => ({ path: p }));
  }

  // Resolve the directory path
  const fullDirPath = ctx.fs.resolvePath(ctx.cwd, dirPath);

  try {
    // Use readdirWithFileTypes if available for better performance
    if (ctx.fs.readdirWithFileTypes) {
      const entries = await ctx.fs.readdirWithFileTypes(fullDirPath);
      for (const entry of entries) {
        if (matchGlob(entry.name, globPart, { stripQuotes: true })) {
          const fullPath =
            lastSlash === -1 ? entry.name : `${dirPath}/${entry.name}`;
          result.push({
            path: fullPath,
            isFile: entry.isFile
          });
        }
      }
    } else {
      // Fall back to regular readdir
      const entries = await ctx.fs.readdir(fullDirPath);
      for (const entry of entries) {
        if (matchGlob(entry, globPart, { stripQuotes: true })) {
          const fullPath = lastSlash === -1 ? entry : `${dirPath}/${entry}`;
          result.push({ path: fullPath });
        }
      }
    }
  } catch {
    // Directory doesn't exist - return empty
  }

  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Optimized recursive expansion that returns FileEntry with type info
 * Uses readdirWithFileTypes when available to avoid stat calls
 */
async function expandRecursiveWithTypes(
  path: string,
  ctx: CommandContext,
  includePatterns: string[] = [],
  excludePatterns: string[] = [],
  excludeDirPatterns: string[] = [],
  knownIsFile?: boolean,
  depth = 0
): Promise<FileEntry[]> {
  if (depth >= MAX_GREP_DEPTH) return [];
  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
  const result: FileEntry[] = [];

  try {
    // Determine if it's a file or directory
    let isFile: boolean;
    let isDirectory: boolean;

    if (knownIsFile !== undefined) {
      isFile = knownIsFile;
      isDirectory = !knownIsFile;
    } else {
      const stat = await ctx.fs.stat(fullPath);
      isFile = stat.isFile;
      isDirectory = stat.isDirectory;
    }

    if (isFile) {
      const basename = path.split("/").pop() || path;

      // Check exclude patterns
      if (excludePatterns.length > 0) {
        if (
          excludePatterns.some((p) =>
            matchGlob(basename, p, { stripQuotes: true })
          )
        ) {
          return [];
        }
      }

      // Check include patterns
      if (includePatterns.length > 0) {
        if (
          !includePatterns.some((p) =>
            matchGlob(basename, p, { stripQuotes: true })
          )
        ) {
          return [];
        }
      }
      return [{ path, isFile: true }];
    }

    if (!isDirectory) {
      return [];
    }

    // Check if directory should be excluded
    const dirName = path.split("/").pop() || path;
    if (excludeDirPatterns.length > 0) {
      if (
        excludeDirPatterns.some((p) =>
          matchGlob(dirName, p, { stripQuotes: true })
        )
      ) {
        return [];
      }
    }

    // Use readdirWithFileTypes if available
    if (ctx.fs.readdirWithFileTypes) {
      const entries = await ctx.fs.readdirWithFileTypes(fullPath);
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue; // Skip hidden files

        const entryPath = path === "." ? entry.name : `${path}/${entry.name}`;
        const expanded = await expandRecursiveWithTypes(
          entryPath,
          ctx,
          includePatterns,
          excludePatterns,
          excludeDirPatterns,
          entry.isFile,
          depth + 1
        );
        result.push(...expanded);
      }
    } else {
      const entries = await ctx.fs.readdir(fullPath);
      for (const entry of entries) {
        if (entry.startsWith(".")) continue; // Skip hidden files

        const entryPath = path === "." ? entry : `${path}/${entry}`;
        const expanded = await expandRecursiveWithTypes(
          entryPath,
          ctx,
          includePatterns,
          excludePatterns,
          excludeDirPatterns,
          undefined,
          depth + 1
        );
        result.push(...expanded);
      }
    }
  } catch {
    // Ignore errors
  }

  return result;
}

// fgrep is equivalent to grep -F
export const fgrepCommand: Command = {
  name: "fgrep",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    // Insert -F at the beginning of args
    return grepCommand.execute(["-F", ...args], ctx);
  }
};

// egrep is equivalent to grep -E
export const egrepCommand: Command = {
  name: "egrep",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    // Insert -E at the beginning of args
    return grepCommand.execute(["-E", ...args], ctx);
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "grep",
  flags: [
    { flag: "-E", type: "boolean" },
    { flag: "-F", type: "boolean" },
    { flag: "-P", type: "boolean" },
    { flag: "-i", type: "boolean" },
    { flag: "-v", type: "boolean" },
    { flag: "-w", type: "boolean" },
    { flag: "-x", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-l", type: "boolean" },
    { flag: "-L", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-h", type: "boolean" },
    { flag: "-o", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-r", type: "boolean" },
    { flag: "-m", type: "value", valueHint: "number" },
    { flag: "-A", type: "value", valueHint: "number" },
    { flag: "-B", type: "value", valueHint: "number" },
    { flag: "-C", type: "value", valueHint: "number" },
    { flag: "-e", type: "value", valueHint: "pattern" }
  ],
  stdinType: "text",
  needsArgs: true
};

export const fgrepFlagsForFuzzing: CommandFuzzInfo = {
  name: "fgrep",
  flags: [],
  stdinType: "text",
  needsArgs: true
};

export const egrepFlagsForFuzzing: CommandFuzzInfo = {
  name: "egrep",
  flags: [],
  stdinType: "text",
  needsArgs: true
};
