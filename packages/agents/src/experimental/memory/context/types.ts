/**
 * Context Memory Types
 */

/**
 * A context block — same shape everywhere.
 * Provider stores everything except `tokens`.
 * Context wrapper computes `tokens` via estimateStringTokens before returning.
 */
export interface ContextBlock {
  /** Block label (unique identifier) */
  label: string;
  /** Block content */
  content: string;
  /** Human-readable description of the block's purpose */
  description?: string;
  /** Maximum estimated tokens allowed for this block's content */
  maxTokens?: number;
  /** Whether this block is read-only (writes are rejected) */
  readonly?: boolean;
  /** Estimated token count of the content (computed, never stored) */
  tokens: number;
}

/**
 * Stored block — same as ContextBlock but without the computed `tokens` field.
 * This is what providers return from storage.
 */
export type StoredBlock = Omit<ContextBlock, "tokens">;

/**
 * Metadata passed to provider's setBlock alongside content.
 */
export interface BlockMetadata {
  description?: string;
  maxTokens?: number;
  readonly?: boolean;
}

/**
 * Options for setBlock on the Context wrapper.
 */
export interface SetBlockOptions {
  description?: string;
  maxTokens?: number;
}

/**
 * Predefined block configuration.
 */
export interface BlockDefinition {
  /** Block label (unique identifier) */
  label: string;
  /** Human-readable description */
  description?: string;
  /** Maximum estimated tokens for this block */
  maxTokens?: number;
  /** Initial content (used if block doesn't exist yet) */
  defaultContent?: string;
  /** Whether this block is read-only (default false) */
  readonly?: boolean;
}

/**
 * Options for creating a Context instance.
 */
export interface ContextOptions {
  /** Predefined blocks to initialize on first access */
  blocks?: BlockDefinition[];
}
