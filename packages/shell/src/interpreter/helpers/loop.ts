/**
 * Loop Error Handling Helpers
 *
 * Consolidates the repeated error handling logic used in all loop constructs
 * (for, c-style for, while, until).
 */

import {
  BreakError,
  ContinueError,
  ErrexitError,
  ExecutionLimitError,
  ExitError,
  ReturnError
} from "../errors";
import { getErrorMessage } from "./errors";

export type LoopAction = "break" | "continue" | "rethrow" | "error";

export interface LoopErrorResult {
  action: LoopAction;
  stdout: string;
  stderr: string;
  exitCode?: number;
  error?: unknown;
}

/**
 * Handle errors thrown during loop body execution.
 *
 * @param error - The caught error
 * @param stdout - Current accumulated stdout
 * @param stderr - Current accumulated stderr
 * @param loopDepth - Current loop nesting depth from ctx.state.loopDepth
 * @returns Result indicating what action the loop should take
 */
export function handleLoopError(
  error: unknown,
  stdout: string,
  stderr: string,
  loopDepth: number
): LoopErrorResult {
  if (error instanceof BreakError) {
    stdout += error.stdout;
    stderr += error.stderr;
    // Only propagate if levels > 1 AND we're not at the outermost loop
    // Per bash docs: "If n is greater than the number of enclosing loops,
    // the last enclosing loop is exited"
    if (error.levels > 1 && loopDepth > 1) {
      error.levels--;
      error.stdout = stdout;
      error.stderr = stderr;
      return { action: "rethrow", stdout, stderr, error };
    }
    return { action: "break", stdout, stderr };
  }

  if (error instanceof ContinueError) {
    stdout += error.stdout;
    stderr += error.stderr;
    // Only propagate if levels > 1 AND we're not at the outermost loop
    // Per bash docs: "If n is greater than the number of enclosing loops,
    // the last enclosing loop is resumed"
    if (error.levels > 1 && loopDepth > 1) {
      error.levels--;
      error.stdout = stdout;
      error.stderr = stderr;
      return { action: "rethrow", stdout, stderr, error };
    }
    return { action: "continue", stdout, stderr };
  }

  if (
    error instanceof ReturnError ||
    error instanceof ErrexitError ||
    error instanceof ExitError ||
    error instanceof ExecutionLimitError
  ) {
    error.prependOutput(stdout, stderr);
    return { action: "rethrow", stdout, stderr, error };
  }

  // Generic error - return error result
  const message = getErrorMessage(error);
  return {
    action: "error",
    stdout,
    stderr: `${stderr}${message}\n`,
    exitCode: 1
  };
}
