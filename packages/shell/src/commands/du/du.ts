import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { DEFAULT_BATCH_SIZE } from "../../utils/constants";
import { hasHelpFlag, showHelp } from "../help";

const duHelp = {
  name: "du",
  summary: "estimate file space usage",
  usage: "du [OPTION]... [FILE]...",
  options: [
    "-a          write counts for all files, not just directories",
    "-h          print sizes in human readable format",
    "-s          display only a total for each argument",
    "-c          produce a grand total",
    "--max-depth=N  print total for directory only if N or fewer levels deep",
    "    --help  display this help and exit"
  ]
};

const argDefs = {
  allFiles: { short: "a", type: "boolean" as const },
  humanReadable: { short: "h", type: "boolean" as const },
  summarize: { short: "s", type: "boolean" as const },
  grandTotal: { short: "c", type: "boolean" as const },
  maxDepth: { long: "max-depth", type: "number" as const }
};

interface DuOptions {
  allFiles: boolean;
  humanReadable: boolean;
  summarize: boolean;
  grandTotal: boolean;
  maxDepth: number | null;
}

export const duCommand: Command = {
  name: "du",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(duHelp);
    }

    const parsed = parseArgs("du", args, argDefs);
    if (!parsed.ok) return parsed.error;

    const options: DuOptions = {
      allFiles: parsed.result.flags.allFiles,
      humanReadable: parsed.result.flags.humanReadable,
      summarize: parsed.result.flags.summarize,
      grandTotal: parsed.result.flags.grandTotal,
      maxDepth: parsed.result.flags.maxDepth ?? null
    };

    const targets = parsed.result.positional;

    // Default to current directory
    if (targets.length === 0) {
      targets.push(".");
    }

    let stdout = "";
    let stderr = "";
    let grandTotal = 0;

    for (const target of targets) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, target);

      try {
        // Check if path exists first
        await ctx.fs.stat(fullPath);
        const result = await calculateSize(ctx, fullPath, target, options, 0);
        stdout += result.output;
        grandTotal += result.totalSize;
        stderr += result.stderr;
      } catch {
        stderr += `du: cannot access '${target}': No such file or directory\n`;
      }
    }

    if (options.grandTotal && targets.length > 0) {
      stdout += `${formatSize(grandTotal, options.humanReadable)}\ttotal\n`;
    }

    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  }
};

interface SizeResult {
  output: string;
  totalSize: number;
  stderr: string;
}

/** Safety limit to prevent stack overflow on deeply nested directories */
const MAX_DU_DEPTH = 1000;

