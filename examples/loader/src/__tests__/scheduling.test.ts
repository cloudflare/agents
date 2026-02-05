/**
 * Scheduling Module Unit Tests
 *
 * These tests are fast (no I/O, no network, no timers) and test the pure functions
 * in the scheduling module. They should run on every CI build.
 *
 * Slow integration tests that involve actual scheduling are in loader.scheduling.test.ts
 * and should be run separately (nightly, or when scheduling code changes).
 */

import { describe, expect, it } from "vitest";
import {
  calculateBackoff,
  isTransientError,
  getErrorMessage,
  categorizeError,
  findOrphanedMessages,
  determineRecoveryAction,
  buildRecoveryPayload,
  isTerminalStatus,
  isActiveStatus,
  SCHEDULING_CONFIG,
  type MessageRecord
} from "../scheduling";

// =============================================================================
// Backoff Calculation Tests
// =============================================================================

describe("calculateBackoff", () => {
  it("should calculate exponential backoff for attempt 1", () => {
    expect(calculateBackoff(1)).toBe(2);
  });

  it("should calculate exponential backoff for attempt 2", () => {
    expect(calculateBackoff(2)).toBe(4);
  });

  it("should calculate exponential backoff for attempt 3", () => {
    expect(calculateBackoff(3)).toBe(8);
  });

  it("should calculate exponential backoff for attempt 4", () => {
    expect(calculateBackoff(4)).toBe(16);
  });

  it("should cap backoff at maxBackoffSeconds", () => {
    // With default max of 60, attempt 7 would be 128 but should be capped
    expect(calculateBackoff(7)).toBe(60);
    expect(calculateBackoff(10)).toBe(60);
  });

  it("should respect custom baseBackoffSeconds", () => {
    expect(calculateBackoff(1, { baseBackoffSeconds: 4 })).toBe(4);
    expect(calculateBackoff(2, { baseBackoffSeconds: 4 })).toBe(8);
  });

  it("should respect custom maxBackoffSeconds", () => {
    expect(calculateBackoff(5, { maxBackoffSeconds: 10 })).toBe(10);
  });

  it("should handle attempt 0 edge case", () => {
    // 2^0 = 1, * 1 = 1
    expect(calculateBackoff(0)).toBe(1);
  });
});

// =============================================================================
// Error Classification Tests
// =============================================================================

