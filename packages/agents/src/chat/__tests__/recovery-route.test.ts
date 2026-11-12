import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  ChatRecoveryEngine,
  type ChatRecoveryAdapter
} from "../recovery-engine";
import type { ChatRecoveryOptions } from "../lifecycle";
import type { MessagePart } from "../message-builder";
import type { StreamInterruptionHost } from "../recovery-route";
import {
  resolveChatRecoveryConfig,
  type ChatRecoveryIncident
} from "../recovery-incident";

/**
 * `routeStreamInterruption` is what both hosts run when a live turn's stream
 * stalls or fails with a transient error. These tests pin its sequence and
 * the retry-or-continue decision.
 */

const text = (value: string): MessagePart => ({ type: "text", text: value });
const settledTool: MessagePart = {
  type: "tool-search",
  toolCallId: "call-1",
  state: "output-available",
  input: {},
  output: { ok: true }
} as MessagePart;

type Scenario = {
  partialParts?: MessagePart[];
  /** What `onChatRecovery` returns, or an error it throws. */
  options?: ChatRecoveryOptions | Error;
  /** The unanswered user message, when there is one. */
  retryTarget?: string | null;
  /** The stored assistant message when the partial is kept. */
  storedReplyId?: string;
  maxAttempts?: number;
  /** Throws from the incident store, to fail the routing itself. */
  storageFails?: boolean;
};

function setup(scenario: Scenario = {}) {
  const storage = new Map<string, ChatRecoveryIncident>();
  const scheduled: Array<{
    callback: string;
    data: Record<string, unknown>;
    reason: string;
    delaySeconds: number;
  }> = [];
  const exhausted: string[] = [];
  const log: string[] = [];
  const adapter: ChatRecoveryAdapter = {
    resolveConfig: () =>
      resolveChatRecoveryConfig(
        scenario.maxAttempts === undefined
          ? undefined
          : { maxAttempts: scenario.maxAttempts }
      ),
    now: () => 1_000,
    sweepStaleIncidents: () => Promise.resolve(),
    getIncident: (key) =>
      scenario.storageFails
        ? Promise.reject(new Error("storage is down"))
        : Promise.resolve(storage.get(key) ?? null),
    readProgress: () => Promise.resolve(0),
    putIncident: (key, incident) => {
      storage.set(key, incident);
      return Promise.resolve();
    },
    syncStorage: () => Promise.resolve(),
    deleteIncident: (key) => {
      storage.delete(key);
      return Promise.resolve();
    },
    emitRecoveryEvent: () => {},
    scheduleRecovery: (callback, data, reason, delaySeconds) => {
      scheduled.push({ callback, data, reason, delaySeconds });
      return Promise.resolve();
    },
    setRecovering: () => Promise.resolve(),
    exhaustChatRecovery: (incident) => {
      exhausted.push(incident.reason ?? "");
      return Promise.resolve();
    },
    resolveRecoveryStream: () => ({ streamId: "", streamStillActive: false }),
    getPartialStreamText: () => ({
      text: "",
      parts: [],
      hasSettledToolResults: false
    }),
    turns: {
      label: "[test]",
      beginRecoveryAttempt: () => ({
        signal: new AbortController().signal,
        end: () => {}
      }),
      waitUntilStable: () => Promise.resolve(true),
      restoreRequestContext: () => {},
      reconcileAgentToolChildRuns: () => Promise.resolve(),
      trackAlarmWork: () => {},
      attemptScope: new AsyncLocalStorage<string>()
    },
    onGiveUpBookkeepingError: () => {}
  };
  const engine = new ChatRecoveryEngine(adapter);
  const host: StreamInterruptionHost = {
    requestId: "request-1",
    streamId: "stream-1",
    partialParts: scenario.partialParts ?? [text("Partial")],
    latestUserMessageId: "user-1",
    retryTargetUserId: async () => {
      log.push("retry-target");
      return scenario.retryTarget ?? null;
    },
    onChatRecovery: async () => {
      log.push("on-chat-recovery");
      if (scenario.options instanceof Error) throw scenario.options;
      return scenario.options;
    },
    resolvePartial: async (keep) => {
      log.push(keep ? "keep" : "drop");
      return keep ? scenario.storedReplyId : undefined;
    },
    requestContext: () => ({
      lastBody: { model: "m" },
      lastClientTools: undefined
    }),
    onDeclined: async () => {
      log.push("declined");
    },
    beforeSchedule: async () => {
      log.push("before-schedule");
    },
    afterSchedule: (chained) => {
      log.push(chained ? "after-schedule:chained" : "after-schedule");
    }
  };
  return {
    engine,
    host,
    log,
    scheduled,
    exhausted,
    incident: () => [...storage.values()][0],
    run: () => engine.routeStreamInterruption(host)
  };
}

