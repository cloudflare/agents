/**
 * Command Resolution
 *
 * Handles PATH-based command resolution and lookup for external commands.
 */

import type { IFileSystem } from "../fs/interface";
import type { Command, CommandRegistry } from "../types";
import type { InterpreterState } from "./types";

/**
 * Context needed for command resolution
 */
export interface CommandResolutionContext {
  fs: IFileSystem;
  state: InterpreterState;
  commands: CommandRegistry;
}

/**
 * Result type for command resolution
 */
export type ResolveCommandResult =
  | { cmd: Command; path: string }
  | { script: true; path: string }
  | { error: "not_found" | "permission_denied"; path?: string }
  | null;

/**
 * Resolve a command name to its implementation via PATH lookup.
 * Returns the command and its resolved path, or null if not found.
 *
 * Resolution order:
 * 1. If command contains "/", resolve as a path
 * 2. Search PATH directories for the command file
 * 3. Fall back to registry lookup (for non-InMemoryFs filesystems like OverlayFs)
 */
export async function resolveCommand(
  ctx: CommandResolutionContext,
  commandName: string,
  pathOverride?: string
): Promise<ResolveCommandResult> {
  // If command contains "/", it's a path - resolve directly
  if (commandName.includes("/")) {
    const resolvedPath = ctx.fs.resolvePath(ctx.state.cwd, commandName);
    // Check if file exists
    if (!(await ctx.fs.exists(resolvedPath))) {
      return { error: "not_found", path: resolvedPath };
    }
    // Extract command name from path
    const cmdName = resolvedPath.split("/").pop() || commandName;
    const cmd = ctx.commands.get(cmdName);

    // Check file properties
    try {
      const stat = await ctx.fs.stat(resolvedPath);
      if (stat.isDirectory) {
        // Trying to execute a directory
        return { error: "permission_denied", path: resolvedPath };
      }
      // For registered commands (like /bin/echo), skip execute check
      // since they're our internal implementations
      if (cmd) {
        return { cmd, path: resolvedPath };
      }
      // For non-registered commands, check if the file is executable
      const isExecutable = (stat.mode & 0o111) !== 0;
      if (!isExecutable) {
        // File exists but is not executable - permission denied
        return { error: "permission_denied", path: resolvedPath };
      }
      // File exists and is executable - treat as user script
      return { script: true, path: resolvedPath };
    } catch {
      // If stat fails, treat as not found
      return { error: "not_found", path: resolvedPath };
    }
  }

  // Check hash table first (unless pathOverride is set, which bypasses cache)
  if (!pathOverride && ctx.state.hashTable) {
    const cachedPath = ctx.state.hashTable.get(commandName);
    if (cachedPath) {
      // Verify the cached path still exists
      if (await ctx.fs.exists(cachedPath)) {
        const cmd = ctx.commands.get(commandName);
        if (cmd) {
          return { cmd, path: cachedPath };
        }
        // Also check if it's an executable script (not just registered commands)
        try {
          const stat = await ctx.fs.stat(cachedPath);
          if (!stat.isDirectory && (stat.mode & 0o111) !== 0) {
            return { script: true, path: cachedPath };
          }
        } catch {
          // If stat fails, fall through to PATH search
        }
      } else {
        // Remove stale entry from hash table
        ctx.state.hashTable.delete(commandName);
      }
    }
  }

  // Search PATH directories (use override if provided, for command -p)
  const pathEnv = pathOverride ?? ctx.state.env.get("PATH") ?? "/usr/bin:/bin";
  const pathDirs = pathEnv.split(":");

  for (const dir of pathDirs) {
    if (!dir) continue;
    // Resolve relative PATH directories against cwd
    const resolvedDir = dir.startsWith("/")
      ? dir
      : ctx.fs.resolvePath(ctx.state.cwd, dir);
    const fullPath = `${resolvedDir}/${commandName}`;
    if (await ctx.fs.exists(fullPath)) {
      // File exists - check if it's a directory
      try {
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory) {
          continue; // Skip directories
        }
        const isExecutable = (stat.mode & 0o111) !== 0;
        // Check for registered command handler
        const cmd = ctx.commands.get(commandName);

        // Determine if this is a system directory where command stubs live
        const isSystemDir = dir === "/bin" || dir === "/usr/bin";

        if (cmd && isSystemDir) {
          // Registered commands in system directories work without execute bits
          // (they're our internal implementations with stub files)
          return { cmd, path: fullPath };
        }

        // For non-system directories (or non-registered commands), require executable
        if (isExecutable) {
          if (cmd && !isSystemDir) {
            // User script shadows a registered command - treat as script
            return { script: true, path: fullPath };
          }
          if (!cmd) {
            // No registered handler - treat as user script
            return { script: true, path: fullPath };
          }
        }
      } catch {
        // If stat fails, continue searching
      }
    }
  }

  // Fallback: check registry directly only if /usr/bin doesn't exist
  // This maintains backward compatibility for OverlayFs and other non-InMemoryFs
  // where command stubs aren't created, while still respecting PATH for InMemoryFs
  const usrBinExists = await ctx.fs.exists("/usr/bin");
  if (!usrBinExists) {
    const cmd = ctx.commands.get(commandName);
    if (cmd) {
      return { cmd, path: `/usr/bin/${commandName}` };
    }
  }

  return null;
}

/**
 * Find all paths for a command in PATH (for `which -a`).
 */
export async function findCommandInPath(
  ctx: CommandResolutionContext,
  commandName: string
): Promise<string[]> {
  const paths: string[] = [];

  // If command contains /, it's a path - check if it exists and is executable
  if (commandName.includes("/")) {
    const resolvedPath = ctx.fs.resolvePath(ctx.state.cwd, commandName);
    if (await ctx.fs.exists(resolvedPath)) {
      try {
        const stat = await ctx.fs.stat(resolvedPath);
        if (!stat.isDirectory) {
          // Check if file is executable (owner, group, or other execute bit set)
          const isExecutable = (stat.mode & 0o111) !== 0;
          if (isExecutable) {
            // Return the original path format (not resolved) to match bash behavior
            paths.push(commandName);
          }
        }
      } catch {
        // If stat fails, skip
      }
    }
    return paths;
  }

  const pathEnv = ctx.state.env.get("PATH") || "/usr/bin:/bin";
  const pathDirs = pathEnv.split(":");

  for (const dir of pathDirs) {
    if (!dir) continue;
    // Resolve relative PATH entries relative to cwd
    const resolvedDir = dir.startsWith("/")
      ? dir
      : ctx.fs.resolvePath(ctx.state.cwd, dir);
    const fullPath = `${resolvedDir}/${commandName}`;
    if (await ctx.fs.exists(fullPath)) {
      // Check if it's a directory - skip directories
      try {
        const stat = await ctx.fs.stat(fullPath);
        if (stat.isDirectory) {
          continue;
        }
      } catch {
        continue;
      }
      // Return the original path format (relative if relative was given)
      paths.push(dir.startsWith("/") ? fullPath : `${dir}/${commandName}`);
    }
  }

  return paths;
}