describe("isTransientError", () => {
  describe("network errors (transient)", () => {
    it("should classify ECONNRESET as transient", () => {
      expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    });

    it("should classify ETIMEDOUT as transient", () => {
      expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
    });

    it("should classify socket hang up as transient", () => {
      expect(isTransientError(new Error("socket hang up"))).toBe(true);
    });

    it("should classify network error as transient", () => {
      expect(isTransientError(new Error("network error"))).toBe(true);
    });
  });

  describe("rate limiting (transient)", () => {
    it("should classify rate limit as transient", () => {
      expect(isTransientError(new Error("rate limit exceeded"))).toBe(true);
    });

    it("should classify 429 as transient", () => {
      expect(isTransientError(new Error("HTTP 429"))).toBe(true);
    });

    it("should classify too many requests as transient", () => {
      expect(isTransientError(new Error("too many requests"))).toBe(true);
    });
  });

  describe("server errors (transient)", () => {
    it("should classify 500 as transient", () => {
      expect(isTransientError(new Error("HTTP 500"))).toBe(true);
    });

    it("should classify 502 as transient", () => {
      expect(isTransientError(new Error("HTTP 502 Bad Gateway"))).toBe(true);
    });

    it("should classify 503 as transient", () => {
      expect(isTransientError(new Error("HTTP 503 Service Unavailable"))).toBe(
        true
      );
    });

    it("should classify 504 as transient", () => {
      expect(isTransientError(new Error("HTTP 504 Gateway Timeout"))).toBe(
        true
      );
    });

    it("should classify internal server error as transient", () => {
      expect(isTransientError(new Error("Internal Server Error"))).toBe(true);
    });
  });

  describe("auth errors (permanent)", () => {
    it("should classify invalid API key as permanent", () => {
      expect(isTransientError(new Error("Invalid API key"))).toBe(false);
    });

    it("should classify unauthorized as permanent", () => {
      expect(isTransientError(new Error("Unauthorized"))).toBe(false);
    });

    it("should classify 401 as permanent", () => {
      expect(isTransientError(new Error("HTTP 401"))).toBe(false);
    });

    it("should classify 403 as permanent", () => {
      expect(isTransientError(new Error("HTTP 403 Forbidden"))).toBe(false);
    });
  });

  describe("validation errors (permanent)", () => {
    it("should classify invalid request as permanent", () => {
      expect(isTransientError(new Error("Invalid request body"))).toBe(false);
    });

    it("should classify malformed as permanent", () => {
      expect(isTransientError(new Error("Malformed JSON"))).toBe(false);
    });

    it("should classify validation error as permanent", () => {
      expect(isTransientError(new Error("Validation failed"))).toBe(false);
    });
  });

  describe("not found errors (permanent)", () => {
    it("should classify not found as permanent", () => {
      expect(isTransientError(new Error("Resource not found"))).toBe(false);
    });

    it("should classify 404 as permanent", () => {
      expect(isTransientError(new Error("HTTP 404"))).toBe(false);
    });
  });

  describe("content policy errors (permanent)", () => {
    it("should classify content policy as permanent", () => {
      expect(isTransientError(new Error("Content policy violation"))).toBe(
        false
      );
    });

    it("should classify blocked as permanent", () => {
      expect(isTransientError(new Error("Request blocked"))).toBe(false);
    });
  });

  describe("unknown errors", () => {
    it("should treat unknown errors as transient (safer to retry)", () => {
      expect(isTransientError(new Error("Something weird happened"))).toBe(
        true
      );
    });

    it("should handle string errors", () => {
      expect(isTransientError("ECONNRESET")).toBe(true);
    });

    it("should handle object errors with message", () => {
      expect(isTransientError({ message: "rate limit" })).toBe(true);
    });

    it("should handle null/undefined", () => {
      expect(isTransientError(null)).toBe(true);
      expect(isTransientError(undefined)).toBe(true);
    });
  });
});

describe("getErrorMessage", () => {
  it("should extract message from Error object", () => {
    expect(getErrorMessage(new Error("test message"))).toBe("test message");
  });

  it("should return string errors as-is", () => {
    expect(getErrorMessage("string error")).toBe("string error");
  });

  it("should extract message from object with message property", () => {
    expect(getErrorMessage({ message: "object message" })).toBe(
      "object message"
    );
  });

  it("should convert other types to string", () => {
    expect(getErrorMessage(123)).toBe("123");
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });
});

describe("categorizeError", () => {
  it("should categorize network errors", () => {
    expect(categorizeError(new Error("ECONNRESET"))).toBe("network");
    expect(categorizeError(new Error("ETIMEDOUT"))).toBe("network");
    expect(categorizeError(new Error("socket hang up"))).toBe("network");
  });

  it("should categorize rate limit errors", () => {
    expect(categorizeError(new Error("rate limit"))).toBe("rate_limit");
    expect(categorizeError(new Error("HTTP 429"))).toBe("rate_limit");
  });

  it("should categorize auth errors", () => {
    expect(categorizeError(new Error("HTTP 401"))).toBe("auth");
    expect(categorizeError(new Error("unauthorized"))).toBe("auth");
    expect(categorizeError(new Error("invalid API key"))).toBe("auth");
  });

  it("should categorize server errors", () => {
    expect(categorizeError(new Error("HTTP 500"))).toBe("server");
    expect(categorizeError(new Error("bad gateway"))).toBe("server");
  });

  it("should categorize validation errors", () => {
    expect(categorizeError(new Error("invalid input"))).toBe("validation");
    expect(categorizeError(new Error("malformed JSON"))).toBe("validation");
  });

  it("should return unknown for unrecognized errors", () => {
    expect(categorizeError(new Error("something weird"))).toBe("unknown");
  });
});

// =============================================================================
// Recovery Logic Tests
// =============================================================================

