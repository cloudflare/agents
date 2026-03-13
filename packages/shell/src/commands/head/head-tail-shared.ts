/**
 * Shared utilities for head and tail commands.
 */

import type { CommandContext, ExecResult } from "../../types";
import { unknownOption } from "../help";

export interface HeadTailOptions {
  lines: number;
  bytes: number | null;
  quiet: boolean;
  verbose: boolean;
  files: string[];
  /** tail-specific: start from line N instead of last N lines */
  fromLine?: boolean;
}

export type HeadTailParseResult =
  | { ok: true; options: HeadTailOptions }
  | { ok: false; error: ExecResult };

/**
 * Parse head/tail command arguments.
 * Both commands share most options, with tail having additional +N syntax.
 */
export function parseHeadTailArgs(
  args: string[],
  cmdName: "head" | "tail"
): HeadTailParseResult {
  let lines = 10;
  let bytes: number | null = null;
  let quiet = false;
  let verbose = false;
  let fromLine = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-n" && i + 1 < args.length) {
      const nextArg = args[++i];
      // tail supports +N syntax
      if (cmdName === "tail" && nextArg.startsWith("+")) {
        fromLine = true;
        lines = parseInt(nextArg.slice(1), 10);
      } else {
        lines = parseInt(nextArg, 10);
      }
    } else if (cmdName === "tail" && arg.startsWith("-n+")) {
      fromLine = true;
      lines = parseInt(arg.slice(3), 10);
    } else if (arg.startsWith("-n")) {
      lines = parseInt(arg.slice(2), 10);
    } else if (arg === "-c" && i + 1 < args.length) {
      bytes = parseInt(args[++i], 10);
    } else if (arg.startsWith("-c")) {
      bytes = parseInt(arg.slice(2), 10);
    } else if (arg.startsWith("--bytes=")) {
      bytes = parseInt(arg.slice(8), 10);
    } else if (arg.startsWith("--lines=")) {
      lines = parseInt(arg.slice(8), 10);
    } else if (arg === "-q" || arg === "--quiet" || arg === "--silent") {
      quiet = true;
    } else if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (arg.match(/^-\d+$/)) {
      lines = parseInt(arg.slice(1), 10);
    } else if (arg.startsWith("--")) {
      return { ok: false, error: unknownOption(cmdName, arg) };
    } else if (arg.startsWith("-") && arg !== "-") {
      return { ok: false, error: unknownOption(cmdName, arg) };
    } else {
      files.push(arg);
    }
  }

  // Validate bytes
  if (bytes !== null && (Number.isNaN(bytes) || bytes < 0)) {
    return {
      ok: false,
      error: {
        stdout: "",
        stderr: `${cmdName}: invalid number of bytes\n`,
        exitCode: 1
      }
    };
  }

  // Validate lines
  if (Number.isNaN(lines) || lines < 0) {
    return {
      ok: false,
      error: {
        stdout: "",
        stderr: `${cmdName}: invalid number of lines\n`,
        exitCode: 1
      }
    };
  }

  return {
    ok: true,
    options: { lines, bytes, quiet, verbose, files, fromLine }
  };
}

/**
 * Process files for head/tail commands.
 * Handles stdin, multiple files, headers, and error handling.
 */
export async function processHeadTailFiles(
  ctx: CommandContext,
  options: HeadTailOptions,
  cmdName: "head" | "tail",
  contentProcessor: (content: string) => string
): Promise<ExecResult> {
  const { quiet, verbose, files } = options;

  // If no files, read from stdin
  if (files.length === 0) {
    return {
      stdout: contentProcessor(ctx.stdin),
      stderr: "",
      exitCode: 0
    };
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  // Determine whether to show headers
  // -v always shows, -q never shows, default shows for multiple files
  const showHeaders = verbose || (!quiet && files.length > 1);

  let filesProcessed = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    try {
      const filePath = ctx.fs.resolvePath(ctx.cwd, file);
      const content = await ctx.fs.readFile(filePath);

      // Show header if needed - only after we know the file exists
      if (showHeaders) {
        if (filesProcessed > 0) stdout += "\n";
        stdout += `==> ${file} <==\n`;
      }
      stdout += contentProcessor(content);
      filesProcessed++;
    } catch {
      stderr += `${cmdName}: ${file}: No such file or directory\n`;
      exitCode = 1;
    }
  }

  return { stdout, stderr, exitCode };
}

/**
 * Get the first N lines or bytes from content.
 */
export function getHead(
  content: string,
  lines: number,
  bytes: number | null
): string {
  if (bytes !== null) {
    return content.slice(0, bytes);
  }

  if (lines === 0) return "";

  let pos = 0;
  let lineCount = 0;
  const len = content.length;

  while (pos < len && lineCount < lines) {
    const nextNewline = content.indexOf("\n", pos);
    if (nextNewline === -1) {
      // No more newlines, rest of content is last line
      return `${content}\n`;
    }
    lineCount++;
    pos = nextNewline + 1;
  }

  return pos > 0 ? content.slice(0, pos) : "";
}

/**
 * Get the last N lines or bytes from content.
 */
export function getTail(
  content: string,
  lines: number,
  bytes: number | null,
  fromLine: boolean
): string {
  if (bytes !== null) {
    return content.slice(-bytes);
  }

  const len = content.length;
  if (len === 0) return "";

  // For fromLine (+n), count from start
  if (fromLine) {
    let pos = 0;
    let lineCount = 1;
    while (pos < len && lineCount < lines) {
      const nextNewline = content.indexOf("\n", pos);
      if (nextNewline === -1) break;
      lineCount++;
      pos = nextNewline + 1;
    }
    const result = content.slice(pos);
    return result.endsWith("\n") ? result : `${result}\n`;
  }

  if (lines === 0) return "";

  // Scan backwards to find last N newlines
  let pos = len - 1;
  if (content[pos] === "\n") pos--;

  let lineCount = 0;
  while (pos >= 0 && lineCount < lines) {
    if (content[pos] === "\n") {
      lineCount++;
      if (lineCount === lines) {
        pos++;
        break;
      }
    }
    pos--;
  }

  if (pos < 0) pos = 0;
  const result = content.slice(pos);
  return content[len - 1] === "\n" ? result : `${result}\n`;
}