describe("routeStreamInterruption", () => {
  it("schedules a continue of the stored partial", async () => {
    const t = setup({ storedReplyId: "assistant-1" });
    expect(await t.run()).toBe("scheduled");

    expect(t.log).toEqual([
      "on-chat-recovery",
      "keep",
      "before-schedule",
      "after-schedule"
    ]);
    expect(t.scheduled).toHaveLength(1);
    expect(t.scheduled[0]).toMatchObject({
      callback: "_chatRecoveryContinue",
      reason: "initial",
      delaySeconds: 0,
      data: {
        targetAssistantId: "assistant-1",
        originalRequestId: "request-1",
        lastBody: { model: "m" },
        lastClientTools: null
      }
    });
    expect(t.incident()).toMatchObject({ status: "scheduled" });
    // The mark a recovery attempt reads after its turn returns.
    expect(t.engine.takeReschedule(t.incident()?.incidentId)).toBe(true);
  });

  it("retries the question when the turn produced nothing", async () => {
    const t = setup({ partialParts: [], retryTarget: "user-1" });
    expect(await t.run()).toBe("scheduled");

    expect(t.scheduled[0]).toMatchObject({
      callback: "_chatRecoveryRetry",
      data: { targetUserId: "user-1" }
    });
    expect(t.scheduled[0]?.data).not.toHaveProperty("targetAssistantId");
    expect(t.incident()).toMatchObject({ recoveryKind: "retry" });
  });

  it("continues when the turn produced nothing and no question is unanswered", async () => {
    const t = setup({ partialParts: [], retryTarget: null });
    expect(await t.run()).toBe("scheduled");
    expect(t.scheduled[0]).toMatchObject({ callback: "_chatRecoveryContinue" });
  });

  it("drops the partial on persist: false and retries the question it leaves unanswered", async () => {
    const t = setup({ options: { persist: false }, retryTarget: "user-1" });
    expect(await t.run()).toBe("scheduled");

    // The retry target is read again after the drop.
    expect(t.log).toEqual([
      "on-chat-recovery",
      "drop",
      "retry-target",
      "before-schedule",
      "after-schedule"
    ]);
    expect(t.scheduled[0]).toMatchObject({
      callback: "_chatRecoveryRetry",
      data: { targetUserId: "user-1" }
    });
  });

  it("keeps a partial that holds a settled tool result, even on persist: false", async () => {
    const t = setup({
      partialParts: [settledTool],
      options: { persist: false },
      storedReplyId: "assistant-1"
    });
    expect(await t.run()).toBe("scheduled");
    expect(t.log).toContain("keep");
    expect(t.log).not.toContain("drop");
  });

  it("stops when the app declines to continue", async () => {
    const t = setup({
      options: { continue: false },
      storedReplyId: "assistant-1"
    });
    expect(await t.run()).toBe("declined");
    expect(t.log).toEqual(["on-chat-recovery", "keep", "declined"]);
    expect(t.scheduled).toEqual([]);
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: "continue_disabled"
    });
  });

  it("marks the incident failed when onChatRecovery throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup({ options: new Error("hook bug") });
    expect(await t.run()).toBe("failed");
    error.mockRestore();
    expect(t.log).toEqual(["on-chat-recovery", "keep"]);
    expect(t.incident()).toMatchObject({
      status: "failed",
      reason: "hook bug"
    });
    expect(t.scheduled).toEqual([]);
  });

  it("gives up with the terminal message once the budget is spent", async () => {
    const t = setup({ maxAttempts: 1, storedReplyId: "assistant-1" });
    expect(await t.run()).toBe("scheduled");
    expect(await t.run()).toBe("exhausted");
    expect(t.exhausted).toHaveLength(1);
    // The app is not asked about a turn that is not going to be recovered.
    expect(t.log.filter((step) => step === "on-chat-recovery")).toHaveLength(1);
    expect(t.scheduled).toHaveLength(1);
  });

  it("chains the next attempt when the turn was itself a recovery attempt", async () => {
    const t = setup({ storedReplyId: "assistant-1" });
    t.engine.activeRootRequestId = "root-request";
    expect(await t.run()).toBe("scheduled");
    expect(t.scheduled[0]).toMatchObject({
      reason: "chained_retry",
      data: { originalRequestId: "root-request" }
    });
    expect(t.log).toContain("after-schedule:chained");
  });

  it("backs off, and waits at least as long as the provider asked", async () => {
    const t = setup({ storedReplyId: "assistant-1" });
    t.host.backoff = true;
    t.host.retryAfterSeconds = 7;
    expect(await t.run()).toBe("scheduled");
    expect(t.scheduled[0]?.delaySeconds).toBeGreaterThanOrEqual(7);
  });

  it("returns failed when the routing itself throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup({ storageFails: true });
    expect(await t.run()).toBe("failed");
    error.mockRestore();
    expect(t.scheduled).toEqual([]);
  });
});
