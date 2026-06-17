import { describe, expect, it } from "vitest";
import { unwrapChatFiberSnapshot } from "../recovery";
import {
  evaluateChatRecoveryIncident,
  resolveChatRecoveryConfig,
  type ChatRecoveryIncident
} from "../recovery-incident";
import {
  AI_CHAT_SNAPSHOT_ENVELOPE,
  LEGACY_AI_CHAT_SNAPSHOT_KEY,
  LEGACY_INCIDENTS,
  LEGACY_RAW_STASH_PAYLOAD,
  LEGACY_THINK_SNAPSHOT_KEY,
  SCHEDULE_PAYLOADS,
  THINK_SNAPSHOT_ENVELOPE
} from "./recovery-cutover-fixtures";

/**
 * Cutover round-trip gate (rfc-chat-recovery-foundation, Phase 0).
 *
 * Asserts the shared recovery layer reads every persisted artifact written by
 * the old per-package code: snapshot envelopes, incident records (including
 * deprecated reasons and missing optional fields), and scheduled-callback
 * payloads with package-specific extra fields. Because old code schedules and
 * new code's `_chatRecoveryContinue` runs on the same wake, the engine must
 * read both old and new shapes for at least one release.
 */

describe("cutover: snapshot envelopes", () => {
  it("unwraps a legacy AIChatAgent snapshot envelope", () => {
    const { snapshot, user } = unwrapChatFiberSnapshot(
      LEGACY_AI_CHAT_SNAPSHOT_KEY,
      AI_CHAT_SNAPSHOT_ENVELOPE,
      "ai-chat-turn"
    );
    expect(snapshot).toMatchObject({
      kind: "ai-chat-turn",
      version: 1,
      requestId: "req-fc1",
      latestUserMessageId: "u2"
    });
    expect(user).toBeNull();
  });

  it("unwraps a legacy Think snapshot envelope and preserves user recovery data", () => {
    const { snapshot, user } = unwrapChatFiberSnapshot(
      LEGACY_THINK_SNAPSHOT_KEY,
      THINK_SNAPSHOT_ENVELOPE,
      "think-chat-turn"
    );
    expect(snapshot).toMatchObject({
      kind: "think-chat-turn",
      version: 1,
      requestId: "req-pre-stream",
      lastBody: { mode: "snapshot" }
    });
    expect(user).toEqual({ providerRequestId: "provider-pre-stream" });
  });

  it("preserves a legacy raw (un-enveloped) stash payload", () => {
    const { snapshot, user } = unwrapChatFiberSnapshot(
      LEGACY_AI_CHAT_SNAPSHOT_KEY,
      LEGACY_RAW_STASH_PAYLOAD
    );
    expect(snapshot).toBeNull();
    expect(user).toEqual(LEGACY_RAW_STASH_PAYLOAD);
  });

  it("does not unwrap one package's envelope under the other package's key", () => {
    const { snapshot } = unwrapChatFiberSnapshot(
      LEGACY_THINK_SNAPSHOT_KEY,
      AI_CHAT_SNAPSHOT_ENVELOPE,
      "ai-chat-turn"
    );
    // Wrong key => treated as raw user data, not a snapshot. The new engine
    // recovers this by trying each adapter's legacy key in turn (Phase 1).
    expect(snapshot).toBeNull();
  });
});

describe("cutover: incident records", () => {
  it("evaluates a legacy incident missing optional fields without crashing", async () => {
    const existing = LEGACY_INCIDENTS.minimal;
    const { incident, exhausted } = await evaluateChatRecoveryIncident({
      identity: {
        requestId: existing.requestId,
        latestUserMessageId: "user-old",
        recoveryKind: existing.recoveryKind
      },
      config: resolveChatRecoveryConfig(true),
      existing,
      currentProgress: 0,
      awaitingClientInteraction: false,
      now: existing.lastAttemptAt + 60_000
    });
    expect(exhausted).toBe(false);
    // A missing workBaseline is treated as the current marker (zero work so far).
    expect(incident.workBaseline).toBe(0);
    // A missing lastProgressAt falls back to firstSeenAt for the no-progress clock.
    expect(incident.attempt).toBe(existing.attempt + 1);
  });

  it("tolerates the deprecated max_recovery_window_exceeded reason on read", () => {
    const stored: ChatRecoveryIncident = LEGACY_INCIDENTS.deprecatedReason;
    // The deprecated reason must remain a valid persisted value (open string).
    expect(stored.reason).toBe("max_recovery_window_exceeded");
    expect(stored.status).toBe("exhausted");
  });
});

describe("cutover: scheduled-callback payloads", () => {
  it("keeps the stable callback names", () => {
    expect(SCHEDULE_PAYLOADS.aiChatContinue.callback).toBe(
      "_chatRecoveryContinue"
    );
    expect(SCHEDULE_PAYLOADS.thinkContinueWithExtra.callback).toBe(
      "_chatRecoveryContinue"
    );
    expect(SCHEDULE_PAYLOADS.retry.callback).toBe("_chatRecoveryRetry");
  });

  it("round-trips Think's extra recoveredRequestId field untouched", () => {
    const roundTripped = JSON.parse(
      JSON.stringify(SCHEDULE_PAYLOADS.thinkContinueWithExtra)
    );
    expect(roundTripped.data.recoveredRequestId).toBe("submission-req-2");
    expect(roundTripped).toEqual(SCHEDULE_PAYLOADS.thinkContinueWithExtra);
  });
});
