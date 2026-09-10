// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Upstream's bash tool spawns a shell. Only the input/detail/operation types
 * referenced by the extension types are kept; inputs are spelled out because
 * upstream derives them from typebox schemas that are not vendored.
 */

import type { TruncationResult } from "./index.ts";

export interface BashToolInput {
	/** Shell command to execute */
	command: string;
	/** Timeout in seconds (optional, no default timeout) */
	timeout?: number;
}

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems.
 */
export interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Uint8Array) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: Record<string, string | undefined>;
		}
	) => Promise<{ exitCode: number | null }>;
}
