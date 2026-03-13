/**
 * gzip - compress or expand files
 *
 * Also provides gunzip (decompress) and zcat (decompress to stdout) commands.
 */

import { constants, gunzipSync, gzipSync } from "node:zlib";
import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";
import { hasHelpFlag, showHelp } from "../help";

const gzipHelp = {
  name: "gzip",
  summary: "compress or expand files",
  usage: "gzip [OPTION]... [FILE]...",
  description: `Compress FILEs (by default, in-place).

When no FILE is given, or when FILE is -, read from standard input.

With -d, decompress instead.`,
  options: [
    "-c, --stdout      write to standard output, keep original files",
    "-d, --decompress  decompress",
    "-f, --force       force overwrite of output file",
    "-k, --keep        keep (don't delete) input files",
    "-l, --list        list compressed file contents",
    "-n, --no-name     do not save or restore the original name and timestamp",
    "-N, --name        save or restore the original file name and timestamp",
    "-q, --quiet       suppress all warnings",
    "-r, --recursive   operate recursively on directories",
    "-S, --suffix=SUF  use suffix SUF on compressed files (default: .gz)",
    "-t, --test        test compressed file integrity",
    "-v, --verbose     verbose mode",
    "-1, --fast        compress faster",
    "-9, --best        compress better",
    "    --help        display this help and exit"
  ]
};

const gunzipHelp = {
  name: "gunzip",
  summary: "decompress files",
  usage: "gunzip [OPTION]... [FILE]...",
  description: `Decompress FILEs (by default, in-place).

When no FILE is given, or when FILE is -, read from standard input.`,
  options: [
    "-c, --stdout      write to standard output, keep original files",
    "-f, --force       force overwrite of output file",
    "-k, --keep        keep (don't delete) input files",
    "-l, --list        list compressed file contents",
    "-n, --no-name     do not restore the original name and timestamp",
    "-N, --name        restore the original file name and timestamp",
    "-q, --quiet       suppress all warnings",
    "-r, --recursive   operate recursively on directories",
    "-S, --suffix=SUF  use suffix SUF on compressed files (default: .gz)",
    "-t, --test        test compressed file integrity",
    "-v, --verbose     verbose mode",
    "    --help        display this help and exit"
  ]
};

const zcatHelp = {
  name: "zcat",
  summary: "decompress files to stdout",
  usage: "zcat [OPTION]... [FILE]...",
  description: `Decompress FILEs to standard output.

When no FILE is given, or when FILE is -, read from standard input.`,
  options: [
    "-f, --force       force; read compressed data even from a terminal",
    "-l, --list        list compressed file contents",
    "-q, --quiet       suppress all warnings",
    "-S, --suffix=SUF  use suffix SUF on compressed files (default: .gz)",
    "-t, --test        test compressed file integrity",
    "-v, --verbose     verbose mode",
    "    --help        display this help and exit"
  ]
};

const argDefs = {
  stdout: { short: "c", long: "stdout", type: "boolean" as const },
  toStdout: { long: "to-stdout", type: "boolean" as const }, // alias
  decompress: { short: "d", long: "decompress", type: "boolean" as const },
  uncompress: { long: "uncompress", type: "boolean" as const }, // alias
  force: { short: "f", long: "force", type: "boolean" as const },
  keep: { short: "k", long: "keep", type: "boolean" as const },
  list: { short: "l", long: "list", type: "boolean" as const },
  noName: { short: "n", long: "no-name", type: "boolean" as const },
  name: { short: "N", long: "name", type: "boolean" as const },
  quiet: { short: "q", long: "quiet", type: "boolean" as const },
  recursive: { short: "r", long: "recursive", type: "boolean" as const },
  suffix: {
    short: "S",
    long: "suffix",
    type: "string" as const,
    default: ".gz"
  },
  test: { short: "t", long: "test", type: "boolean" as const },
  verbose: { short: "v", long: "verbose", type: "boolean" as const },
  // Compression levels
  fast: { short: "1", long: "fast", type: "boolean" as const },
  level2: { short: "2", type: "boolean" as const },
  level3: { short: "3", type: "boolean" as const },
  level4: { short: "4", type: "boolean" as const },
  level5: { short: "5", type: "boolean" as const },
  level6: { short: "6", type: "boolean" as const },
  level7: { short: "7", type: "boolean" as const },
  level8: { short: "8", type: "boolean" as const },
  best: { short: "9", long: "best", type: "boolean" as const }
};

