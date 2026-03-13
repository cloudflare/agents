/**
 * Shared constants for the bash environment.
 */

/**
 * Default batch size for parallel I/O operations.
 *
 * This value is used across multiple commands (find, ls, tree, du, etc.) to
 * control how many filesystem operations are performed concurrently. A larger
 * value provides more parallelism but uses more memory; a smaller value is
 * more conservative.
 *
 * 100 is a good default that provides significant parallelism without
 * overwhelming the system or using excessive memory.
 */
export const DEFAULT_BATCH_SIZE = 100;
