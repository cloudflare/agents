import { minimatch } from "minimatch";
import type { FsStat } from "../../fs/interface";
import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { DEFAULT_BATCH_SIZE } from "../../utils/constants";
import { hasHelpFlag, showHelp } from "../help";

// Format size in human-readable format (e.g., 1.5K, 234M, 2G)
function formatHumanSize(bytes: number): string {
  if (bytes < 1024) return String(bytes);
  if (bytes < 1024 * 1024) {
    const k = bytes / 1024;
    return k < 10 ? `${k.toFixed(1)}K` : `${Math.round(k)}K`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    const m = bytes / (1024 * 1024);
    return m < 10 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
  }
  const g = bytes / (1024 * 1024 * 1024);
  return g < 10 ? `${g.toFixed(1)}G` : `${Math.round(g)}G`;
}

// Format date for ls -l output (e.g., "Jan  1 00:00" or "Jan  1  2024")
function formatDate(date: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];
  const month = months[date.getMonth()];
  const day = String(date.getDate()).padStart(2, " ");
  const now = new Date();
  const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

  // If within last 6 months, show time; otherwise show year
  if (date > sixMonthsAgo) {
    const hours = String(date.getHours()).padStart(2, "0");
    const mins = String(date.getMinutes()).padStart(2, "0");
    return `${month} ${day} ${hours}:${mins}`;
  }
  const year = date.getFullYear();
  return `${month} ${day}  ${year}`;
}

// Classify suffix for ls -F: / directory, @ symlink, * executable
function classifySuffix(stat: FsStat): string {
  if (stat.isDirectory) return "/";
  if (stat.isSymbolicLink) return "@";
  if ((stat.mode & 0o111) !== 0) return "*";
  return "";
}

const lsHelp = {
  name: "ls",
  summary: "list directory contents",
  usage: "ls [OPTION]... [FILE]...",
  options: [
    "-a, --all            do not ignore entries starting with .",
    "-A, --almost-all     do not list . and ..",
    "-d, --directory      list directories themselves, not their contents",
    "-F, --classify       append indicator (one of */=>@) to entries",
    "-h, --human-readable with -l, print sizes like 1K 234M 2G etc.",
    "-l                   use a long listing format",
    "-r, --reverse        reverse order while sorting",
    "-R, --recursive      list subdirectories recursively",
    "-S                   sort by file size, largest first",
    "-t                   sort by time, newest first",
    "-1                   list one file per line",
    "    --help           display this help and exit"
  ]
};

const argDefs = {
  showAll: { short: "a", long: "all", type: "boolean" as const },
  showAlmostAll: { short: "A", long: "almost-all", type: "boolean" as const },
  longFormat: { short: "l", type: "boolean" as const },
  humanReadable: {
    short: "h",
    long: "human-readable",
    type: "boolean" as const
  },
  recursive: { short: "R", long: "recursive", type: "boolean" as const },
  reverse: { short: "r", long: "reverse", type: "boolean" as const },
  sortBySize: { short: "S", type: "boolean" as const },
  classifyFiles: { short: "F", long: "classify", type: "boolean" as const },
  directoryOnly: { short: "d", long: "directory", type: "boolean" as const },
  sortByTime: { short: "t", type: "boolean" as const },
  onePerLine: { short: "1", type: "boolean" as const }
};

