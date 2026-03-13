import { getErrorMessage } from "../../interpreter/helpers/errors";
import type { Command, CommandContext, ExecResult } from "../../types";
import { parseArgs } from "../../utils/args";

const USAGE = `Usage: rmdir [-pv] DIRECTORY...
Remove empty directories.

Options:
  -p, --parents   Remove DIRECTORY and its ancestors
  -v, --verbose   Output a diagnostic for every directory processed`;

const argDefs = {
  parents: { short: "p", long: "parents", type: "boolean" as const },
  verbose: { short: "v", long: "verbose", type: "boolean" as const },
  help: { long: "help", type: "boolean" as const }
};

export const rmdirCommand: Command = {
  name: "rmdir",

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const parsed = parseArgs("rmdir", args, argDefs);
    if (!parsed.ok) return parsed.error;

    if (parsed.result.flags.help) {
      return { stdout: `${USAGE}\n`, stderr: "", exitCode: 0 };
    }

    const parents = parsed.result.flags.parents;
    const verbose = parsed.result.flags.verbose;
    const dirs = parsed.result.positional;

    if (dirs.length === 0) {
      return {
        stdout: "",
        stderr: "rmdir: missing operand\n",
        exitCode: 1
      };
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (const dir of dirs) {
      const result = await removeDir(ctx, dir, parents, verbose);
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.exitCode !== 0) {
        exitCode = result.exitCode;
      }
    }

    return { stdout, stderr, exitCode };
  }
};

async function removeDir(
  ctx: CommandContext,
  dir: string,
  parents: boolean,
  verbose: boolean
): Promise<ExecResult> {
  let stdout = "";
  let stderr = "";
  const exitCode = 0;

  const fullPath = ctx.fs.resolvePath(ctx.cwd, dir);

  // First, try to remove the directory itself
  const result = await removeSingleDir(ctx, fullPath, dir, verbose);
  stdout += result.stdout;
  stderr += result.stderr;
  if (result.exitCode !== 0) {
    return { stdout, stderr, exitCode: result.exitCode };
  }

  // If -p flag, remove parent directories
  if (parents) {
    let currentPath = fullPath;
    let currentDir = dir;

    // Keep removing parent directories until we hit an error or root
    while (true) {
      const parentPath = getParentPath(currentPath);
      const parentDir = getParentPath(currentDir);

      // Stop if we've reached root or the parent is the same as current
      if (
        parentPath === currentPath ||
        parentPath === "/" ||
        parentPath === "." ||
        parentDir === "." ||
        parentDir === ""
      ) {
        break;
      }

      const parentResult = await removeSingleDir(
        ctx,
        parentPath,
        parentDir,
        verbose
      );
      stdout += parentResult.stdout;

      // For -p, we stop on first error but don't report it as failure
      // if we've already removed at least one directory
      if (parentResult.exitCode !== 0) {
        // Don't propagate parent removal errors - they're expected
        // when parents are non-empty or don't exist
        break;
      }

      currentPath = parentPath;
      currentDir = parentDir;
    }
  }

  return { stdout, stderr, exitCode };
}

async function removeSingleDir(
  ctx: CommandContext,
  fullPath: string,
  displayPath: string,
  verbose: boolean
): Promise<ExecResult> {
  try {
    // Check if path exists
    const exists = await ctx.fs.exists(fullPath);
    if (!exists) {
      return {
        stdout: "",
        stderr: `rmdir: failed to remove '${displayPath}': No such file or directory\n`,
        exitCode: 1
      };
    }

    // Check if it's a directory
    const stat = await ctx.fs.stat(fullPath);
    if (!stat.isDirectory) {
      return {
        stdout: "",
        stderr: `rmdir: failed to remove '${displayPath}': Not a directory\n`,
        exitCode: 1
      };
    }

    // Check if directory is empty
    const entries = await ctx.fs.readdir(fullPath);
    if (entries.length > 0) {
      return {
        stdout: "",
        stderr: `rmdir: failed to remove '${displayPath}': Directory not empty\n`,
        exitCode: 1
      };
    }

    // Remove the empty directory
    await ctx.fs.rm(fullPath, { recursive: false, force: false });

    let stdout = "";
    if (verbose) {
      stdout = `rmdir: removing directory, '${displayPath}'\n`;
    }

    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const message = getErrorMessage(error);
    return {
      stdout: "",
      stderr: `rmdir: failed to remove '${displayPath}': ${message}\n`,
      exitCode: 1
    };
  }
}

function getParentPath(path: string): string {
  // Remove trailing slashes
  const normalized = path.replace(/\/+$/, "");

  // Find the last slash
  const lastSlash = normalized.lastIndexOf("/");

  if (lastSlash === -1) {
    // No slash, parent is "."
    return ".";
  }

  if (lastSlash === 0) {
    // Root directory
    return "/";
  }

  return normalized.substring(0, lastSlash);
}

import type { CommandFuzzInfo } from "../fuzz-flags-types";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "rmdir",
  flags: [
    { flag: "-p", type: "boolean" },
    { flag: "-v", type: "boolean" }
  ],
  needsArgs: true
};
