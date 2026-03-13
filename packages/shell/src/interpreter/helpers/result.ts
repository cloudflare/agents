/**
 * ExecResult factory functions for cleaner code.
 *
 * These helpers reduce verbosity and improve readability when
 * constructing ExecResult objects throughout the interpreter.
 */

import type { ExecResult } from "../../types";
import { ExecutionLimitError } from "../errors";
import type { InterpreterContext } from "../types";

/**
 * A successful result with no output.
 * Use this for commands that succeed silently.
 */
export const OK: ExecResult = Object.freeze({
  stdout: "",
  stderr: "",
  exitCode: 0
});

/**
 * Create a successful result with optional stdout.
 *
 * @param stdout - Output to include (default: "")
 * @returns ExecResult with exitCode 0
 */
export function success(stdout = ""): ExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

/**
 * Create a failure result with stderr message.
 *
 * @param stderr - Error message to include
 * @param exitCode - Exit code (default: 1)
 * @returns ExecResult with the specified exitCode
 */
export function failure(stderr: string, exitCode = 1): ExecResult {
  return { stdout: "", stderr, exitCode };
}

/**
 * Create a result with all fields specified.
 *
 * @param stdout - Standard output
 * @param stderr - Standard error
 * @param exitCode - Exit code
 * @returns ExecResult with all fields
 */
export function result(
  stdout: string,
  stderr: string,
  exitCode: number
): ExecResult {
  return { stdout, stderr, exitCode };
}

/**
 * Convert a boolean test result to an ExecResult.
 * Useful for test/conditional commands where true = exit 0, false = exit 1.
 *
 * @param passed - Boolean test result
 * @returns ExecResult with exitCode 0 if passed, 1 otherwise
 */
export function testResult(passed: boolean): ExecResult {
  return { stdout: "", stderr: "", exitCode: passed ? 0 : 1 };
}

/**
 * Throw an ExecutionLimitError for execution limits (recursion, iterations, commands).
 *
 * @param message - Error message describing the limit exceeded
 * @param limitType - Type of limit exceeded
 * @param stdout - Accumulated stdout to include
 * @param stderr - Accumulated stderr to include
 * @throws ExecutionLimitError always
 */
export function throwExecutionLimit(
  message: string,
  limitType:
    | "recursion"
    | "iterations"
    | "commands"
    | "string_length"
    | "glob_operations"
    | "substitution_depth"
    | "output_size"
    | "file_descriptors",
  stdout = "",
  stderr = ""
): never {
  throw new ExecutionLimitError(message, limitType, stdout, stderr);
}

/**
 * Check file descriptor count against the limit before adding a new one.
 * Throws ExecutionLimitError if the limit would be exceeded.
 */
export function checkFdLimit(ctx: InterpreterContext): void {
  const fds = ctx.state.fileDescriptors;
  if (fds && fds.size >= ctx.limits.maxFileDescriptors) {
    throw new ExecutionLimitError(
      `too many open file descriptors (max ${ctx.limits.maxFileDescriptors})`,
      "file_descriptors"
    );
  }
}
