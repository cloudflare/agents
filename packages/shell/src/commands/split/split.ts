/**
 * split - split a file into pieces
 *
 * Usage: split [OPTION]... [FILE [PREFIX]]
 *
 * Output pieces of FILE to PREFIXaa, PREFIXab, ...;
 * default size is 1000 lines, and default PREFIX is 'x'.
 */

import type { Command, CommandContext, ExecResult } from "../../types";
import { hasHelpFlag, showHelp, unknownOption } from "../help";

const splitHelp = {
  name: "split",
  summary: "split a file into pieces",
  usage: "split [OPTION]... [FILE [PREFIX]]",
  description:
    "Output pieces of FILE to PREFIXaa, PREFIXab, ...; default size is 1000 lines, and default PREFIX is 'x'.",
  options: [
    "-l N         Put N lines per output file",
    "-b SIZE      Put SIZE bytes per output file (K, M, G suffixes)",
    "-n CHUNKS    Split into CHUNKS equal-sized files",
    "-d           Use numeric suffixes (00, 01, ...) instead of alphabetic",
    "-a LENGTH    Use suffixes of length LENGTH (default: 2)",
    "--additional-suffix=SUFFIX  Append SUFFIX to file names"
  ],
  examples: [
    "split -l 100 file.txt        # Split into 100-line chunks",
    "split -b 1M file.bin         # Split into 1MB chunks",
    "split -n 5 file.txt          # Split into 5 equal parts",
    "split -d file.txt part_      # part_00, part_01, ...",
    "split -a 3 -d file.txt x     # x000, x001, ..."
  ]
};

/** Maximum number of output files to prevent resource exhaustion */
const MAX_OUTPUT_FILES = 100_000;

type SplitMode = "lines" | "bytes" | "chunks";

interface SplitOptions {
  mode: SplitMode;
  lines: number;
  bytes: number;
  chunks: number;
  useNumericSuffix: boolean;
  suffixLength: number;
  additionalSuffix: string;
}

/**
 * Parse a size string like "10K", "1M", "2G" into bytes.
 */
function parseSize(sizeStr: string): number | null {
  const match = sizeStr.match(/^(\d+)([KMGTPEZY]?)([B]?)$/i);
  if (!match) {
    return null;
  }

  const num = Number.parseInt(match[1], 10);
  if (Number.isNaN(num) || num < 1) {
    return null;
  }

  const suffix = (match[2] || "").toUpperCase();
  const multipliers = new Map<string, number>([
    ["", 1],
    ["K", 1024],
    ["M", 1024 * 1024],
    ["G", 1024 * 1024 * 1024],
    ["T", 1024 * 1024 * 1024 * 1024],
    ["P", 1024 * 1024 * 1024 * 1024 * 1024]
  ]);

  const multiplier = multipliers.get(suffix);
  if (multiplier === undefined) {
    return null;
  }

  return num * multiplier;
}

/**
 * Generate suffix for a given index.
 * For alphabetic: aa, ab, ..., az, ba, bb, ..., zz, aaa, aab, ...
 * For numeric: 00, 01, ..., 99, 000, 001, ...
 */
function generateSuffix(
  index: number,
  useNumeric: boolean,
  length: number
): string {
  if (useNumeric) {
    return index.toString().padStart(length, "0");
  }

  // Alphabetic suffix
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  let remaining = index;

  for (let i = 0; i < length; i++) {
    suffix = chars[remaining % 26] + suffix;
    remaining = Math.floor(remaining / 26);
  }

  return suffix;
}

/**
 * Split content by lines.
 */
function splitByLines(
  content: string,
  linesPerFile: number
): { content: string; hasContent: boolean }[] {
  const lines = content.split("\n");
  const hasTrailingNewline =
    content.endsWith("\n") && lines[lines.length - 1] === "";
  if (hasTrailingNewline) {
    lines.pop();
  }

  const chunks: { content: string; hasContent: boolean }[] = [];

  for (let i = 0; i < lines.length; i += linesPerFile) {
    const chunkLines = lines.slice(i, i + linesPerFile);
    const isLastChunk = i + linesPerFile >= lines.length;
    // Add newline after each line, but for the last chunk only if original had trailing newline
    const chunkContent =
      isLastChunk && !hasTrailingNewline
        ? chunkLines.join("\n")
        : `${chunkLines.join("\n")}\n`;
    chunks.push({ content: chunkContent, hasContent: true });
  }

  return chunks;
}

/**
 * Split content by bytes.
 */
function splitByBytes(
  content: string,
  bytesPerFile: number
): { content: string; hasContent: boolean }[] {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const decoder = new TextDecoder();
  const chunks: { content: string; hasContent: boolean }[] = [];

  for (let i = 0; i < bytes.length; i += bytesPerFile) {
    const chunkBytes = bytes.slice(i, i + bytesPerFile);
    chunks.push({
      content: decoder.decode(chunkBytes),
      hasContent: chunkBytes.length > 0
    });
  }

  return chunks;
}

/**
 * Split content into N equal chunks.
 */
function splitIntoChunks(
  content: string,
  numChunks: number
): { content: string; hasContent: boolean }[] {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  const decoder = new TextDecoder();
  const chunks: { content: string; hasContent: boolean }[] = [];

  const bytesPerChunk = Math.ceil(bytes.length / numChunks);

  for (let i = 0; i < numChunks; i++) {
    const start = i * bytesPerChunk;
    const end = Math.min(start + bytesPerChunk, bytes.length);
    const chunkBytes = bytes.slice(start, end);
    chunks.push({
      content: decoder.decode(chunkBytes),
      hasContent: chunkBytes.length > 0
    });
  }

  return chunks;
}

