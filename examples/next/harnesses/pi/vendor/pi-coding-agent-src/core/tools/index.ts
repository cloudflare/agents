// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Upstream re-exports the built-in tool implementations here; every one of them
 * needs node:fs or child_process. The extension types only reference the input
 * and detail shapes, which are restated (upstream derives the inputs from
 * typebox schemas that are not vendored).
 *
 * The harness gets its actual read/write/edit/bash tools from
 * @earendil-works/pi-agent-core over an injectable ExecutionEnv.
 */

export type { BashOperations, BashToolDetails, BashToolInput } from "./bash.ts";
export type { EditToolDetails, EditToolInput } from "./edit.ts";

import type { BashToolDetails, BashToolInput } from "./bash.ts";

/** Upstream: core/tools/truncate.ts */
export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

export interface FindToolInput {
	/** Glob pattern to match files, e.g. '*.ts' */
	pattern: string;
	/** Directory to search in (default: current directory) */
	path?: string;
	/** Maximum number of results (default: 1000) */
	limit?: number;
}

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

export interface GrepToolInput {
	/** Search pattern (regex or literal string) */
	pattern: string;
	/** Directory or file to search (default: current directory) */
	path?: string;
	/** Filter files by glob pattern */
	glob?: string;
	/** Case-insensitive search (default: false) */
	ignoreCase?: boolean;
	/** Treat pattern as literal string instead of regex (default: false) */
	literal?: boolean;
	/** Number of lines to show before and after each match (default: 0) */
	context?: number;
	/** Maximum number of matches to return (default: 100) */
	limit?: number;
}

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

export interface LsToolInput {
	/** Directory to list (default: current directory) */
	path?: string;
	/** Maximum number of entries to return (default: 500) */
	limit?: number;
}

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

export type PowerShellToolInput = BashToolInput;
export type PowerShellToolDetails = BashToolDetails;

export interface ReadToolInput {
	/** Path to the file to read (relative or absolute) */
	path: string;
	/** Line number to start reading from (1-indexed) */
	offset?: number;
	/** Maximum number of lines to read */
	limit?: number;
}

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

export interface WriteToolInput {
	/** Path to the file to write (relative or absolute) */
	path: string;
	/** Content to write to the file */
	content: string;
}
