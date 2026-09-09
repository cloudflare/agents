// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Types only: upstream's `execCommand` spawns a child process. The host injects
 * a `Shell` implementation into the loader instead (see core/extensions/loader.ts).
 */

/** Options for executing shell commands. */
export interface ExecOptions {
  /** AbortSignal to cancel the command */
  signal?: AbortSignal;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Working directory */
  cwd?: string;
}

/** Result of executing a shell command. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}