export const lsCommand: Command = {
  name: "ls",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(lsHelp);
    }

    const parsed = parseArgs("ls", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const showAll = parsed.result.flags.showAll;
    const showAlmostAll = parsed.result.flags.showAlmostAll;
    const longFormat = parsed.result.flags.longFormat;
    const humanReadable = parsed.result.flags.humanReadable;
    const recursive = parsed.result.flags.recursive;
    const reverse = parsed.result.flags.reverse;
    const sortBySize = parsed.result.flags.sortBySize;
    const classifyFiles = parsed.result.flags.classifyFiles;
    const directoryOnly = parsed.result.flags.directoryOnly;
    const _sortByTime = parsed.result.flags.sortByTime;
    // Note: onePerLine is accepted but implicit in our output
    void parsed.result.flags.onePerLine;

    const paths = parsed.result.positional;

    if (paths.length === 0) {
      paths.push(".");
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];

      // Add blank line between directory listings
      if (i > 0 && stdout && !stdout.endsWith("\n\n")) {
        stdout += "\n";
      }

      // With -d flag, just list the directories/files themselves, not their contents
      if (directoryOnly) {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, path);
        try {
          const stat = await ctx.fs.stat(fullPath);
          if (longFormat) {
            const mode = stat.isDirectory ? "drwxr-xr-x" : "-rw-r--r--";
            const suffix = classifyFiles
              ? classifySuffix(await ctx.fs.lstat(fullPath))
              : stat.isDirectory
                ? "/"
                : "";
            const size = stat.size ?? 0;
            const sizeStr = humanReadable
              ? formatHumanSize(size).padStart(5)
              : String(size).padStart(5);
            const mtime = stat.mtime ?? new Date(0);
            const dateStr = formatDate(mtime);
            stdout += `${mode} 1 user user ${sizeStr} ${dateStr} ${path}${suffix}\n`;
          } else {
            const suffix = classifyFiles
              ? classifySuffix(await ctx.fs.lstat(fullPath))
              : "";
            stdout += `${path}${suffix}\n`;
          }
        } catch {
          stderr += `ls: cannot access '${path}': No such file or directory\n`;
          exitCode = 2;
        }
        continue;
      }

      // Check if it's a glob pattern
      if (path.includes("*") || path.includes("?") || path.includes("[")) {
        const result = await listGlob(
          path,
          ctx,
          showAll,
          showAlmostAll,
          longFormat,
          reverse,
          humanReadable,
          sortBySize,
          classifyFiles
        );
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0) exitCode = result.exitCode;
      } else {
        const result = await listPath(
          path,
          ctx,
          showAll,
          showAlmostAll,
          longFormat,
          recursive,
          paths.length > 1,
          reverse,
          humanReadable,
          sortBySize,
          classifyFiles
        );
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0) exitCode = result.exitCode;
      }
    }

    return { stdout, stderr, exitCode };
  }
};

async function listGlob(
  pattern: string,
  ctx: CommandContext,
  showAll: boolean,
  showAlmostAll: boolean,
  longFormat: boolean,
  reverse: boolean = false,
  humanReadable: boolean = false,
  sortBySize: boolean = false,
  classifyFiles: boolean = false
): Promise<ExecResult> {
  const showHidden = showAll || showAlmostAll;
  const allPaths = ctx.fs.getAllPaths();
  const basePath = ctx.fs.resolvePath(ctx.cwd, ".");

  const matches: string[] = [];
  for (const p of allPaths) {
    const relativePath = p.startsWith(basePath)
      ? p.slice(basePath.length + 1) || p
      : p;

    if (minimatch(relativePath, pattern) || minimatch(p, pattern)) {
      // Filter hidden files unless showHidden
      const basename = relativePath.split("/").pop() || relativePath;
      if (!showHidden && basename.startsWith(".")) {
        continue;
      }
      matches.push(relativePath || p);
    }
  }

  if (matches.length === 0) {
    return {
      stdout: "",
      stderr: `ls: ${pattern}: No such file or directory\n`,
      exitCode: 2
    };
  }

  // Sort by size if -S flag, otherwise alphabetically
  if (sortBySize) {
    const matchesWithSize: { path: string; size: number }[] = [];
    for (const match of matches) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, match);
      try {
        const stat = await ctx.fs.stat(fullPath);
        matchesWithSize.push({ path: match, size: stat.size ?? 0 });
      } catch {
        matchesWithSize.push({ path: match, size: 0 });
      }
    }
    matchesWithSize.sort((a, b) => b.size - a.size); // largest first
    matches.length = 0;
    matches.push(...matchesWithSize.map((m) => m.path));
  } else {
    matches.sort();
  }
  if (reverse) {
    matches.reverse();
  }

  if (longFormat) {
    const lines: string[] = [];
    for (const match of matches) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, match);
      try {
        const stat = await ctx.fs.stat(fullPath);
        const mode = stat.isDirectory ? "drwxr-xr-x" : "-rw-r--r--";
        const suffix = classifyFiles
          ? classifySuffix(await ctx.fs.lstat(fullPath))
          : stat.isDirectory
            ? "/"
            : "";
        const size = stat.size ?? 0;
        const sizeStr = humanReadable
          ? formatHumanSize(size).padStart(5)
          : String(size).padStart(5);
        const mtime = stat.mtime ?? new Date(0);
        const dateStr = formatDate(mtime);
        lines.push(
          `${mode} 1 user user ${sizeStr} ${dateStr} ${match}${suffix}`
        );
      } catch {
        lines.push(`-rw-r--r-- 1 user user     0 Jan  1 00:00 ${match}`);
      }
    }
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  }

  if (classifyFiles) {
    const classified: string[] = [];
    for (const match of matches) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, match);
      try {
        const stat = await ctx.fs.lstat(fullPath);
        classified.push(`${match}${classifySuffix(stat)}`);
      } catch {
        classified.push(match);
      }
    }
    return { stdout: `${classified.join("\n")}\n`, stderr: "", exitCode: 0 };
  }

  return { stdout: `${matches.join("\n")}\n`, stderr: "", exitCode: 0 };
}