async function calculateSize(
  ctx: CommandContext,
  fullPath: string,
  displayPath: string,
  options: DuOptions,
  depth: number
): Promise<SizeResult> {
  const result: SizeResult = {
    output: "",
    totalSize: 0,
    stderr: ""
  };

  if (depth > MAX_DU_DEPTH) return result;

  try {
    const stat = await ctx.fs.stat(fullPath);

    if (!stat.isDirectory) {
      // Single file
      result.totalSize = stat.size;
      if (options.allFiles || depth === 0) {
        result.output =
          formatSize(stat.size, options.humanReadable) +
          "\t" +
          displayPath +
          "\n";
      }
      return result;
    }

    // Directory - use readdirWithFileTypes if available for better performance
    let dirSize = 0;

    // Get entries with type info if possible
    interface EntryInfo {
      name: string;
      isDirectory: boolean;
      size?: number;
    }
    const entryInfos: EntryInfo[] = [];

    if (ctx.fs.readdirWithFileTypes) {
      const entriesWithTypes = await ctx.fs.readdirWithFileTypes(fullPath);
      // For files, we still need stat to get size, but we know directories
      const fileEntries = entriesWithTypes.filter((e) => e.isFile);
      const dirEntries = entriesWithTypes.filter((e) => e.isDirectory);

      // Parallel stat for files to get sizes
      for (let i = 0; i < fileEntries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = fileEntries.slice(i, i + DEFAULT_BATCH_SIZE);
        const stats = await Promise.all(
          batch.map(async (e) => {
            const entryPath =
              fullPath === "/" ? `/${e.name}` : `${fullPath}/${e.name}`;
            try {
              const s = await ctx.fs.stat(entryPath);
              return { name: e.name, isDirectory: false, size: s.size };
            } catch {
              return { name: e.name, isDirectory: false, size: 0 };
            }
          })
        );
        entryInfos.push(...stats);
      }

      // Add directory entries (size will be calculated recursively)
      entryInfos.push(
        ...dirEntries.map((e) => ({ name: e.name, isDirectory: true }))
      );
    } else {
      // Fall back to readdir + parallel stat
      const entries = await ctx.fs.readdir(fullPath);
      for (let i = 0; i < entries.length; i += DEFAULT_BATCH_SIZE) {
        const batch = entries.slice(i, i + DEFAULT_BATCH_SIZE);
        const stats = await Promise.all(
          batch.map(async (entry) => {
            const entryPath =
              fullPath === "/" ? `/${entry}` : `${fullPath}/${entry}`;
            try {
              const s = await ctx.fs.stat(entryPath);
              return {
                name: entry,
                isDirectory: s.isDirectory,
                size: s.isDirectory ? undefined : s.size
              };
            } catch {
              return { name: entry, isDirectory: false, size: 0 };
            }
          })
        );
        entryInfos.push(...stats);
      }
    }

    // Sort entries for consistent output
    entryInfos.sort((a, b) => a.name.localeCompare(b.name));

    // Process files first (simple size addition)
    const fileInfos = entryInfos.filter((e) => !e.isDirectory);
    for (const file of fileInfos) {
      const size = file.size ?? 0;
      dirSize += size;
      if (options.allFiles && !options.summarize) {
        const entryDisplayPath =
          displayPath === "." ? file.name : `${displayPath}/${file.name}`;
        result.output +=
          formatSize(size, options.humanReadable) +
          "\t" +
          entryDisplayPath +
          "\n";
      }
    }

    // Process directories in parallel batches
    const dirInfos = entryInfos.filter((e) => e.isDirectory);
    for (let i = 0; i < dirInfos.length; i += DEFAULT_BATCH_SIZE) {
      const batch = dirInfos.slice(i, i + DEFAULT_BATCH_SIZE);
      const subResults = await Promise.all(
        batch.map(async (dir) => {
          const entryPath =
            fullPath === "/" ? `/${dir.name}` : `${fullPath}/${dir.name}`;
          const entryDisplayPath =
            displayPath === "." ? dir.name : `${displayPath}/${dir.name}`;
          return {
            name: dir.name,
            result: await calculateSize(
              ctx,
              entryPath,
              entryDisplayPath,
              options,
              depth + 1
            )
          };
        })
      );

      // Sort results for consistent order
      subResults.sort((a, b) => a.name.localeCompare(b.name));

      for (const { result: subResult } of subResults) {
        dirSize += subResult.totalSize;
        // Only output subdirectories if not summarizing and within depth limit
        if (!options.summarize) {
          if (options.maxDepth === null || depth + 1 <= options.maxDepth) {
            result.output += subResult.output;
          }
        }
      }
    }

    result.totalSize = dirSize;

    // Output this directory if within depth limit
    if (
      options.summarize ||
      options.maxDepth === null ||
      depth <= options.maxDepth
    ) {
      result.output += `${formatSize(dirSize, options.humanReadable)}\t${displayPath}\n`;
    }
  } catch (_error) {
    result.stderr = `du: cannot read directory '${displayPath}': Permission denied\n`;
  }

  return result;
}

function formatSize(bytes: number, humanReadable: boolean): string {
  if (!humanReadable) {
    // Return size in 1K blocks
    return String(Math.ceil(bytes / 1024) || 1);
  }

  if (bytes < 1024) {
    return `${bytes}`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}K`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
  }
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "du",
  flags: [
    { flag: "-a", type: "boolean" },
    { flag: "-h", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "--max-depth", type: "value", valueHint: "number" }
  ],
  needsFiles: true
};
