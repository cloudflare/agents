// STUB — not upstream pi code. See vendor/pi-coding-agent-src/README.md

/**
 * The footer is a TUI concept. Only the read-only view extensions can be handed
 * is kept, with upstream's four method signatures.
 */

export interface ReadonlyFooterDataProvider {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
}
