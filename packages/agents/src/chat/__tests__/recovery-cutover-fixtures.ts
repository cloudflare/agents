/**
 * Golden cutover fixtures (rfc-chat-recovery-foundation, Phase 0).
 *
 * The deploy that ships the shared recovery engine is itself a
 * deploy-mid-recovery event: when the new engine boots it can find incidents,
 * snapshots, and schedule payloads written by the old per-package code. These
 * fixtures are real persisted artifacts captured from `@cloudflare/ai-chat` and
 * `@cloudflare/think` (see `durable-chat-recovery.test.ts` and
 * `think-session.test.ts`). The engine MUST round-trip every one of them
 * without a data migration.
 *
 * Treat these as frozen. They model bytes already sitting in production Durable
 * Object storage; changing them would defeat the purpose of the gate.
 */

import type { ChatRecoveryIncident } from "../recovery-incident";

/** The durable fiber name prefix both packages use for a chat turn. */
export const CHAT_FIBER_NAME_PREFIX = "__cf_internal_chat_turn:";

/** Legacy per-package snapshot envelope keys (pre-shared-key cutover). */
export const LEGACY_AI_CHAT_SNAPSHOT_KEY = "__cfAIChatFiberSnapshot";
export const LEGACY_THINK_SNAPSHOT_KEY = "__cfThinkChatFiberSnapshot";

/**
 * Snapshot envelopes as written by the old per-package code. The new engine
 * unwraps these by trying the shared key first, then the adapter's legacy keys.
 */
export const AI_CHAT_SNAPSHOT_ENVELOPE = {
  __cfAIChatFiberSnapshot: {
    kind: "ai-chat-turn",
    version: 1,
    requestId: "req-fc1",
    continuation: false,
    latestMessageId: "u2",
    latestMessageRole: "user",
    latestUserMessageId: "u2",
    startedAt: 1_700_000_000_000
  },
  user: null
} as const;

export const THINK_SNAPSHOT_ENVELOPE = {
  __cfThinkChatFiberSnapshot: {
    kind: "think-chat-turn",
    version: 1,
    requestId: "req-pre-stream",
    continuation: false,
    latestMessageId: "u-pre-stream",
    latestMessageRole: "user",
    latestUserMessageId: "u-pre-stream",
    startedAt: 1_700_000_000_000,
    lastBody: { mode: "snapshot" }
  },
  user: { providerRequestId: "provider-pre-stream" }
} as const;

/**
 * A pre-envelope (legacy unwrapped) stash payload: the user's recovery data was
 * stored directly, with no snapshot key. `unwrapChatFiberSnapshot` must return
 * `{ snapshot: null, user: <the raw value> }` so it still recovers.
 */
export const LEGACY_RAW_STASH_PAYLOAD = {
  providerRequestId: "legacy-provider"
} as const;

/**
 * Pre-cutover incident records. Includes records missing optional fields added
 * in later builds (`workBaseline`, `lastProgressAt`, `recoveryRootRequestId`)
 * and a record carrying the DEPRECATED `max_recovery_window_exceeded` reason,
 * which must remain tolerated in persisted records.
 */
export const LEGACY_INCIDENTS: Record<string, ChatRecoveryIncident> = {
  // Oldest shape: no recoveryRootRequestId, no lastProgressAt, no workBaseline.
  // Timestamps are inside the no-progress window so the still-recoverable
  // fallback path (missing lastProgressAt => firstSeenAt) is exercised.
  minimal: {
    incidentId: "root-old:user-old",
    requestId: "req-old",
    recoveryKind: "continue",
    attempt: 2,
    maxAttempts: 10,
    status: "scheduled",
    firstSeenAt: 1_699_999_000_000,
    lastAttemptAt: 1_699_999_040_000
  },
  // Carries the deprecated terminal reason from an older build.
  deprecatedReason: {
    incidentId: "root-dep:user-dep",
    requestId: "req-dep",
    recoveryRootRequestId: "root-dep",
    recoveryKind: "retry",
    attempt: 11,
    maxAttempts: 10,
    status: "exhausted",
    firstSeenAt: 1_699_999_000_000,
    lastAttemptAt: 1_699_999_900_000,
    lastProgressAt: 1_699_999_000_000,
    reason: "max_recovery_window_exceeded",
    progress: 3,
    workBaseline: 1
  }
};

/**
 * Pre-cutover scheduled-callback payloads. The callback names
 * (`_chatRecoveryContinue` / `_chatRecoveryRetry`) are stable cutover
 * invariants, and unknown/extra fields (such as Think's `recoveredRequestId`)
 * must survive a round-trip through the new code.
 */
export const SCHEDULE_PAYLOADS = {
  aiChatContinue: {
    callback: "_chatRecoveryContinue",
    data: {
      incidentId: "root-1:user-1",
      requestId: "req-1",
      streamId: "stream-1",
      createdAt: 1_700_000_000_000
    }
  },
  thinkContinueWithExtra: {
    callback: "_chatRecoveryContinue",
    data: {
      incidentId: "root-2:user-2",
      requestId: "req-2",
      streamId: "stream-2",
      createdAt: 1_700_000_000_000,
      // Think-specific submission field — must survive a round-trip untouched.
      recoveredRequestId: "submission-req-2"
    }
  },
  retry: {
    callback: "_chatRecoveryRetry",
    data: {
      incidentId: "root-3:user-3",
      requestId: "req-3",
      retryTargetUserId: "user-3",
      createdAt: 1_700_000_000_000
    }
  }
} as const;
