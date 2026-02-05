/**
 * Task Scheduling Module
 *
 * This module provides durable task execution using the Agent SDK's schedule() API.
 * It's designed to be stable and rarely need changes - most customization happens
 * through configuration, not code changes.
 *
 * Key features:
 * - Exponential backoff retry
 * - Transient vs permanent error classification
 * - Orphaned task recovery
 * - Heartbeat-based progress tracking
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Status of a scheduled task/message
 */
export type TaskStatus =
  | "pending" // Queued, not yet started
  | "streaming" // Currently executing
  | "complete" // Finished successfully
  | "error" // Failed permanently
  | "cancelled"; // Cancelled by user

/**
 * Payload for chat execution tasks
 */
export interface ChatTaskPayload {
  messageId: string;
  content: string;
  attempt: number;
  maxAttempts: number;
  attachments?: AttachmentRef[];
}

/**
 * Reference to an attachment stored in R2
 */
export interface AttachmentRef {
  name: string;
  type: string;
  size: number;
  r2Key: string;
  thumbnailKey?: string;
}

/**
 * Payload for heartbeat check tasks
 */
export interface HeartbeatPayload {
  messageId: string;
  taskId: string;
}

/**
 * Payload for recovery tasks
 */
export interface RecoveryPayload {
  messageId: string;
  checkpoint?: string;
  reason: "heartbeat_expired" | "orphaned" | "manual";
}

/**
 * Message record for recovery detection
 */
export interface MessageRecord {
  id: string;
  status: TaskStatus;
  heartbeat_at: number | null;
  checkpoint: string | null;
  attempt: number;
  task_id: string | null;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Default configuration for task scheduling.
 * These can be overridden per-task or globally.
 */
export const SCHEDULING_CONFIG = {
  /** Maximum retry attempts for transient failures */
  maxAttempts: 3,

  /** Base delay for exponential backoff (seconds) */
  baseBackoffSeconds: 2,

  /** Maximum backoff delay (seconds) */
  maxBackoffSeconds: 60,

  /** Heartbeat interval for long operations (seconds) */
  heartbeatIntervalSeconds: 30,

  /** How long after heartbeat expires to consider task orphaned (seconds) */
  heartbeatTimeoutSeconds: 60,

  /** Maximum time for a single task execution (seconds) */
  maxExecutionTimeSeconds: 300
} as const;

// =============================================================================
// Backoff Calculation
// =============================================================================

/**
 * Calculate exponential backoff delay for retry attempts.
 *
 * @param attempt - Current attempt number (1-indexed)
 * @param config - Optional configuration overrides
 * @returns Delay in seconds before next retry
 *
 * @example
 * calculateBackoff(1) // 2 seconds
 * calculateBackoff(2) // 4 seconds
 * calculateBackoff(3) // 8 seconds
 */
export function calculateBackoff(
  attempt: number,
  config: {
    baseBackoffSeconds?: number;
    maxBackoffSeconds?: number;
  } = {}
): number {
  const base =
    config.baseBackoffSeconds ?? SCHEDULING_CONFIG.baseBackoffSeconds;
  const max = config.maxBackoffSeconds ?? SCHEDULING_CONFIG.maxBackoffSeconds;

  // 2^attempt * base, capped at max
  const delay = Math.pow(2, attempt) * (base / 2);
  return Math.min(delay, max);
}

// =============================================================================
// Error Classification
// =============================================================================

/**
 * Patterns that indicate transient errors worth retrying
 */
const TRANSIENT_ERROR_PATTERNS = [
  // Network errors
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /network/i,

  // Rate limiting
  /rate limit/i,
  /too many requests/i,
  /429/,

  // Server errors
  /500/,
  /502/,
  /503/,
  /504/,
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,

  // Temporary issues
  /temporary/i,
  /retry/i,
  /overloaded/i,
  /capacity/i
];

/**
 * Patterns that indicate permanent errors (don't retry)
 */
const PERMANENT_ERROR_PATTERNS = [
  // Authentication
  /invalid.*api.*key/i,
  /unauthorized/i,
  /forbidden/i,
  /401/,
  /403/,

  // Bad requests
  /invalid.*request/i,
  /malformed/i,
  /validation/i,

  // Not found (usually means bad input)
  /not found/i,
  /404/,

  // Content policy
  /content.*policy/i,
  /blocked/i,
  /filtered/i
];

/**
 * Determine if an error is transient (worth retrying) or permanent.
 *
 * @param error - The error to classify
 * @returns true if the error is transient and should be retried
 *
 * @example
 * isTransientError(new Error("ECONNRESET")) // true
 * isTransientError(new Error("Invalid API key")) // false
 */
export function isTransientError(error: unknown): boolean {
  const message = getErrorMessage(error);

  // Check for permanent patterns first (they're more specific)
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return false;
    }
  }

  // Check for transient patterns
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }

  // Default: treat unknown errors as transient (safer to retry)
  return true;
}