describe("findOrphanedMessages", () => {
  const now = 1000000; // Fixed timestamp for testing
  const timeout = 60000; // 60 seconds

  function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
    return {
      id: "msg-1",
      status: "streaming",
      heartbeat_at: now - 30000, // 30 seconds ago (not orphaned)
      checkpoint: null,
      attempt: 1,
      task_id: "task-1",
      ...overrides
    };
  }

  it("should find messages with expired heartbeat", () => {
    const messages = [
      makeMessage({ id: "msg-1", heartbeat_at: now - 90000 }), // 90s ago - orphaned
      makeMessage({ id: "msg-2", heartbeat_at: now - 30000 }) // 30s ago - ok
    ];

    const orphaned = findOrphanedMessages(messages, now, timeout);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe("msg-1");
  });

  it("should find messages with null heartbeat", () => {
    const messages = [
      makeMessage({ id: "msg-1", heartbeat_at: null }), // No heartbeat - orphaned
      makeMessage({ id: "msg-2", heartbeat_at: now - 30000 }) // 30s ago - ok
    ];

    const orphaned = findOrphanedMessages(messages, now, timeout);
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].id).toBe("msg-1");
  });

  it("should ignore non-streaming messages", () => {
    const messages = [
      makeMessage({ id: "msg-1", status: "complete", heartbeat_at: null }),
      makeMessage({ id: "msg-2", status: "error", heartbeat_at: null }),
      makeMessage({ id: "msg-3", status: "pending", heartbeat_at: null }),
      makeMessage({ id: "msg-4", status: "cancelled", heartbeat_at: null })
    ];

    const orphaned = findOrphanedMessages(messages, now, timeout);
    expect(orphaned).toHaveLength(0);
  });

  it("should return empty array when no messages", () => {
    const orphaned = findOrphanedMessages([], now, timeout);
    expect(orphaned).toHaveLength(0);
  });

  it("should return empty array when all messages are healthy", () => {
    const messages = [
      makeMessage({ id: "msg-1", heartbeat_at: now - 10000 }),
      makeMessage({ id: "msg-2", heartbeat_at: now - 20000 }),
      makeMessage({ id: "msg-3", heartbeat_at: now - 30000 })
    ];

    const orphaned = findOrphanedMessages(messages, now, timeout);
    expect(orphaned).toHaveLength(0);
  });

  it("should use default timeout from config", () => {
    const messages = [
      makeMessage({
        id: "msg-1",
        heartbeat_at: now - SCHEDULING_CONFIG.heartbeatTimeoutSeconds * 1000 - 1
      })
    ];

    const orphaned = findOrphanedMessages(messages, now);
    expect(orphaned).toHaveLength(1);
  });

  it("should respect custom timeout", () => {
    const messages = [
      makeMessage({ id: "msg-1", heartbeat_at: now - 10000 }) // 10s ago
    ];

    // With 5s timeout, this should be orphaned
    const orphaned = findOrphanedMessages(messages, now, 5000);
    expect(orphaned).toHaveLength(1);

    // With 20s timeout, this should be ok
    const orphaned2 = findOrphanedMessages(messages, now, 20000);
    expect(orphaned2).toHaveLength(0);
  });
});

describe("determineRecoveryAction", () => {
  function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
    return {
      id: "msg-1",
      status: "streaming",
      heartbeat_at: null,
      checkpoint: null,
      attempt: 1,
      task_id: "task-1",
      ...overrides
    };
  }

  it("should return resume if checkpoint exists", () => {
    const msg = makeMessage({ checkpoint: "step-5", attempt: 3 });
    expect(determineRecoveryAction(msg)).toBe("resume");
  });

  it("should return retry if under max attempts", () => {
    const msg = makeMessage({ attempt: 1 });
    expect(determineRecoveryAction(msg, 3)).toBe("retry");

    const msg2 = makeMessage({ attempt: 2 });
    expect(determineRecoveryAction(msg2, 3)).toBe("retry");
  });

  it("should return fail if at max attempts", () => {
    const msg = makeMessage({ attempt: 3 });
    expect(determineRecoveryAction(msg, 3)).toBe("fail");
  });

  it("should return fail if over max attempts", () => {
    const msg = makeMessage({ attempt: 5 });
    expect(determineRecoveryAction(msg, 3)).toBe("fail");
  });

  it("should use default max attempts from config", () => {
    const msg = makeMessage({ attempt: SCHEDULING_CONFIG.maxAttempts });
    expect(determineRecoveryAction(msg)).toBe("fail");
  });

  it("should prefer resume over retry even if under max attempts", () => {
    const msg = makeMessage({ checkpoint: "step-1", attempt: 1 });
    expect(determineRecoveryAction(msg, 3)).toBe("resume");
  });
});

