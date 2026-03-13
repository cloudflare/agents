/**
 * File reading utilities for command implementations.
 *
 * Provides common patterns for reading from files or stdin,
 * including parallel batch reading for performance.
 */

import type { CommandContext, ExecResult } from "../types";
import { DEFAULT_BATCH_SIZE } from "./constants";

export interface ReadFilesOptions {
  /** Command name for error messages */
  cmdName: string;
  /** If true, "-" in file list means stdin */
  allowStdinMarker?: boolean;
  /** If true, stop on first error. If false, collect errors and continue */
  stopOnError?: boolean;
  /** Number of files to read in parallel (default: 100). Set to 1 for sequential. */
  batchSize?: number;
}

export interface FileContent {
  /** File name (or "-" for stdin, or "" if stdin with no files) */
  filename: string;
  /** File content */
  content: string;
}

export interface ReadFilesResult {
  /** Successfully read files */
  files: FileContent[];
  /** Error messages (e.g., "cmd: file: No such file or directory\n") */
  stderr: string;
  /** 0 if all files read successfully, 1 if any errors */
  exitCode: number;
}

/**
 * Read content from files or stdin.
 *
 * If files array is empty, reads from stdin.
 * If files contains "-", reads stdin at that position.
 *
 * @example
 * const result = await readFiles(ctx, files, { cmdName: "cat" });
 * if (result.exitCode !== 0 && options.stopOnError) {
 *   return { stdout: "", stderr: result.stderr, exitCode: result.exitCode };
 * }
 * for (const { filename, content } of result.files) {
 *   // process content
 * }
 */
export async function readFiles(
  ctx: CommandContext,
  files: string[],
  options: ReadFilesOptions
): Promise<ReadFilesResult> {
  const {
    cmdName,
    allowStdinMarker = true,
    stopOnError = false,
    batchSize = DEFAULT_BATCH_SIZE
  } = options;

  // No files - read from stdin
  if (files.length === 0) {
    return {
      files: [{ filename: "", content: ctx.stdin }],
      stderr: "",
      exitCode: 0
    };
  }

  const result: FileContent[] = [];
  let stderr = "";
  let exitCode = 0;

  // Process files in parallel batches for better performance
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        if (allowStdinMarker && file === "-") {
          return { filename: "-", content: ctx.stdin, error: null };
        }
        try {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          // Use binary encoding to preserve all bytes (including non-UTF-8).
          // This is important for piping binary data through commands like cat.
          // UTF-8 decoding happens at the output boundary (Bash.exec) instead.
          const content = await ctx.fs.readFile(filePath, "binary");
          return { filename: file, content, error: null };
        } catch {
          return {
            filename: file,
            content: "",
            error: `${cmdName}: ${file}: No such file or directory\n`
          };
        }
      })
    );

    // Process results in order
    for (const r of batchResults) {
      if (r.error) {
        stderr += r.error;
        exitCode = 1;
        if (stopOnError) {
          return { files: result, stderr, exitCode };
        }
      } else {
        result.push({ filename: r.filename, content: r.content });
      }
    }
  }

  return { files: result, stderr, exitCode };
}

/**
 * Read and concatenate all files into a single string.
 *
 * Useful for commands like sort and uniq that process all input together.
 *
 * @example
 * const result = await readAndConcat(ctx, files, { cmdName: "sort" });
 * if (!result.ok) return result.error;
 * const lines = result.content.split("\n");
 */
export async function readAndConcat(
  ctx: CommandContext,
  files: string[],
  options: { cmdName: string; allowStdinMarker?: boolean }
): Promise<{ ok: true; content: string } | { ok: false; error: ExecResult }> {
  const result = await readFiles(ctx, files, {
    ...options,
    stopOnError: true
  });

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: { stdout: "", stderr: result.stderr, exitCode: result.exitCode }
    };
  }

  const content = result.files.map((f) => f.content).join("");
  return { ok: true, content };
}