/**
 * Extract error message from various error types
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

/**
 * Categorize an error for logging/display
 */
export function categorizeError(
  error: unknown
): "network" | "rate_limit" | "auth" | "server" | "validation" | "unknown" {
  const message = getErrorMessage(error);

  if (/ECONN|ETIMEDOUT|socket|network/i.test(message)) return "network";
  if (/rate limit|429|too many/i.test(message)) return "rate_limit";
  if (/401|403|unauthorized|forbidden|api.*key/i.test(message)) return "auth";
  if (/500|502|503|504|internal|gateway/i.test(message)) return "server";
  if (/invalid|malformed|validation/i.test(message)) return "validation";
  return "unknown";
}

// =============================================================================
// Recovery Logic
// =============================================================================

/**
 * Find orphaned messages that were streaming but heartbeat expired.
 *
 * @param messages - All messages to check
 * @param now - Current timestamp (milliseconds)
 * @param timeoutMs - How long after heartbeat to consider orphaned
 * @returns Messages that should be recovered
 */
export function findOrphanedMessages(
  messages: MessageRecord[],
  now: number = Date.now(),
  timeoutMs: number = SCHEDULING_CONFIG.heartbeatTimeoutSeconds * 1000
): MessageRecord[] {
  const cutoff = now - timeoutMs;

  return messages.filter((msg) => {
    // Only check streaming messages
    if (msg.status !== "streaming") {
      return false;
    }

    // If no heartbeat recorded, it's definitely orphaned
    if (msg.heartbeat_at === null) {
      return true;
    }

    // If heartbeat is older than cutoff, it's orphaned
    return msg.heartbeat_at < cutoff;
  });
}

/**
 * Determine if a message should be retried or marked as failed.
 *
 * @param message - The message record
 * @param maxAttempts - Maximum retry attempts
 * @returns "retry" | "fail" | "resume"
 */
export function determineRecoveryAction(
  message: MessageRecord,
  maxAttempts: number = SCHEDULING_CONFIG.maxAttempts
): "retry" | "fail" | "resume" {
  // If we have a checkpoint, try to resume
  if (message.checkpoint) {
    return "resume";
  }

  // If under max attempts, retry
  if (message.attempt < maxAttempts) {
    return "retry";
  }

  // Otherwise, fail
  return "fail";
}

/**
 * Build a recovery payload for an orphaned message.
 */
export function buildRecoveryPayload(
  message: MessageRecord,
  reason: RecoveryPayload["reason"] = "orphaned"
): RecoveryPayload {
  return {
    messageId: message.id,
    checkpoint: message.checkpoint ?? undefined,
    reason
  };
}

// =============================================================================
// Task Status Helpers
// =============================================================================

/**
 * Check if a status represents a terminal state (no more work to do)
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "complete" || status === "error" || status === "cancelled";
}

/**
 * Check if a status represents an active state (work in progress)
 */
export function isActiveStatus(status: TaskStatus): boolean {
  return status === "pending" || status === "streaming";
}

// =============================================================================
// SQL Helpers
// =============================================================================

/**
 * SQL for finding orphaned messages.
 * Use with: sql.exec(FIND_ORPHANED_SQL, cutoffTimestamp)
 */
export const FIND_ORPHANED_SQL = `
  SELECT id, status, heartbeat_at, checkpoint, attempt, task_id
  FROM messages
  WHERE status = 'streaming'
    AND (heartbeat_at IS NULL OR heartbeat_at < ?)
`;

/**
 * SQL for updating message status.
 */
export const UPDATE_STATUS_SQL = `
  UPDATE messages
  SET status = ?, error = ?, heartbeat_at = ?
  WHERE id = ?
`;

/**
 * SQL for updating heartbeat.
 */
export const UPDATE_HEARTBEAT_SQL = `
  UPDATE messages
  SET heartbeat_at = ?, checkpoint = ?
  WHERE id = ?
`;
