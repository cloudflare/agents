// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * Upstream's edit tool touches the filesystem. Only the input and detail types
 * referenced by the extension types are kept.
 */

export interface EditToolInput {
	/** Path to the file to edit (relative or absolute) */
	path: string;
	/** One or more targeted replacements, each matched against the original file. */
	edits: Array<{ oldText: string; newText: string }>;
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}
