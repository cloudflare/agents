/**
 * hash - Manage the hash table of remembered command locations
 *
 * hash [-lr] [-p pathname] [-dt] [name ...]
 *
 * Hash maintains a hash table of recently executed commands for faster lookup.
 *
 * Options:
 *   (no args)  Display the hash table
 *   name       Add name to the hash table (look up in PATH)
 *   -r         Clear the hash table
 *   -d name    Remove name from the hash table
 *   -l         Display in a format that can be reused as input
 *   -p path    Use path as the full pathname for name (hash -p /path name)
 *   -t name    Print the remembered location of name
 */

import type { ExecResult } from "../../types";
import { failure, OK, success } from "../helpers/result";
import type { InterpreterContext } from "../types";

export async function handleHash(
  ctx: InterpreterContext,
  args: string[]
): Promise<ExecResult> {
  // Initialize hash table if needed
  if (!ctx.state.hashTable) {
    ctx.state.hashTable = new Map();
  }

  // Parse options
  let clearTable = false;
  let deleteMode = false;
  let listMode = false;
  let pathMode = false;
  let showPath = false;
  let pathname = "";
  const names: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      // Remaining args are names
      names.push(...args.slice(i));
      break;
    }
    if (arg === "-r") {
      clearTable = true;
      i++;
    } else if (arg === "-d") {
      deleteMode = true;
      i++;
    } else if (arg === "-l") {
      listMode = true;
      i++;
    } else if (arg === "-t") {
      showPath = true;
      i++;
    } else if (arg === "-p") {
      pathMode = true;
      i++;
      if (i >= args.length) {
        return failure("bash: hash: -p: option requires an argument\n", 1);
      }
      pathname = args[i];
      i++;
    } else if (arg.startsWith("-") && arg.length > 1) {
      // Handle combined options like -rt
      for (const char of arg.slice(1)) {
        if (char === "r") {
          clearTable = true;
        } else if (char === "d") {
          deleteMode = true;
        } else if (char === "l") {
          listMode = true;
        } else if (char === "t") {
          showPath = true;
        } else if (char === "p") {
          return failure("bash: hash: -p: option requires an argument\n", 1);
        } else {
          return failure(`bash: hash: -${char}: invalid option\n`, 1);
        }
      }
      i++;
    } else {
      names.push(arg);
      i++;
    }
  }

  // Handle -r (clear table)
  if (clearTable) {
    // bash allows extra args with -r (just ignores them)
    // This is marked as a "BUG" in the spec tests, but we match bash behavior
    ctx.state.hashTable.clear();
    return OK;
  }

  // Handle -d (delete from table)
  if (deleteMode) {
    if (names.length === 0) {
      return failure("bash: hash: -d: option requires an argument\n", 1);
    }
    let hasError = false;
    let stderr = "";
    for (const name of names) {
      if (!ctx.state.hashTable.has(name)) {
        stderr += `bash: hash: ${name}: not found\n`;
        hasError = true;
      } else {
        ctx.state.hashTable.delete(name);
      }
    }
    if (hasError) {
      return failure(stderr, 1);
    }
    return OK;
  }

  // Handle -t (show path for names)
  if (showPath) {
    if (names.length === 0) {
      return failure("bash: hash: -t: option requires an argument\n", 1);
    }
    let stdout = "";
    let hasError = false;
    let stderr = "";
    for (const name of names) {
      const cachedPath = ctx.state.hashTable.get(name);
      if (cachedPath) {
        // If multiple names, show "name\tpath" format
        if (names.length > 1) {
          stdout += `${name}\t${cachedPath}\n`;
        } else {
          stdout += `${cachedPath}\n`;
        }
      } else {
        stderr += `bash: hash: ${name}: not found\n`;
        hasError = true;
      }
    }
    if (hasError) {
      return { exitCode: 1, stdout, stderr };
    }
    return success(stdout);
  }

  // Handle -p (associate pathname with name)
  if (pathMode) {
    if (names.length === 0) {
      return failure(
        "bash: hash: usage: hash [-lr] [-p pathname] [-dt] [name ...]\n",
        1
      );
    }
    // Associate the pathname with the first name
    const name = names[0];
    ctx.state.hashTable.set(name, pathname);
    return OK;
  }

  // No args - display hash table
  if (names.length === 0) {
    if (ctx.state.hashTable.size === 0) {
      return success("hash: hash table empty\n");
    }

    let stdout = "";
    if (listMode) {
      // Reusable format: builtin hash -p /path/to/cmd cmd
      for (const [name, path] of ctx.state.hashTable) {
        stdout += `builtin hash -p ${path} ${name}\n`;
      }
    } else {
      // Default format (bash style: hits command table)
      stdout = "hits\tcommand\n";
      for (const [, path] of ctx.state.hashTable) {
        // We don't track hits, so just show 1
        stdout += `   1\t${path}\n`;
      }
    }
    return success(stdout);
  }

  // Add names to hash table (look up in PATH)
  let hasError = false;
  let stderr = "";
  const pathEnv = ctx.state.env.get("PATH") || "/usr/bin:/bin";
  const pathDirs = pathEnv.split(":");

  for (const name of names) {
    // Skip if name contains / (it's a path, not looked up in PATH)
    if (name.includes("/")) {
      stderr += `bash: hash: ${name}: cannot use / in name\n`;
      hasError = true;
      continue;
    }

    // Search PATH for the command
    let found = false;
    for (const dir of pathDirs) {
      if (!dir) continue;
      const fullPath = `${dir}/${name}`;
      if (await ctx.fs.exists(fullPath)) {
        ctx.state.hashTable.set(name, fullPath);
        found = true;
        break;
      }
    }

    if (!found) {
      stderr += `bash: hash: ${name}: not found\n`;
      hasError = true;
    }
  }

  if (hasError) {
    return failure(stderr, 1);
  }
  return OK;
}
