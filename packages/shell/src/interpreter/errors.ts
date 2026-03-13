/**
 * Control Flow Errors
 *
 * Error classes used to implement shell control flow:
 * - break: Exit loops
 * - continue: Skip to next iteration
 * - return: Exit functions
 * - errexit: Exit on error (set -e)
 * - nounset: Error on unset variables (set -u)
 *
 * All control flow errors carry stdout/stderr to accumulate output
 * as they propagate through the execution stack.
 */

/**
 * Base class for all control flow errors.
 * Carries stdout/stderr to preserve output during propagation.
 */
abstract class ControlFlowError extends Error {
  constructor(
    message: string,
    public stdout: string = "",
    public stderr: string = ""
  ) {
    super(message);
  }

  /**
   * Prepend output from the current context before re-throwing.
   */
  prependOutput(stdout: string, stderr: string): void {
    this.stdout = stdout + this.stdout;
    this.stderr = stderr + this.stderr;
  }
}

/**
 * Error thrown when break is called to exit loops.
 */
export class BreakError extends ControlFlowError {
  readonly name = "BreakError";

  constructor(
    public levels: number = 1,
    stdout: string = "",
    stderr: string = ""
  ) {
    super("break", stdout, stderr);
  }
}

/**
 * Error thrown when continue is called to skip to next iteration.
 */
export class ContinueError extends ControlFlowError {
  readonly name = "ContinueError";

  constructor(
    public levels: number = 1,
    stdout: string = "",
    stderr: string = ""
  ) {
    super("continue", stdout, stderr);
  }
}

/**
 * Error thrown when return is called to exit a function.
 */
export class ReturnError extends ControlFlowError {
  readonly name = "ReturnError";

  constructor(
    public exitCode: number = 0,
    stdout: string = "",
    stderr: string = ""
  ) {
    super("return", stdout, stderr);
  }
}

/**
 * Error thrown when set -e (errexit) is enabled and a command fails.
 */
export class ErrexitError extends ControlFlowError {
  readonly name = "ErrexitError";

  constructor(
    public readonly exitCode: number,
    stdout: string = "",
    stderr: string = ""
  ) {
    super(`errexit: command exited with status ${exitCode}`, stdout, stderr);
  }
}

/**
 * Error thrown when set -u (nounset) is enabled and an unset variable is referenced.
 */
export class NounsetError extends ControlFlowError {
  readonly name = "NounsetError";

  constructor(
    public varName: string,
    stdout: string = ""
  ) {
    super(
      `${varName}: unbound variable`,
      stdout,
      `bash: ${varName}: unbound variable\n`
    );
  }
}

/**
 * Error thrown when exit builtin is called to terminate the script.
 */
export class ExitError extends ControlFlowError {
  readonly name = "ExitError";

  constructor(
    public readonly exitCode: number,
    stdout: string = "",
    stderr: string = ""
  ) {
    super(`exit`, stdout, stderr);
  }
}

/**
 * Error thrown for arithmetic expression errors (e.g., floating point, invalid syntax).
 * Returns exit code 1 instead of 2 (syntax error).
 */
export class ArithmeticError extends ControlFlowError {
  readonly name = "ArithmeticError";

  /**
   * If true, this error should abort script execution (like missing operand after binary operator).
   * If false, the error is recoverable and execution can continue.
   */
  public fatal: boolean;

  constructor(
    message: string,
    stdout: string = "",
    stderr: string = "",
    fatal = false
  ) {
    super(message, stdout, stderr);
    this.stderr = stderr || `bash: ${message}\n`;
    this.fatal = fatal;
  }
}

/**
 * Error thrown for bad substitution errors (e.g., ${#var:1:3}).
 * Returns exit code 1.
 */
export class BadSubstitutionError extends ControlFlowError {
  readonly name = "BadSubstitutionError";

  constructor(message: string, stdout: string = "", stderr: string = "") {
    super(message, stdout, stderr);
    this.stderr = stderr || `bash: ${message}: bad substitution\n`;
  }
}

/**
 * Error thrown when failglob is enabled and a glob pattern has no matches.
 * Returns exit code 1.
 */
export class GlobError extends ControlFlowError {
  readonly name = "GlobError";

  constructor(pattern: string, stdout: string = "", stderr: string = "") {
    super(`no match: ${pattern}`, stdout, stderr);
    this.stderr = stderr || `bash: no match: ${pattern}\n`;
  }
}

/**
 * Error thrown for invalid brace expansions (e.g., mixed case character ranges like {z..A}).
 * Returns exit code 1 (matching bash behavior).
 */
export class BraceExpansionError extends ControlFlowError {
  readonly name = "BraceExpansionError";

  constructor(message: string, stdout: string = "", stderr: string = "") {
    super(message, stdout, stderr);
    this.stderr = stderr || `bash: ${message}\n`;
  }
}

/**
 * Error thrown when execution limits are exceeded (recursion depth, command count, loop iterations).
 * This should ALWAYS be thrown before JavaScript's native RangeError kicks in.
 * Exit code 126 indicates a limit was exceeded.
 */
export class ExecutionLimitError extends ControlFlowError {
  readonly name = "ExecutionLimitError";
  static readonly EXIT_CODE = 126;

  constructor(
    message: string,
    public readonly limitType:
      | "recursion"
      | "commands"
      | "iterations"
      | "string_length"
      | "glob_operations"
      | "substitution_depth"
      | "output_size"
      | "file_descriptors",
    stdout: string = "",
    stderr: string = ""
  ) {
    super(message, stdout, stderr);
    this.stderr = stderr || `bash: ${message}\n`;
  }
}

/**
 * Error thrown when execution is aborted via an AbortSignal.
 * Used by the `timeout` command to stop timed-out commands at statement boundaries.
 */
export class ExecutionAbortedError extends ControlFlowError {
  readonly name = "ExecutionAbortedError";

  constructor(stdout: string = "", stderr: string = "") {
    super("execution aborted", stdout, stderr);
  }
}

/**
 * Error thrown when break/continue is called in a subshell that was
 * spawned from within a loop context. Causes the subshell to exit cleanly.
 */
export class SubshellExitError extends ControlFlowError {
  readonly name = "SubshellExitError";

  constructor(stdout: string = "", stderr: string = "") {
    super("subshell exit", stdout, stderr);
  }
}

/**
 * Type guard for errors that exit the current scope (return, break, continue).
 * These need special handling vs errexit/nounset which terminate execution.
 */
export function isScopeExitError(
  error: unknown
): error is BreakError | ContinueError | ReturnError {
  return (
    error instanceof BreakError ||
    error instanceof ContinueError ||
    error instanceof ReturnError
  );
}

/**
 * Error thrown when a POSIX special builtin fails in POSIX mode.
 * In POSIX mode (set -o posix), errors in special builtins like
 * shift, set, readonly, export, etc. cause the entire script to exit.
 *
 * Per POSIX 2.8.1 - Consequences of Shell Errors:
 * "A special built-in utility causes an interactive or non-interactive shell
 * to exit when an error occurs."
 */
export class PosixFatalError extends ControlFlowError {
  readonly name = "PosixFatalError";

  constructor(
    public readonly exitCode: number,
    stdout: string = "",
    stderr: string = ""
  ) {
    super("posix fatal error", stdout, stderr);
  }
}
