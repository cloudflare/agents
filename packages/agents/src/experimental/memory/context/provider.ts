/**
 * Context Provider Interface
 *
 * Pure storage interface that all context providers must implement.
 * Business logic (readonly enforcement, maxTokens, defaults) lives
 * in the Context wrapper, not here.
 */

import type { StoredBlock, BlockMetadata } from "./types";

/**
 * Context storage provider interface.
 *
 * Implement this interface to create custom context storage backends.
 * Providers handle CRUD only — validation is handled by the Context wrapper.
 */
export interface ContextProvider {
  /**
   * Get all blocks.
   */
  getBlocks(): Record<string, StoredBlock>;

  /**
   * Get a single block by label.
   */
  getBlock(label: string): StoredBlock | null;

  /**
   * Set (upsert) a block.
   */
  setBlock(label: string, content: string, metadata?: BlockMetadata): void;

  /**
   * Delete a block by label.
   */
  deleteBlock(label: string): void;

  /**
   * Clear all blocks.
   */
  clearBlocks(): void;
}