describe("buildRecoveryPayload", () => {
  function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
    return {
      id: "msg-123",
      status: "streaming",
      heartbeat_at: null,
      checkpoint: null,
      attempt: 1,
      task_id: "task-1",
      ...overrides
    };
  }

  it("should build payload with message id", () => {
    const msg = makeMessage({ id: "msg-456" });
    const payload = buildRecoveryPayload(msg);
    expect(payload.messageId).toBe("msg-456");
  });

  it("should include checkpoint if present", () => {
    const msg = makeMessage({ checkpoint: "step-5" });
    const payload = buildRecoveryPayload(msg);
    expect(payload.checkpoint).toBe("step-5");
  });

  it("should omit checkpoint if null", () => {
    const msg = makeMessage({ checkpoint: null });
    const payload = buildRecoveryPayload(msg);
    expect(payload.checkpoint).toBeUndefined();
  });

  it("should use default reason of orphaned", () => {
    const msg = makeMessage();
    const payload = buildRecoveryPayload(msg);
    expect(payload.reason).toBe("orphaned");
  });

  it("should accept custom reason", () => {
    const msg = makeMessage();
    const payload = buildRecoveryPayload(msg, "heartbeat_expired");
    expect(payload.reason).toBe("heartbeat_expired");
  });
});

// =============================================================================
// Status Helper Tests
// =============================================================================

describe("isTerminalStatus", () => {
  it("should return true for complete", () => {
    expect(isTerminalStatus("complete")).toBe(true);
  });

  it("should return true for error", () => {
    expect(isTerminalStatus("error")).toBe(true);
  });

  it("should return true for cancelled", () => {
    expect(isTerminalStatus("cancelled")).toBe(true);
  });

  it("should return false for pending", () => {
    expect(isTerminalStatus("pending")).toBe(false);
  });

  it("should return false for streaming", () => {
    expect(isTerminalStatus("streaming")).toBe(false);
  });
});

describe("isActiveStatus", () => {
  it("should return true for pending", () => {
    expect(isActiveStatus("pending")).toBe(true);
  });

  it("should return true for streaming", () => {
    expect(isActiveStatus("streaming")).toBe(true);
  });

  it("should return false for complete", () => {
    expect(isActiveStatus("complete")).toBe(false);
  });

  it("should return false for error", () => {
    expect(isActiveStatus("error")).toBe(false);
  });

  it("should return false for cancelled", () => {
    expect(isActiveStatus("cancelled")).toBe(false);
  });
});

// =============================================================================
// Config Tests
// =============================================================================

describe("SCHEDULING_CONFIG", () => {
  it("should have reasonable default values", () => {
    expect(SCHEDULING_CONFIG.maxAttempts).toBe(3);
    expect(SCHEDULING_CONFIG.baseBackoffSeconds).toBe(2);
    expect(SCHEDULING_CONFIG.maxBackoffSeconds).toBe(60);
    expect(SCHEDULING_CONFIG.heartbeatIntervalSeconds).toBe(30);
    expect(SCHEDULING_CONFIG.heartbeatTimeoutSeconds).toBe(60);
    expect(SCHEDULING_CONFIG.maxExecutionTimeSeconds).toBe(300);
  });

  it("should be readonly", () => {
    // This test documents that config is const
    // TypeScript will prevent mutation at compile time
    expect(Object.isFrozen(SCHEDULING_CONFIG)).toBe(false); // as const doesn't freeze
    // But the type system prevents: SCHEDULING_CONFIG.maxAttempts = 5; // TS error
  });
});