async function listPath(
  path: string,
  ctx: CommandContext,
  showAll: boolean,
  showAlmostAll: boolean,
  longFormat: boolean,
  recursive: boolean,
  showHeader: boolean,
  reverse: boolean = false,
  humanReadable: boolean = false,
  sortBySize: boolean = false,
  classifyFiles: boolean = false,
  _isSubdir: boolean = false
): Promise<ExecResult> {
  const showHidden = showAll || showAlmostAll;
  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);

  try {
    const stat = await ctx.fs.stat(fullPath);

    if (!stat.isDirectory) {
      // It's a file, just show it
      const fileSuffix = classifyFiles
        ? classifySuffix(await ctx.fs.lstat(fullPath))
        : "";
      if (longFormat) {
        const size = stat.size ?? 0;
        const sizeStr = humanReadable
          ? formatHumanSize(size).padStart(5)
          : String(size).padStart(5);
        const mtime = stat.mtime ?? new Date(0);
        const dateStr = formatDate(mtime);
        return {
          stdout: `-rw-r--r-- 1 user user ${sizeStr} ${dateStr} ${path}${fileSuffix}\n`,
          stderr: "",
          exitCode: 0
        };
      }
      return { stdout: `${path}${fileSuffix}\n`, stderr: "", exitCode: 0 };
    }

    // It's a directory
    let entries = await ctx.fs.readdir(fullPath);

    // Filter hidden files unless -a or -A
    if (!showHidden) {
      entries = entries.filter((e) => !e.startsWith("."));
    }

    // Sort by size if -S flag, otherwise alphabetically
    if (sortBySize) {
      const entriesWithSize: { name: string; size: number }[] = [];
      for (const entry of entries) {
        const entryPath =
          fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
        try {
          const entryStat = await ctx.fs.stat(entryPath);
          entriesWithSize.push({ name: entry, size: entryStat.size ?? 0 });
        } catch {
          entriesWithSize.push({ name: entry, size: 0 });
        }
      }
      entriesWithSize.sort((a, b) => b.size - a.size); // largest first
      entries = entriesWithSize.map((e) => e.name);
    } else {
      // Sort entries (already sorted by readdir, but ensure consistent order)
      entries.sort();
    }

    // Add . and .. entries for -a flag (but not for -A)
    if (showAll) {
      entries = [".", "..", ...entries];
    }

    if (reverse) {
      entries.reverse();
    }

    let stdout = "";

    // For recursive listing:
    // - All directories get a header (including the first one)
    // - When starting from '.', show '.:'
    // - Subdirectories use './subdir:' format when starting from '.'
    // - When starting from other path, subdirs use '{path}/subdir:' format
    if (recursive || showHeader) {
      stdout += `${path}:\n`;
    }

    if (longFormat) {
      stdout += `total ${entries.length}\n`;

      // Separate special entries (. and ..) from regular entries
      const specialEntries = entries.filter((e) => e === "." || e === "..");
      const regularEntries = entries.filter((e) => e !== "." && e !== "..");

      // Add special entries first
      for (const entry of specialEntries) {
        stdout += `drwxr-xr-x 1 user user     0 Jan  1 00:00 ${entry}\n`;
      }

      // Parallelize stat calls for regular entries
      const entryStats: {
        name: string;
        line: string;
      }[] = [];

      for (let i = 0; i < regularEntries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = regularEntries.slice(i, i + DEFAULT_BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (entry) => {
            const entryPath =
              fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
            try {
              const entryStat = await ctx.fs.stat(entryPath);
              const mode = entryStat.isDirectory ? "drwxr-xr-x" : "-rw-r--r--";
              const suffix = classifyFiles
                ? classifySuffix(await ctx.fs.lstat(entryPath))
                : entryStat.isDirectory
                  ? "/"
                  : "";
              const size = entryStat.size ?? 0;
              const sizeStr = humanReadable
                ? formatHumanSize(size).padStart(5)
                : String(size).padStart(5);
              const mtime = entryStat.mtime ?? new Date(0);
              const dateStr = formatDate(mtime);
              return {
                name: entry,
                line: `${mode} 1 user user ${sizeStr} ${dateStr} ${entry}${suffix}\n`
              };
            } catch {
              return {
                name: entry,
                line: `-rw-r--r-- 1 user user     0 Jan  1 00:00 ${entry}\n`
              };
            }
          })
        );
        entryStats.push(...batchResults);
      }

      // Sort to maintain original order (entries were already sorted)
      const entryOrder = new Map(regularEntries.map((e, i) => [e, i]));
      entryStats.sort(
        (a, b) => (entryOrder.get(a.name) ?? 0) - (entryOrder.get(b.name) ?? 0)
      );

      for (const { line } of entryStats) {
        stdout += line;
      }
    } else if (classifyFiles) {
      // Classify each entry with type suffix
      const classified: string[] = [];
      const regularEntries = entries.filter((e) => e !== "." && e !== "..");
      const specialEntries = entries.filter((e) => e === "." || e === "..");

      for (const entry of specialEntries) {
        classified.push(`${entry}/`);
      }

      for (let i = 0; i < regularEntries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = regularEntries.slice(i, i + DEFAULT_BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (entry) => {
            const entryPath =
              fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
            try {
              const entryStat = await ctx.fs.lstat(entryPath);
              return `${entry}${classifySuffix(entryStat)}`;
            } catch {
              return entry;
            }
          })
        );
        classified.push(...batchResults);
      }

      stdout += classified.join("\n") + (classified.length ? "\n" : "");
    } else {
      stdout += entries.join("\n") + (entries.length ? "\n" : "");
    }

    // Handle recursive - parallel processing for better performance
    if (recursive) {
      // Filter out . and .. and get directory entries
      const filteredEntries = entries.filter((e) => e !== "." && e !== "..");

      // Use readdirWithFileTypes if available to avoid stat calls
      let dirEntries: { name: string; isDirectory: boolean }[] = [];

      if (ctx.fs.readdirWithFileTypes) {
        const entriesWithTypes = await ctx.fs.readdirWithFileTypes(fullPath);
        dirEntries = entriesWithTypes
          .filter((e) => e.isDirectory && filteredEntries.includes(e.name))
          .map((e) => ({ name: e.name, isDirectory: true }));
      } else {
        // Fall back to stat calls - parallelize them
        for (let i = 0; i < filteredEntries.length; i += DEFAULT_BATCH_SIZE) {
          const batch = filteredEntries.slice(i, i + DEFAULT_BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (entry) => {
              const entryPath =
                fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
              try {
                const entryStat = await ctx.fs.stat(entryPath);
                return { name: entry, isDirectory: entryStat.isDirectory };
              } catch {
                return { name: entry, isDirectory: false };
              }
            })
          );
          dirEntries.push(...results.filter((r) => r.isDirectory));
        }
      }

      // Sort directory entries to maintain order
      dirEntries.sort((a, b) => a.name.localeCompare(b.name));
      if (reverse) {
        dirEntries.reverse();
      }

      // Process subdirectories in parallel batches
      const subResults: { name: string; result: ExecResult }[] = [];

      for (let i = 0; i < dirEntries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = dirEntries.slice(i, i + DEFAULT_BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (dir) => {
            const subPath =
              path === "." ? `./${dir.name}` : `${path}/${dir.name}`;
            const result = await listPath(
              subPath,
              ctx,
              showAll,
              showAlmostAll,
              longFormat,
              recursive,
              false,
              reverse,
              humanReadable,
              sortBySize,
              classifyFiles,
              true
            );
            return { name: dir.name, result };
          })
        );
        subResults.push(...batchResults);
      }

      // Sort results to maintain consistent order
      subResults.sort((a, b) => a.name.localeCompare(b.name));
      if (reverse) {
        subResults.reverse();
      }

      // Append results
      for (const { result } of subResults) {
        stdout += "\n";
        stdout += result.stdout;
      }
    }

    return { stdout, stderr: "", exitCode: 0 };
  } catch {
    return {
      stdout: "",
      stderr: `ls: ${path}: No such file or directory\n`,
      exitCode: 2
    };
  }
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "ls",
  flags: [
    { flag: "-a", type: "boolean" },
    { flag: "-A", type: "boolean" },
    { flag: "-l", type: "boolean" },
    { flag: "-h", type: "boolean" },
    { flag: "-R", type: "boolean" },
    { flag: "-r", type: "boolean" },
    { flag: "-S", type: "boolean" },
    { flag: "-F", type: "boolean" },
    { flag: "-d", type: "boolean" },
    { flag: "-t", type: "boolean" },
    { flag: "-1", type: "boolean" }
  ],
  needsFiles: true
};