type GzipFlags = {
  stdout: boolean;
  toStdout: boolean;
  decompress: boolean;
  uncompress: boolean;
  force: boolean;
  keep: boolean;
  list: boolean;
  noName: boolean;
  name: boolean;
  quiet: boolean;
  recursive: boolean;
  suffix: string;
  test: boolean;
  verbose: boolean;
  fast: boolean;
  level2: boolean;
  level3: boolean;
  level4: boolean;
  level5: boolean;
  level6: boolean;
  level7: boolean;
  level8: boolean;
  best: boolean;
};

/**
 * Get compression level from flags (default is 6)
 */
function getCompressionLevel(flags: GzipFlags): number {
  if (flags.best) return constants.Z_BEST_COMPRESSION; // 9
  if (flags.level8) return 8;
  if (flags.level7) return 7;
  if (flags.level6) return 6;
  if (flags.level5) return 5;
  if (flags.level4) return 4;
  if (flags.level3) return 3;
  if (flags.level2) return 2;
  if (flags.fast) return constants.Z_BEST_SPEED; // 1
  return constants.Z_DEFAULT_COMPRESSION; // -1 (usually 6)
}

/**
 * Parse gzip header to extract original filename and metadata
 */
function parseGzipHeader(data: Uint8Array): {
  originalName: string | null;
  mtime: Date | null;
  headerSize: number;
} {
  // Gzip format: https://www.ietf.org/rfc/rfc1952.txt
  // Header is at least 10 bytes
  if (data.length < 10) {
    return { originalName: null, mtime: null, headerSize: 0 };
  }

  // Check magic number
  if (data[0] !== 0x1f || data[1] !== 0x8b) {
    return { originalName: null, mtime: null, headerSize: 0 };
  }

  const flags = data[3];
  const mtime = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
  let offset = 10;

  // FEXTRA
  if (flags & 0x04) {
    if (offset + 2 > data.length)
      return { originalName: null, mtime: null, headerSize: 0 };
    const xlen = data[offset] | (data[offset + 1] << 8);
    offset += 2 + xlen;
  }

  // FNAME - original filename
  let originalName: string | null = null;
  if (flags & 0x08) {
    const nameStart = offset;
    while (offset < data.length && data[offset] !== 0) {
      offset++;
    }
    if (offset < data.length) {
      originalName = new TextDecoder().decode(data.slice(nameStart, offset));
      offset++; // skip null terminator
    }
  }

  // FCOMMENT
  if (flags & 0x10) {
    while (offset < data.length && data[offset] !== 0) {
      offset++;
    }
    offset++; // skip null terminator
  }

  // FHCRC
  if (flags & 0x02) {
    offset += 2;
  }

  return {
    originalName,
    mtime: mtime > 0 ? new Date(mtime * 1000) : null,
    headerSize: offset
  };
}

/**
 * Get the uncompressed size from gzip trailer (last 4 bytes)
 */
function getUncompressedSize(data: Uint8Array): number {
  if (data.length < 4) return 0;
  const len = data.length;
  return (
    data[len - 4] |
    (data[len - 3] << 8) |
    (data[len - 2] << 16) |
    (data[len - 1] << 24)
  );
}

/**
 * Check if data is valid gzip
 */
function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

function toBinaryString(data: Uint8Array): string {
  return Buffer.from(data).toString("latin1");
}

function getMaxDecompressedSize(ctx: CommandContext): number {
  return ctx.limits?.maxOutputSize ?? 0;
}

function gunzipWithLimit(
  inputData: Uint8Array,
  maxDecompressedSize: number
): Uint8Array {
  if (maxDecompressedSize > 0) {
    // Fast pre-check from gzip trailer (ISIZE) to fail before inflate when possible.
    const advertisedSize = getUncompressedSize(inputData);
    if (advertisedSize > maxDecompressedSize) {
      throw new Error(
        `decompressed data exceeds limit (${maxDecompressedSize} bytes)`
      );
    }
    return gunzipSync(inputData, {
      maxOutputLength: maxDecompressedSize
    });
  }

  return gunzipSync(inputData);
}

