/**
 * Directory Stack Builtins: pushd, popd, dirs
 *
 * pushd [dir] - Push directory onto stack and cd to it
 * popd - Pop directory from stack and cd to previous
 * dirs [-clpv] - Display directory stack
 */

import type { ExecResult } from "../../types";
import { failure, OK, success } from "../helpers/result";
import type { InterpreterContext } from "../types";

/**
 * Get the directory stack, initializing if needed
 */
function getStack(ctx: InterpreterContext): string[] {
  ctx.state.directoryStack ??= [];
  return ctx.state.directoryStack;
}

/**
 * Format a path, replacing HOME prefix with ~
 */
function formatPath(path: string, home: string): string {
  if (home && path === home) {
    return "~";
  }
  if (home && path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/**
 * Normalize a path by resolving . and ..
 */
function normalizePath(path: string): string {
  const parts = path.split("/").filter((p) => p && p !== ".");
  const result: string[] = [];

  for (const part of parts) {
    if (part === "..") {
      result.pop();
    } else {
      result.push(part);
    }
  }

  return `/${result.join("/")}`;
}

/**
 * pushd - Push directory onto stack and cd to it
 *
 * pushd [dir] - Push current dir, cd to dir
 */
export async function handlePushd(
  ctx: InterpreterContext,
  args: string[]
): Promise<ExecResult> {
  const stack = getStack(ctx);
  let targetDir: string | undefined;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      if (i + 1 < args.length) {
        if (targetDir !== undefined) {
          return failure("bash: pushd: too many arguments\n", 2);
        }
        targetDir = args[i + 1];
        i++;
      }
    } else if (arg.startsWith("-") && arg !== "-") {
      // Unknown option
      return failure(`bash: pushd: ${arg}: invalid option\n`, 2);
    } else {
      if (targetDir !== undefined) {
        return failure("bash: pushd: too many arguments\n", 2);
      }
      targetDir = arg;
    }
  }

  if (targetDir === undefined) {
    // No dir specified - swap top two entries if possible
    if (stack.length < 2) {
      return failure("bash: pushd: no other directory\n", 1);
    }
    const top = stack[0];
    stack[0] = stack[1];
    stack[1] = top;
    targetDir = stack[0];
  }

  // Resolve the target directory
  let resolvedDir: string;
  if (targetDir.startsWith("/")) {
    resolvedDir = targetDir;
  } else if (targetDir === "..") {
    const parts = ctx.state.cwd.split("/").filter((p) => p);
    parts.pop();
    resolvedDir = `/${parts.join("/")}`;
  } else if (targetDir === ".") {
    resolvedDir = ctx.state.cwd;
  } else if (targetDir.startsWith("~")) {
    const home = ctx.state.env.get("HOME") || "/";
    resolvedDir = home + targetDir.slice(1);
  } else {
    resolvedDir = `${ctx.state.cwd}/${targetDir}`;
  }

  // Normalize the path
  resolvedDir = normalizePath(resolvedDir);

  // Check if directory exists
  try {
    const stat = await ctx.fs.stat(resolvedDir);
    if (!stat.isDirectory) {
      return failure(`bash: pushd: ${targetDir}: Not a directory\n`, 1);
    }
  } catch {
    return failure(`bash: pushd: ${targetDir}: No such file or directory\n`, 1);
  }

  // Push current directory onto stack
  stack.unshift(ctx.state.cwd);

  // Change to new directory
  ctx.state.previousDir = ctx.state.cwd;
  ctx.state.cwd = resolvedDir;
  ctx.state.env.set("PWD", resolvedDir);
  ctx.state.env.set("OLDPWD", ctx.state.previousDir);

  // Output the stack (pushd DOES do tilde substitution)
  const home = ctx.state.env.get("HOME") || "";
  const output = `${[resolvedDir, ...stack].map((p) => formatPath(p, home)).join(" ")}\n`;

  return success(output);
}

/**
 * popd - Pop directory from stack and cd to it
 */
export function handlePopd(
  ctx: InterpreterContext,
  args: string[]
): ExecResult {
  const stack = getStack(ctx);

  // Parse arguments
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      return failure(`bash: popd: ${arg}: invalid option\n`, 2);
    }
    // popd doesn't take positional arguments
    return failure("bash: popd: too many arguments\n", 2);
  }

  if (stack.length === 0) {
    return failure("bash: popd: directory stack empty\n", 1);
  }

  // Pop the top entry and cd to it
  const newDir = stack.shift();
  if (!newDir) {
    return failure("bash: popd: directory stack empty\n", 1);
  }

  // Change to the popped directory
  ctx.state.previousDir = ctx.state.cwd;
  ctx.state.cwd = newDir;
  ctx.state.env.set("PWD", newDir);
  ctx.state.env.set("OLDPWD", ctx.state.previousDir);

  // Output the stack (popd DOES do tilde substitution)
  const home = ctx.state.env.get("HOME") || "";
  const output = `${[newDir, ...stack].map((p) => formatPath(p, home)).join(" ")}\n`;

  return success(output);
}

/**
 * dirs - Display directory stack
 *
 * dirs [-clpv]
 *   -c: Clear the stack
 *   -l: Long format (no tilde substitution)
 *   -p: One entry per line
 *   -v: One entry per line with index numbers
 */
export function handleDirs(
  ctx: InterpreterContext,
  args: string[]
): ExecResult {
  const stack = getStack(ctx);

  let clearStack = false;
  let longFormat = false;
  let perLine = false;
  let withNumbers = false;

  // Parse arguments
  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg.startsWith("-")) {
      for (const flag of arg.slice(1)) {
        if (flag === "c") clearStack = true;
        else if (flag === "l") longFormat = true;
        else if (flag === "p") perLine = true;
        else if (flag === "v") {
          perLine = true;
          withNumbers = true;
        } else {
          return failure(`bash: dirs: -${flag}: invalid option\n`, 2);
        }
      }
    } else {
      // dirs doesn't take positional arguments
      return failure("bash: dirs: too many arguments\n", 1);
    }
  }

  if (clearStack) {
    ctx.state.directoryStack = [];
    return OK;
  }

  // Build the stack display (current dir + stack)
  const fullStack = [ctx.state.cwd, ...stack];
  const home = ctx.state.env.get("HOME") || "";

  let output: string;
  if (withNumbers) {
    output = fullStack
      .map((p, i) => {
        const path = longFormat ? p : formatPath(p, home);
        return ` ${i}  ${path}`;
      })
      .join("\n");
    output += "\n";
  } else if (perLine) {
    output =
      fullStack.map((p) => (longFormat ? p : formatPath(p, home))).join("\n") +
      "\n";
  } else {
    output =
      fullStack.map((p) => (longFormat ? p : formatPath(p, home))).join(" ") +
      "\n";
  }

  return success(output);
}