export const split: Command = {
  name: "split",
  execute: async (args: string[], ctx: CommandContext): Promise<ExecResult> => {
    if (hasHelpFlag(args)) {
      return showHelp(splitHelp);
    }

    const options: SplitOptions = {
      mode: "lines",
      lines: 1000,
      bytes: 0,
      chunks: 0,
      useNumericSuffix: false,
      suffixLength: 2,
      additionalSuffix: ""
    };

    const positionalArgs: string[] = [];
    let i = 0;

    while (i < args.length) {
      const arg = args[i];

      if (arg === "-l" && i + 1 < args.length) {
        const lines = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(lines) || lines < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of lines: '${args[i + 1]}'\n`
          };
        }
        options.mode = "lines";
        options.lines = lines;
        i += 2;
      } else if (arg.match(/^-l\d+$/)) {
        const lines = Number.parseInt(arg.slice(2), 10);
        if (Number.isNaN(lines) || lines < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of lines: '${arg.slice(2)}'\n`
          };
        }
        options.mode = "lines";
        options.lines = lines;
        i++;
      } else if (arg === "-b" && i + 1 < args.length) {
        const bytes = parseSize(args[i + 1]);
        if (bytes === null) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of bytes: '${args[i + 1]}'\n`
          };
        }
        options.mode = "bytes";
        options.bytes = bytes;
        i += 2;
      } else if (arg.match(/^-b.+$/)) {
        const bytes = parseSize(arg.slice(2));
        if (bytes === null) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of bytes: '${arg.slice(2)}'\n`
          };
        }
        options.mode = "bytes";
        options.bytes = bytes;
        i++;
      } else if (arg === "-n" && i + 1 < args.length) {
        const chunks = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(chunks) || chunks < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of chunks: '${args[i + 1]}'\n`
          };
        }
        options.mode = "chunks";
        options.chunks = chunks;
        i += 2;
      } else if (arg.match(/^-n\d+$/)) {
        const chunks = Number.parseInt(arg.slice(2), 10);
        if (Number.isNaN(chunks) || chunks < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid number of chunks: '${arg.slice(2)}'\n`
          };
        }
        options.mode = "chunks";
        options.chunks = chunks;
        i++;
      } else if (arg === "-a" && i + 1 < args.length) {
        const len = Number.parseInt(args[i + 1], 10);
        if (Number.isNaN(len) || len < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid suffix length: '${args[i + 1]}'\n`
          };
        }
        options.suffixLength = len;
        i += 2;
      } else if (arg.match(/^-a\d+$/)) {
        const len = Number.parseInt(arg.slice(2), 10);
        if (Number.isNaN(len) || len < 1) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `split: invalid suffix length: '${arg.slice(2)}'\n`
          };
        }
        options.suffixLength = len;
        i++;
      } else if (arg === "-d" || arg === "--numeric-suffixes") {
        options.useNumericSuffix = true;
        i++;
      } else if (arg.startsWith("--additional-suffix=")) {
        options.additionalSuffix = arg.slice("--additional-suffix=".length);
        i++;
      } else if (arg === "--additional-suffix" && i + 1 < args.length) {
        options.additionalSuffix = args[i + 1];
        i += 2;
      } else if (arg === "--") {
        positionalArgs.push(...args.slice(i + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("split", arg);
      } else {
        positionalArgs.push(arg);
        i++;
      }
    }

    // Parse positional args: [FILE [PREFIX]]
    let inputFile = "-";
    let prefix = "x";

    if (positionalArgs.length >= 1) {
      inputFile = positionalArgs[0];
    }
    if (positionalArgs.length >= 2) {
      prefix = positionalArgs[1];
    }

    // Read input content
    let content: string;
    if (inputFile === "-") {
      content = ctx.stdin ?? "";
    } else {
      const filePath = ctx.fs.resolvePath(ctx.cwd, inputFile);
      const fileContent = await ctx.fs.readFile(filePath);
      if (fileContent === null) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `split: ${inputFile}: No such file or directory\n`
        };
      }
      content = fileContent;
    }

    // Handle empty input
    if (content === "") {
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      };
    }

    // Split content
    let chunks: { content: string; hasContent: boolean }[];
    switch (options.mode) {
      case "lines":
        chunks = splitByLines(content, options.lines);
        break;
      case "bytes":
        chunks = splitByBytes(content, options.bytes);
        break;
      case "chunks":
        chunks = splitIntoChunks(content, options.chunks);
        break;
      default: {
        const _exhaustive: never = options.mode;
        return _exhaustive;
      }
    }

    // Guard against excessive file creation
    if (chunks.length > MAX_OUTPUT_FILES) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `split: too many output files (${chunks.length}), limit is ${MAX_OUTPUT_FILES}\n`
      };
    }

    // Write output files
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunk = chunks[chunkIndex];
      if (!chunk.hasContent) continue;

      const suffix = generateSuffix(
        chunkIndex,
        options.useNumericSuffix,
        options.suffixLength
      );
      const filename = `${prefix}${suffix}${options.additionalSuffix}`;
      const filePath = ctx.fs.resolvePath(ctx.cwd, filename);

      await ctx.fs.writeFile(filePath, chunk.content);
    }

    return {
      exitCode: 0,
      stdout: "",
      stderr: ""
    };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "split",
  flags: [
    { flag: "-l", type: "value", valueHint: "number" },
    { flag: "-b", type: "value", valueHint: "string" },
    { flag: "-n", type: "value", valueHint: "number" },
    { flag: "-d", type: "boolean" },
    { flag: "-a", type: "value", valueHint: "number" }
  ],
  needsFiles: true
};