interface GzipResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function processFile(
  ctx: CommandContext,
  file: string,
  flags: GzipFlags,
  cmdName: string,
  decompress: boolean,
  toStdout: boolean
): Promise<GzipResult> {
  const suffix = flags.suffix;
  let inputPath: string;
  let outputPath: string;
  let inputData: Uint8Array;
  const maxDecompressedSize = getMaxDecompressedSize(ctx);

  // Handle stdin
  if (file === "-" || file === "") {
    inputData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
    if (decompress) {
      if (!isGzip(inputData)) {
        if (!flags.quiet) {
          return {
            stdout: "",
            stderr: `${cmdName}: stdin: not in gzip format\n`,
            exitCode: 1
          };
        }
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      try {
        const decompressed = gunzipWithLimit(inputData, maxDecompressedSize);
        // Use binary string (latin1) to preserve bytes
        return {
          stdout: toBinaryString(decompressed),
          stderr: "",
          exitCode: 0
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        return {
          stdout: "",
          stderr: `${cmdName}: stdin: ${msg}\n`,
          exitCode: 1
        };
      }
    } else {
      // Compress stdin
      const level = getCompressionLevel(flags);
      const compressed = gzipSync(inputData, { level });
      // Output raw bytes as binary - this is tricky since stdout is string
      // We'll use latin1 encoding to preserve bytes
      return {
        stdout: toBinaryString(compressed),
        stderr: "",
        exitCode: 0
      };
    }
  }

  // Resolve file path
  inputPath = ctx.fs.resolvePath(ctx.cwd, file);

  // Check if file exists
  try {
    const stat = await ctx.fs.stat(inputPath);
    if (stat.isDirectory) {
      if (flags.recursive) {
        // Process directory recursively
        return await processDirectory(
          ctx,
          inputPath,
          flags,
          cmdName,
          decompress,
          toStdout
        );
      }
      if (!flags.quiet) {
        return {
          stdout: "",
          stderr: `${cmdName}: ${file}: is a directory -- ignored\n`,
          exitCode: 1
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    }
  } catch {
    return {
      stdout: "",
      stderr: `${cmdName}: ${file}: No such file or directory\n`,
      exitCode: 1
    };
  }

  // Read input file
  try {
    inputData = await ctx.fs.readFileBuffer(inputPath);
  } catch {
    return {
      stdout: "",
      stderr: `${cmdName}: ${file}: No such file or directory\n`,
      exitCode: 1
    };
  }

  if (decompress) {
    // Decompression
    if (!file.endsWith(suffix)) {
      if (!flags.quiet) {
        return {
          stdout: "",
          stderr: `${cmdName}: ${file}: unknown suffix -- ignored\n`,
          exitCode: 1
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    if (!isGzip(inputData)) {
      if (!flags.quiet) {
        return {
          stdout: "",
          stderr: `${cmdName}: ${file}: not in gzip format\n`,
          exitCode: 1
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    let decompressed: Uint8Array;
    try {
      decompressed = gunzipWithLimit(inputData, maxDecompressedSize);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      return {
        stdout: "",
        stderr: `${cmdName}: ${file}: ${msg}\n`,
        exitCode: 1
      };
    }

    if (toStdout) {
      // Output to stdout using binary string (latin1) to preserve bytes
      return {
        stdout: toBinaryString(decompressed),
        stderr: "",
        exitCode: 0
      };
    }

    // Determine output filename
    if (flags.name) {
      const header = parseGzipHeader(inputData);
      if (header.originalName) {
        outputPath = ctx.fs.resolvePath(ctx.cwd, header.originalName);
      } else {
        outputPath = inputPath.slice(0, -suffix.length);
      }
    } else {
      outputPath = inputPath.slice(0, -suffix.length);
    }

    // Check if output exists
    if (!flags.force) {
      try {
        await ctx.fs.stat(outputPath);
        return {
          stdout: "",
          stderr: `${cmdName}: ${outputPath} already exists; not overwritten\n`,
          exitCode: 1
        };
      } catch {
        // File doesn't exist, good to proceed
      }
    }

    // Write decompressed file
    await ctx.fs.writeFile(outputPath, decompressed);

    // Remove original unless -k
    if (!flags.keep && !toStdout) {
      await ctx.fs.rm(inputPath);
    }

    if (flags.verbose) {
      const ratio =
        inputData.length > 0
          ? ((1 - inputData.length / decompressed.length) * 100).toFixed(1)
          : "0.0";
      return {
        stdout: "",
        stderr: `${file}:\t${ratio}% -- replaced with ${outputPath.split("/").pop()}\n`,
        exitCode: 0
      };
    }

    return { stdout: "", stderr: "", exitCode: 0 };
  } else {
    // Compression
    if (file.endsWith(suffix)) {
      if (!flags.quiet) {
        return {
          stdout: "",
          stderr: `${cmdName}: ${file} already has ${suffix} suffix -- unchanged\n`,
          exitCode: 1
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    }

    const level = getCompressionLevel(flags);
    let compressed: Uint8Array;

    try {
      compressed = gzipSync(inputData, { level });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      return {
        stdout: "",
        stderr: `${cmdName}: ${file}: ${msg}\n`,
        exitCode: 1
      };
    }

    if (toStdout) {
      // Output to stdout as binary
      return {
        stdout: toBinaryString(compressed),
        stderr: "",
        exitCode: 0
      };
    }

    outputPath = inputPath + suffix;

    // Check if output exists
    if (!flags.force) {
      try {
        await ctx.fs.stat(outputPath);
        return {
          stdout: "",
          stderr: `${cmdName}: ${outputPath} already exists; not overwritten\n`,
          exitCode: 1
        };
      } catch {
        // File doesn't exist, good to proceed
      }
    }

    // Write compressed file
    await ctx.fs.writeFile(outputPath, compressed);

    // Remove original unless -k
    if (!flags.keep && !toStdout) {
      await ctx.fs.rm(inputPath);
    }

    if (flags.verbose) {
      const ratio =
        inputData.length > 0
          ? ((1 - compressed.length / inputData.length) * 100).toFixed(1)
          : "0.0";
      return {
        stdout: "",
        stderr: `${file}:\t${ratio}% -- replaced with ${outputPath.split("/").pop()}\n`,
        exitCode: 0
      };
    }

    return { stdout: "", stderr: "", exitCode: 0 };
  }
}

async function processDirectory(
  ctx: CommandContext,
  dirPath: string,
  flags: GzipFlags,
  cmdName: string,
  decompress: boolean,
  toStdout: boolean
): Promise<GzipResult> {
  const entries = await ctx.fs.readdir(dirPath);
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  for (const entry of entries) {
    const entryPath = ctx.fs.resolvePath(dirPath, entry);
    const stat = await ctx.fs.stat(entryPath);

    if (stat.isDirectory) {
      const result = await processDirectory(
        ctx,
        entryPath,
        flags,
        cmdName,
        decompress,
        toStdout
      );
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.exitCode !== 0) exitCode = result.exitCode;
    } else if (stat.isFile) {
      // For decompression, only process files with the suffix
      // For compression, skip files that already have the suffix
      const suffix = flags.suffix;
      if (decompress && !entry.endsWith(suffix)) continue;
      if (!decompress && entry.endsWith(suffix)) continue;

      const relativePath = entryPath.startsWith(`${ctx.cwd}/`)
        ? entryPath.slice(ctx.cwd.length + 1)
        : entryPath;
      const result = await processFile(
        ctx,
        relativePath,
        flags,
        cmdName,
        decompress,
        toStdout
      );
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.exitCode !== 0) exitCode = result.exitCode;
    }
  }

  return { stdout, stderr, exitCode };
}

async function listFile(
  ctx: CommandContext,
  file: string,
  flags: GzipFlags,
  cmdName: string
): Promise<GzipResult> {
  let inputData: Uint8Array;

  if (file === "-" || file === "") {
    inputData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
  } else {
    const inputPath = ctx.fs.resolvePath(ctx.cwd, file);
    try {
      inputData = await ctx.fs.readFileBuffer(inputPath);
    } catch {
      return {
        stdout: "",
        stderr: `${cmdName}: ${file}: No such file or directory\n`,
        exitCode: 1
      };
    }
  }

  if (!isGzip(inputData)) {
    if (!flags.quiet) {
      return {
        stdout: "",
        stderr: `${cmdName}: ${file}: not in gzip format\n`,
        exitCode: 1
      };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  }

  const compressed = inputData.length;
  const uncompressed = getUncompressedSize(inputData);
  const ratio =
    uncompressed > 0
      ? ((1 - compressed / uncompressed) * 100).toFixed(1)
      : "0.0";

  const header = parseGzipHeader(inputData);
  const name =
    header.originalName || (file === "-" ? "" : file.replace(/\.gz$/, ""));

  // Format: compressed uncompressed ratio uncompressed_name
  const line = `${compressed.toString().padStart(10)} ${uncompressed.toString().padStart(10)} ${ratio.padStart(5)}% ${name}\n`;

  return { stdout: line, stderr: "", exitCode: 0 };
}

async function testFile(
  ctx: CommandContext,
  file: string,
  flags: GzipFlags,
  cmdName: string
): Promise<GzipResult> {
  let inputData: Uint8Array;

  if (file === "-" || file === "") {
    inputData = Uint8Array.from(ctx.stdin, (c) => c.charCodeAt(0));
  } else {
    const inputPath = ctx.fs.resolvePath(ctx.cwd, file);
    try {
      inputData = await ctx.fs.readFileBuffer(inputPath);
    } catch {
      return {
        stdout: "",
        stderr: `${cmdName}: ${file}: No such file or directory\n`,
        exitCode: 1
      };
    }
  }

  if (!isGzip(inputData)) {
    if (!flags.quiet) {
      return {
        stdout: "",
        stderr: `${cmdName}: ${file}: not in gzip format\n`,
        exitCode: 1
      };
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  }

  try {
    gunzipWithLimit(inputData, getMaxDecompressedSize(ctx));
    if (flags.verbose) {
      return { stdout: "", stderr: `${file}:\tOK\n`, exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "invalid";
    return {
      stdout: "",
      stderr: `${cmdName}: ${file}: ${msg}\n`,
      exitCode: 1
    };
  }
}

async function executeGzip(
  args: string[],
  ctx: CommandContext,
  cmdName: "gzip" | "gunzip" | "zcat"
): Promise<ExecResult> {
  // Determine help based on command name
  const help =
    cmdName === "zcat"
      ? zcatHelp
      : cmdName === "gunzip"
        ? gunzipHelp
        : gzipHelp;

  if (hasHelpFlag(args)) {
    return showHelp(help);
  }

  const parsed = parseArgs(cmdName, args, argDefs);
  if (!parsed.ok) {
    // Check if it's an unknown option error
    if (parsed.error.stderr.includes("unrecognized option")) {
      return parsed.error;
    }
    return parsed.error;
  }

  const flags = parsed.result.flags as GzipFlags;
  let files = parsed.result.positional;

  // Determine mode based on command name and flags
  const decompress =
    cmdName === "gunzip" ||
    cmdName === "zcat" ||
    flags.decompress ||
    flags.uncompress;
  const toStdout = cmdName === "zcat" || flags.stdout || flags.toStdout;

  // Handle -l (list)
  if (flags.list) {
    if (files.length === 0) files = ["-"];

    let stdout = "  compressed uncompressed  ratio uncompressed_name\n";
    let stderr = "";
    let exitCode = 0;

    for (const file of files) {
      const result = await listFile(ctx, file, flags, cmdName);
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.exitCode !== 0) exitCode = result.exitCode;
    }

    return { stdout, stderr, exitCode };
  }

  // Handle -t (test)
  if (flags.test) {
    if (files.length === 0) files = ["-"];

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (const file of files) {
      const result = await testFile(ctx, file, flags, cmdName);
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.exitCode !== 0) exitCode = result.exitCode;
    }

    return { stdout, stderr, exitCode };
  }

  // No files specified - use stdin
  if (files.length === 0) {
    files = ["-"];
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  for (const file of files) {
    const result = await processFile(
      ctx,
      file,
      flags,
      cmdName,
      decompress,
      toStdout
    );
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) exitCode = result.exitCode;
  }

  return { stdout, stderr, exitCode };
}

export const gzipCommand: Command = {
  name: "gzip",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const result = await executeGzip(args, ctx, "gzip");
    return { ...result, stdoutEncoding: "binary" };
  }
};

export const gunzipCommand: Command = {
  name: "gunzip",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const result = await executeGzip(args, ctx, "gunzip");
    return { ...result, stdoutEncoding: "binary" };
  }
};

export const zcatCommand: Command = {
  name: "zcat",
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const result = await executeGzip(args, ctx, "zcat");
    return { ...result, stdoutEncoding: "binary" };
  }
};

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "gzip",
  flags: [
    { flag: "-c", type: "boolean" },
    { flag: "-d", type: "boolean" },
    { flag: "-f", type: "boolean" },
    { flag: "-k", type: "boolean" },
    { flag: "-l", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-r", type: "boolean" },
    { flag: "-t", type: "boolean" },
    { flag: "-v", type: "boolean" },
    { flag: "-1", type: "boolean" },
    { flag: "-9", type: "boolean" }
  ],
  stdinType: "binary",
  needsFiles: true
};

export const gunzipFlagsForFuzzing: CommandFuzzInfo = {
  name: "gunzip",
  flags: [
    { flag: "-c", type: "boolean" },
    { flag: "-f", type: "boolean" },
    { flag: "-k", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-v", type: "boolean" }
  ],
  stdinType: "binary",
  needsFiles: true
};

export const zcatFlagsForFuzzing: CommandFuzzInfo = {
  name: "zcat",
  flags: [
    { flag: "-f", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-v", type: "boolean" }
  ],
  stdinType: "binary",
  needsFiles: true
};
