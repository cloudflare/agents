import type { IFileSystem } from "./fs/interface";
import type { ExecutionLimits } from "./limits";
import type { SecureFetch } from "./network/index";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The final environment variables after execution (only set by BashEnv.exec) */
  env?: Record<string, string>;
  /**
   * Encoding hint for stdout content when writing to files via redirections.
   * Set to "binary" by commands that produce binary output (e.g., cat, gzip)
   * to prevent re-encoding of raw byte data as UTF-8.
   * When not set, the redirect system uses UTF-8 for non-ASCII text.
   */
  stdoutEncoding?: "binary";
}

/** Result from BashEnv.exec() - always includes env */
export interface BashExecResult extends ExecResult {
  env: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/** Options for exec calls within commands (internal API) */
export interface CommandExecOptions {
  /** Environment variables to merge into the exec state */
  env?: Record<string, string>;
  /**
   * Replace the execution environment instead of merging with parent env.
   * Useful for implementing `env -i` semantics safely without shell prefixes.
   */
  replaceEnv?: boolean;
  /**
   * Working directory for the exec.
   * Required to prevent bugs where subcommands run in the wrong directory.
   * Always pass `ctx.cwd` from the calling command's context.
   */
  cwd: string;
  /**
   * Standard input to pass to the subcommand.
   * Optional - if not provided, stdin will be empty.
   */
  stdin?: string;
  /**
   * Abort signal for cooperative cancellation.
   * When aborted, the interpreter stops executing at the next statement boundary.
   * Used by `timeout` to ensure timed-out commands don't continue running.
   */
  signal?: AbortSignal;
  /**
   * Additional argv entries appended to the first executed command.
   * Values bypass shell parsing entirely — no escaping, splitting, or globbing.
   * Like child_process.spawnSync(cmd, args).
   */
  args?: string[];
}

/**
 * Context provided to commands during execution.
 *
 * ## Field Availability
 *
 * **Always available (core fields):**
 * - `fs`, `cwd`, `env`, `stdin`
 *
 * **Available when running via BashEnv interpreter:**
 * - `exec` - For commands like `xargs`, `bash -c` that need to run subcommands
 * - `getRegisteredCommands` - For the `help` command to list available commands
 *
 * **Conditionally available based on configuration:**
 * - `fetch` - Only when `network` option is configured in BashEnv
 * - `sleep` - Only when a custom sleep function is provided (e.g., for testing)
 */
/**
 * Performance trace event for profiling command execution
 */
export interface TraceEvent {
  /** Event category (e.g., "find", "grep") */
  category: string;
  /** Event name (e.g., "readdir", "stat", "eval") */
  name: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Optional details (e.g., path, count) */
  details?: Record<string, unknown>;
}

/**
 * Trace callback function for receiving performance events
 */
export type TraceCallback = (event: TraceEvent) => void;

export interface CommandContext {
  /** Virtual filesystem interface for file operations */
  fs: IFileSystem;
  /** Current working directory */
  cwd: string;
  /** Environment variables - uses Map to prevent prototype pollution */
  env: Map<string, string>;
  /**
   * Exported environment variables only.
   * Used by commands like printenv and env that should only show exported vars.
   * In bash, only exported variables are passed to child processes.
   */
  exportedEnv?: Record<string, string>;
  /** Standard input content */
  stdin: string;
  /**
   * Execution limits configuration.
   * Available when running commands via BashEnv interpreter.
   */
  limits?: Required<ExecutionLimits>;
  /**
   * Performance trace callback for profiling.
   * If provided, commands emit timing events for analysis.
   */
  trace?: TraceCallback;
  /**
   * Execute a subcommand (e.g., for `xargs`, `bash -c`).
   * Available when running commands via BashEnv interpreter.
   *
   * @param command - The command string to execute
   * @param options - Required options including `cwd` to prevent directory bugs
   */
  exec?: (command: string, options: CommandExecOptions) => Promise<ExecResult>;
  /**
   * Secure fetch function for network requests (e.g., for `curl`).
   * Only available when `network` option is configured in BashEnv.
   */
  fetch?: SecureFetch;
  /**
   * Returns names of all registered commands.
   * Available when running commands via BashEnv interpreter.
   * Used by the `help` command.
   */
  getRegisteredCommands?: () => string[];
  /**
   * Custom sleep implementation.
   * If provided, used instead of real setTimeout.
   * Useful for testing with mock clocks.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * File descriptors map for here-docs and process substitution.
   * Maps FD numbers to their content (e.g., 3 -> "content from 3<<EOF").
   * Note: FD 0 content is in `stdin`, but may also appear here for consistency.
   */
  fileDescriptors?: Map<number, string>;
  /**
   * Whether xpg_echo shopt is enabled.
   * When true, echo interprets backslash escapes by default (like echo -e).
   */
  xpgEcho?: boolean;
  /**
   * Current command substitution nesting depth.
   * Used to prevent stack exhaustion from deeply nested $(...).
   */
  substitutionDepth?: number;
  /**
   * Abort signal from the current execution context.
   * Commands that spawn sub-executions (bash -c, xargs, etc.)
   * should forward this signal so cooperative cancellation propagates.
   */
  signal?: AbortSignal;
}

export interface Command {
  name: string;
  trusted?: boolean;
  execute(args: string[], ctx: CommandContext): Promise<ExecResult>;
}

export type CommandRegistry = Map<string, Command>;

// Re-export IFileSystem for convenience
export type { IFileSystem };
