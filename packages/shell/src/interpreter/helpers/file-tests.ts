import type { InterpreterContext } from "../types";

/**
 * Resolve a path relative to the current working directory.
 */
function resolvePath(ctx: InterpreterContext, path: string): string {
  return ctx.fs.resolvePath(ctx.state.cwd, path);
}

/**
 * File test operators supported by bash
 * Unary operators that test file properties
 */
const FILE_TEST_OPERATORS = [
  "-e", // file exists
  "-a", // file exists (deprecated synonym for -e)
  "-f", // regular file
  "-d", // directory
  "-r", // readable
  "-w", // writable
  "-x", // executable
  "-s", // file exists and has size > 0
  "-L", // symbolic link
  "-h", // symbolic link (synonym for -L)
  "-k", // sticky bit set
  "-g", // setgid bit set
  "-u", // setuid bit set
  "-G", // owned by effective group ID
  "-O", // owned by effective user ID
  "-b", // block special file
  "-c", // character special file
  "-p", // named pipe (FIFO)
  "-S", // socket
  "-t", // file descriptor is open and refers to a terminal
  "-N" // file has been modified since last read
] as const;

export type FileTestOperator = (typeof FILE_TEST_OPERATORS)[number];

export function isFileTestOperator(op: string): op is FileTestOperator {
  return FILE_TEST_OPERATORS.includes(op as FileTestOperator);
}

/**
 * Evaluates a file test operator (-e, -f, -d, etc.) against a path.
 * Returns a boolean result.
 *
 * @param ctx - Interpreter context with filesystem access
 * @param operator - The file test operator (e.g., "-f", "-d", "-e")
 * @param operand - The path to test (will be resolved relative to cwd)
 */
export async function evaluateFileTest(
  ctx: InterpreterContext,
  operator: string,
  operand: string
): Promise<boolean> {
  const path = resolvePath(ctx, operand);

  switch (operator) {
    case "-e":
    case "-a":
      // File exists
      return ctx.fs.exists(path);

    case "-f": {
      // Regular file
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return stat.isFile;
      }
      return false;
    }

    case "-d": {
      // Directory
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return stat.isDirectory;
      }
      return false;
    }

    case "-r": {
      // Readable - check read permission bits
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        // Check user read bit (0o400) - in our sandboxed env, we act as owner
        return (stat.mode & 0o400) !== 0;
      }
      return false;
    }

    case "-w": {
      // Writable - check write permission bits
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        // Check user write bit (0o200)
        return (stat.mode & 0o200) !== 0;
      }
      return false;
    }

    case "-x": {
      // Executable - check execute permission bits
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        // Check user execute bit (0o100)
        return (stat.mode & 0o100) !== 0;
      }
      return false;
    }

    case "-s": {
      // File exists and has size > 0
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return stat.size > 0;
      }
      return false;
    }

    case "-L":
    case "-h": {
      // Symbolic link - use lstat to check without following
      try {
        const stat = await ctx.fs.lstat(path);
        return stat.isSymbolicLink;
      } catch {
        return false;
      }
    }

    case "-k": {
      // Sticky bit set (mode & 0o1000)
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return (stat.mode & 0o1000) !== 0;
      }
      return false;
    }

    case "-g": {
      // Setgid bit set (mode & 0o2000)
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return (stat.mode & 0o2000) !== 0;
      }
      return false;
    }

    case "-u": {
      // Setuid bit set (mode & 0o4000)
      if (await ctx.fs.exists(path)) {
        const stat = await ctx.fs.stat(path);
        return (stat.mode & 0o4000) !== 0;
      }
      return false;
    }

    case "-G":
    case "-O":
      // Owned by effective group/user ID
      // In virtual fs, assume user owns everything that exists
      return ctx.fs.exists(path);

    case "-b":
      // Block special file - virtual fs doesn't have these
      return false;

    case "-c": {
      // Character special file
      // In virtual fs, recognize common character devices by path
      const charDevices = [
        "/dev/null",
        "/dev/zero",
        "/dev/random",
        "/dev/urandom",
        "/dev/tty",
        "/dev/stdin",
        "/dev/stdout",
        "/dev/stderr"
      ];
      return charDevices.includes(path);
    }

    case "-p":
      // Named pipe (FIFO) - virtual fs doesn't have these
      return false;

    case "-S":
      // Socket - virtual fs doesn't have these
      return false;

    case "-t":
      // File descriptor refers to terminal
      // operand is fd number, not path
      // We don't support terminal detection
      return false;

    case "-N": {
      // File has been modified since last read
      // We don't track read times, so just check if file exists
      return ctx.fs.exists(path);
    }

    default:
      return false;
  }
}

/**
 * Binary file test operators for comparing two files
 */
const BINARY_FILE_TEST_OPERATORS = ["-nt", "-ot", "-ef"] as const;

export type BinaryFileTestOperator =
  (typeof BINARY_FILE_TEST_OPERATORS)[number];

export function isBinaryFileTestOperator(
  op: string
): op is BinaryFileTestOperator {
  return BINARY_FILE_TEST_OPERATORS.includes(op as BinaryFileTestOperator);
}

/**
 * Evaluates a binary file test operator (-nt, -ot, -ef) comparing two files.
 *
 * @param ctx - Interpreter context with filesystem access
 * @param operator - The operator (-nt, -ot, -ef)
 * @param left - Left operand (file path)
 * @param right - Right operand (file path)
 */
export async function evaluateBinaryFileTest(
  ctx: InterpreterContext,
  operator: string,
  left: string,
  right: string
): Promise<boolean> {
  const leftPath = resolvePath(ctx, left);
  const rightPath = resolvePath(ctx, right);

  switch (operator) {
    case "-nt": {
      // left is newer than right
      try {
        const leftStat = await ctx.fs.stat(leftPath);
        const rightStat = await ctx.fs.stat(rightPath);
        return leftStat.mtime > rightStat.mtime;
      } catch {
        // If either file doesn't exist, result is false
        return false;
      }
    }

    case "-ot": {
      // left is older than right
      try {
        const leftStat = await ctx.fs.stat(leftPath);
        const rightStat = await ctx.fs.stat(rightPath);
        return leftStat.mtime < rightStat.mtime;
      } catch {
        return false;
      }
    }

    case "-ef": {
      // Same file (same device and inode)
      // In virtual fs, compare resolved canonical paths
      try {
        // Both files must exist
        if (
          !(await ctx.fs.exists(leftPath)) ||
          !(await ctx.fs.exists(rightPath))
        ) {
          return false;
        }
        // Compare canonical paths (handles symlinks)
        const leftReal = ctx.fs.resolvePath(ctx.state.cwd, leftPath);
        const rightReal = ctx.fs.resolvePath(ctx.state.cwd, rightPath);
        return leftReal === rightReal;
      } catch {
        return false;
      }
    }

    default:
      return false;
  }
}
