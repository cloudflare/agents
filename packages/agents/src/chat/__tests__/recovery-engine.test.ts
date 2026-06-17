import { describe, expect, it } from "vitest";
import {
  ChatRecoveryEngine,
  buildChatRecoveryExhaustedContext,
  chatRecoverySchedulePolicy,
  notifyChatRecoveryExhausted,
  type ChatRecoveryAdapter,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryScheduleReason
} from "../recovery-engine";
import type { ChatRecoveryExhaustedContext } from "../lifecycle";
import type { FiberRecoveryContext } from "../../index";
import {
  chatRecoveryIncidentId,
  chatRecoveryIncidentKey,
  resolveChatRecoveryConfig,
  type ChatRecoveryIncident,
  type ChatRecoveryIncidentEvent
} from "../recovery-incident";

/**
 * Layer-2 shared engine seam tests (rfc-chat-recovery-foundation, Phase 2).
 *
 * The scheduling-idempotency policy is a cutover invariant that no type error
 * guards: an initial recovery schedule MUST be idempotent (so a deploy storm of
 * re-detections collapses to one enqueued continuation), and a stable-timeout
 * reschedule MUST NOT be idempotent (so it does not dedup onto the executing
 * one-shot row that `alarm()` is about to delete). Both `AIChatAgent` and
 * `Think` now source this single flag from `chatRecoverySchedulePolicy`; these
 * tests pin it both directly and through a fake scheduler exercised exactly the
 * way the packages call `schedule()`.
 */
describe("chatRecoverySchedulePolicy", () => {
  it("makes the initial recovery schedule idempotent (deploy-storm dedup)", () => {
    expect(chatRecoverySchedulePolicy("initial")).toEqual({ idempotent: true });
  });

  it("makes the stable-timeout reschedule non-idempotent (survives row deletion)", () => {
    expect(chatRecoverySchedulePolicy("stable_timeout_retry")).toEqual({
      idempotent: false
    });
  });

  it("is exhaustive over the schedule reasons", () => {
    const reasons: ChatRecoveryScheduleReason[] = [
      "initial",
      "stable_timeout_retry"
    ];
    for (const reason of reasons) {
      const policy = chatRecoverySchedulePolicy(reason);
      expect(typeof policy.idempotent).toBe("boolean");
    }
  });
});

describe("recovery scheduling seam (fake scheduler)", () => {
  type ScheduleCall = {
    delaySeconds: number;
    callback: ChatRecoveryScheduleCallback;
    options: { idempotent: boolean };
  };

  function makeFakeScheduler() {
    const calls: ScheduleCall[] = [];
    const schedule = (
      delaySeconds: number,
      callback: ChatRecoveryScheduleCallback,
      _data: Record<string, unknown>,
      options: { idempotent: boolean }
    ): Promise<void> => {
      calls.push({ delaySeconds, callback, options });
      return Promise.resolve();
    };
    return { calls, schedule };
  }

  it("passes idempotent:true when a package schedules an initial continuation", async () => {
    const scheduler = makeFakeScheduler();
    // Mirrors `AIChatAgent`/`Think` scheduling an initial continuation.
    await scheduler.schedule(
      0,
      "_chatRecoveryContinue",
      { incidentId: "abc" },
      chatRecoverySchedulePolicy("initial")
    );
    expect(scheduler.calls).toHaveLength(1);
    expect(scheduler.calls[0]?.options).toEqual({ idempotent: true });
  });

  it("passes idempotent:false when a package reschedules after a stable timeout", async () => {
    const scheduler = makeFakeScheduler();
    // Mirrors the stable-timeout reschedule issued from inside the executing row.
    await scheduler.schedule(
      5,
      "_chatRecoveryRetry",
      { incidentId: "abc" },
      chatRecoverySchedulePolicy("stable_timeout_retry")
    );
    expect(scheduler.calls).toHaveLength(1);
    expect(scheduler.calls[0]?.options).toEqual({ idempotent: false });
  });
});

/**
 * Layer-2 orchestration seam test for `ChatRecoveryEngine.beginIncident`. The
 * budget math is owned (and exhaustively tested) by the pure
 * `evaluateChatRecoveryIncident`; this asserts the *sequence* the engine drives
 * over a fake adapter: sweep-before-read, interaction-state-rehydration before
 * the predicate, the computed storage key, persistence, and event fan-out — the
 * exact orchestration both `AIChatAgent` and `Think` now delegate.
 */
describe("ChatRecoveryEngine.beginIncident (fake adapter)", () => {
  type FakeAdapterOptions = {
    awaitingClientInteraction?: boolean;
    progress?: number;
    withInteractionHook?: boolean;
  };

  function makeFakeAdapter(options: FakeAdapterOptions = {}) {
    const storage = new Map<string, ChatRecoveryIncident>();
    const events: ChatRecoveryIncidentEvent[] = [];
    const calls: string[] = [];
    const recovering: Array<{ active: boolean; requestId?: string }> = [];
    let nowCalls = 0;

    const adapter: ChatRecoveryAdapter = {
      resolveConfig: () => resolveChatRecoveryConfig(undefined),
      now: () => {
        nowCalls += 1;
        return 1_000;
      },
      sweepStaleIncidents: (_now) => {
        calls.push("sweep");
        return Promise.resolve();
      },
      getIncident: (key) => {
        calls.push("get");
        return Promise.resolve(storage.get(key) ?? null);
      },
      readProgress: () => {
        calls.push("readProgress");
        return Promise.resolve(options.progress ?? 0);
      },
      isAwaitingClientInteraction: () => {
        calls.push("isAwaiting");
        return options.awaitingClientInteraction ?? false;
      },
      putIncident: (key, incident) => {
        calls.push("put");
        storage.set(key, incident);
        return Promise.resolve();
      },
      deleteIncident: (key) => {
        calls.push("delete");
        storage.delete(key);
        return Promise.resolve();
      },
      emitRecoveryEvent: (event) => {
        calls.push("emit");
        events.push(event);
      },
      scheduleRecovery: () => {
        calls.push("schedule");
        return Promise.resolve();
      },
      setRecovering: (active, requestId) => {
        calls.push("setRecovering");
        recovering.push({ active, requestId });
        return Promise.resolve();
      },
      onShouldKeepRecoveringError: () => {
        calls.push("shouldKeepRecoveringError");
      }
    };

    if (options.withInteractionHook !== false) {
      adapter.ensureInteractionStateLoaded = () => {
        calls.push("ensureInteractionStateLoaded");
      };
    }

    return {
      adapter,
      storage,
      events,
      calls,
      recovering,
      nowCalls: () => nowCalls
    };
  }

  const input = {
    requestId: "req-1",
    recoveryRootRequestId: "req-1",
    recoveryKind: "continue" as const,
    nowMs: 5_000
  };

  it("persists the incident under the pure-derived key and returns it", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    const result = await engine.beginIncident(input);

    const expectedKey = chatRecoveryIncidentKey(chatRecoveryIncidentId(input));
    expect(fake.storage.has(expectedKey)).toBe(true);
    expect(fake.storage.get(expectedKey)).toEqual(result.incident);
    expect(result.config).toEqual(resolveChatRecoveryConfig(undefined));
    expect(typeof result.exhausted).toBe("boolean");
  });

  it("drives the sequence with the two ordering invariants", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    await engine.beginIncident(input);

    const sweepIdx = fake.calls.indexOf("sweep");
    const getIdx = fake.calls.indexOf("get");
    const hookIdx = fake.calls.indexOf("ensureInteractionStateLoaded");
    const awaitingIdx = fake.calls.indexOf("isAwaiting");
    const putIdx = fake.calls.indexOf("put");

    // Invariant 1: sweep stale incidents before reading the existing record.
    expect(sweepIdx).toBeGreaterThanOrEqual(0);
    expect(sweepIdx).toBeLessThan(getIdx);
    // Invariant 2: rehydrate interaction state after the read, before the
    // budget consults the interaction predicate.
    expect(hookIdx).toBeGreaterThan(getIdx);
    expect(hookIdx).toBeLessThan(awaitingIdx);
    // Persistence happens after the predicate read.
    expect(putIdx).toBeGreaterThan(awaitingIdx);
  });

  it("uses the injected nowMs and never consults the wall clock", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    await engine.beginIncident(input);

    expect(fake.nowCalls()).toBe(0);
  });

  it("forwards every budget event to the adapter for broadcast", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    const result = await engine.beginIncident(input);

    // A fresh incident opens with at least one lifecycle event, all carrying
    // the persisted incident's id.
    expect(fake.events.length).toBeGreaterThan(0);
    for (const event of fake.events) {
      expect(event.incidentId).toBe(result.incident.incidentId);
    }
  });

  it("works without the optional interaction hook (AIChatAgent shape)", async () => {
    const fake = makeFakeAdapter({ withInteractionHook: false });
    const engine = new ChatRecoveryEngine(fake.adapter);

    const result = await engine.beginIncident(input);

    expect(fake.calls).not.toContain("ensureInteractionStateLoaded");
    const expectedKey = chatRecoveryIncidentKey(chatRecoveryIncidentId(input));
    expect(fake.storage.get(expectedKey)).toEqual(result.incident);
  });
});

/**
 * Layer-2 transition seam test for `ChatRecoveryEngine.updateIncident` — the
 * twin of `beginIncident` that both `AIChatAgent` and `Think` now delegate to.
 * Pins the state-machine shape: completed drops the record, other states
 * persist; completed/skipped/failed emit the matching lifecycle event (with the
 * cause for skipped/failed); and the #1620 "recovering…" status is set on
 * `scheduled` and cleared on every terminal state.
 */
describe("ChatRecoveryEngine.updateIncident (fake adapter)", () => {
  function makeFakeAdapter() {
    const storage = new Map<string, ChatRecoveryIncident>();
    const events: ChatRecoveryIncidentEvent[] = [];
    const recovering: Array<{ active: boolean; requestId?: string }> = [];

    const adapter: ChatRecoveryAdapter = {
      resolveConfig: () => resolveChatRecoveryConfig(undefined),
      now: () => 1_000,
      sweepStaleIncidents: () => Promise.resolve(),
      getIncident: (key) => Promise.resolve(storage.get(key) ?? null),
      readProgress: () => Promise.resolve(0),
      isAwaitingClientInteraction: () => false,
      putIncident: (key, incident) => {
        storage.set(key, incident);
        return Promise.resolve();
      },
      deleteIncident: (key) => {
        storage.delete(key);
        return Promise.resolve();
      },
      emitRecoveryEvent: (event) => {
        events.push(event);
      },
      scheduleRecovery: () => Promise.resolve(),
      setRecovering: (active, requestId) => {
        recovering.push({ active, requestId });
        return Promise.resolve();
      },
      onShouldKeepRecoveringError: () => {}
    };

    return { adapter, storage, events, recovering };
  }

  function seedIncident(
    storage: Map<string, ChatRecoveryIncident>,
    overrides: Partial<ChatRecoveryIncident> = {}
  ): { incidentId: string; key: string; incident: ChatRecoveryIncident } {
    const incident: ChatRecoveryIncident = {
      incidentId: "root-1:user-1",
      requestId: "req-1",
      recoveryRootRequestId: "root-1",
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 6,
      status: "attempting",
      firstSeenAt: 1_000,
      lastAttemptAt: 1_000,
      ...overrides
    };
    const key = chatRecoveryIncidentKey(incident.incidentId);
    storage.set(key, incident);
    return { incidentId: incident.incidentId, key, incident };
  }

  it("marks the turn recovering on a scheduled transition (no terminal event)", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const { incidentId, key } = seedIncident(fake.storage);

    await engine.updateIncident(incidentId, "scheduled");

    // Persisted with the new status (not deleted).
    expect(fake.storage.get(key)?.status).toBe("scheduled");
    // Recovering set, keyed by the recovery-root request id.
    expect(fake.recovering).toEqual([{ active: true, requestId: "root-1" }]);
    // No completed/skipped/failed event for a scheduled transition.
    expect(fake.events).toHaveLength(0);
  });

  it("drops the record, emits completed, and clears recovering on completed", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const { incidentId, key } = seedIncident(fake.storage);

    await engine.updateIncident(incidentId, "completed");

    // A completed recovery is terminal — the record is dropped, not retained.
    expect(fake.storage.has(key)).toBe(false);
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]).toMatchObject({
      type: "chat:recovery:completed",
      incidentId,
      requestId: "req-1"
    });
    expect(fake.events[0].reason).toBeUndefined();
    expect(fake.recovering).toEqual([{ active: false, requestId: undefined }]);
  });

  it("persists, emits failed WITH the cause, and clears recovering on failed", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const { incidentId, key } = seedIncident(fake.storage);

    await engine.updateIncident(incidentId, "failed", "boom");

    // Non-completed terminal states are retained (budget survives restarts).
    expect(fake.storage.get(key)?.status).toBe("failed");
    expect(fake.storage.get(key)?.reason).toBe("boom");
    expect(fake.events[0]).toMatchObject({
      type: "chat:recovery:failed",
      reason: "boom"
    });
    expect(fake.recovering).toEqual([{ active: false, requestId: undefined }]);
  });

  it("emits skipped (with cause) and clears recovering on skipped", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const { incidentId } = seedIncident(fake.storage);

    await engine.updateIncident(incidentId, "skipped", "conversation_changed");

    expect(fake.events[0]).toMatchObject({
      type: "chat:recovery:skipped",
      reason: "conversation_changed"
    });
    expect(fake.recovering).toEqual([{ active: false, requestId: undefined }]);
  });

  it("is a no-op when the incident id is undefined", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    await engine.updateIncident(undefined, "completed");

    expect(fake.events).toHaveLength(0);
    expect(fake.recovering).toHaveLength(0);
  });

  it("is a no-op when no record exists for the incident", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    await engine.updateIncident("missing:incident", "failed", "boom");

    expect(fake.events).toHaveLength(0);
    expect(fake.recovering).toHaveLength(0);
    expect(fake.storage.size).toBe(0);
  });
});

/**
 * Layer-2 seam test for `ChatRecoveryEngine.scheduleRecovery` (slice 4b) — the
 * transition + emit + enqueue triplet both packages repeated at every fiber-
 * recovery / stall-routing decision. Pins: the `scheduled` incident transition
 * (persist + recovering flag) runs before the `chat:recovery:scheduled` emit,
 * which runs before the enqueue; the emitted `recoveryKind` is the EXPLICIT one
 * the caller passed (not the incident's — `AIChatAgent`'s lost-partial branch
 * opens a `continue` incident but schedules a `retry`); and the schedule reason
 * selects the idempotency policy (defaulting to `initial`).
 */
describe("ChatRecoveryEngine.scheduleRecovery (fake adapter)", () => {
  type ScheduleCall = {
    callback: ChatRecoveryScheduleCallback;
    data: Record<string, unknown>;
    reason: ChatRecoveryScheduleReason;
  };

  function makeFakeAdapter() {
    const storage = new Map<string, ChatRecoveryIncident>();
    const events: ChatRecoveryIncidentEvent[] = [];
    const recovering: Array<{ active: boolean; requestId?: string }> = [];
    const schedules: ScheduleCall[] = [];
    const order: string[] = [];

    const adapter: ChatRecoveryAdapter = {
      resolveConfig: () => resolveChatRecoveryConfig(undefined),
      now: () => 1_000,
      sweepStaleIncidents: () => Promise.resolve(),
      getIncident: (key) => Promise.resolve(storage.get(key) ?? null),
      readProgress: () => Promise.resolve(0),
      isAwaitingClientInteraction: () => false,
      putIncident: (key, incident) => {
        order.push("put");
        storage.set(key, incident);
        return Promise.resolve();
      },
      deleteIncident: (key) => {
        storage.delete(key);
        return Promise.resolve();
      },
      emitRecoveryEvent: (event) => {
        order.push(`emit:${event.type}`);
        events.push(event);
      },
      scheduleRecovery: (callback, data, reason) => {
        order.push("schedule");
        schedules.push({ callback, data, reason });
        return Promise.resolve();
      },
      setRecovering: (active, requestId) => {
        order.push("setRecovering");
        recovering.push({ active, requestId });
        return Promise.resolve();
      },
      onShouldKeepRecoveringError: () => {}
    };

    return { adapter, storage, events, recovering, schedules, order };
  }

  function seedIncident(
    storage: Map<string, ChatRecoveryIncident>,
    overrides: Partial<ChatRecoveryIncident> = {}
  ): ChatRecoveryIncident {
    const incident: ChatRecoveryIncident = {
      incidentId: "root-1:user-1",
      requestId: "req-attempt-2",
      recoveryRootRequestId: "root-1",
      recoveryKind: "continue",
      attempt: 2,
      maxAttempts: 6,
      status: "attempting",
      firstSeenAt: 1_000,
      lastAttemptAt: 1_000,
      ...overrides
    };
    storage.set(chatRecoveryIncidentKey(incident.incidentId), incident);
    return incident;
  }

  it("drives transition -> emit -> enqueue in order", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const incident = seedIncident(fake.storage);

    await engine.scheduleRecovery({
      incident,
      recoveryKind: incident.recoveryKind,
      callback: "_chatRecoveryContinue",
      data: { incidentId: incident.incidentId, originalRequestId: "root-1" }
    });

    // The incident transitions to `scheduled` (persisted + recovering flag set)
    // BEFORE the scheduled event, which fires BEFORE the enqueue.
    const putIdx = fake.order.indexOf("put");
    const recoveringIdx = fake.order.indexOf("setRecovering");
    const emitIdx = fake.order.indexOf("emit:chat:recovery:scheduled");
    const scheduleIdx = fake.order.indexOf("schedule");
    expect(putIdx).toBeGreaterThanOrEqual(0);
    expect(recoveringIdx).toBeGreaterThan(putIdx);
    expect(emitIdx).toBeGreaterThan(recoveringIdx);
    expect(scheduleIdx).toBeGreaterThan(emitIdx);

    expect(
      fake.storage.get(chatRecoveryIncidentKey(incident.incidentId))?.status
    ).toBe("scheduled");
    expect(fake.recovering).toEqual([{ active: true, requestId: "root-1" }]);
  });

  it("emits the scheduled event with the incident's request id + the EXPLICIT recoveryKind", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    // A `continue` incident scheduled as a `retry` (the lost-partial branch).
    const incident = seedIncident(fake.storage, { recoveryKind: "continue" });

    await engine.scheduleRecovery({
      incident,
      recoveryKind: "retry",
      callback: "_chatRecoveryRetry",
      data: {}
    });

    const scheduled = fake.events.find(
      (e) => e.type === "chat:recovery:scheduled"
    );
    expect(scheduled).toMatchObject({
      type: "chat:recovery:scheduled",
      incidentId: incident.incidentId,
      requestId: "req-attempt-2",
      attempt: 2,
      maxAttempts: 6,
      recoveryKind: "retry"
    });
  });

  it("defaults the schedule reason to initial (idempotent dedup)", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const incident = seedIncident(fake.storage);

    await engine.scheduleRecovery({
      incident,
      recoveryKind: incident.recoveryKind,
      callback: "_chatRecoveryContinue",
      data: {}
    });

    expect(fake.schedules).toHaveLength(1);
    expect(fake.schedules[0]).toMatchObject({
      callback: "_chatRecoveryContinue",
      reason: "initial"
    });
  });

  it("forwards an explicit reason and the per-callback payload verbatim", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const incident = seedIncident(fake.storage);
    const data = { targetUserId: "u-1", originalRequestId: "root-1" };

    await engine.scheduleRecovery({
      incident,
      recoveryKind: "retry",
      callback: "_chatRecoveryRetry",
      data,
      reason: "stable_timeout_retry"
    });

    expect(fake.schedules[0]).toEqual({
      callback: "_chatRecoveryRetry",
      data,
      reason: "stable_timeout_retry"
    });
  });
});

/**
 * Layer-2 shared exhaustion-notification seam (rfc-chat-recovery-foundation,
 * Phase 2 slice 2c). Only the context build + event emit + `onExhausted`
 * hook-swallow are shared; the terminal-record / banner / submission writes (and
 * their ordering) stay package-owned because that ordering legitimately diverges
 * (`@cloudflare/ai-chat` persists-first for #1645 reconnect reliability; `Think`
 * broadcasts-first for banner resilience). These tests pin the shared core.
 */
describe("buildChatRecoveryExhaustedContext", () => {
  const config = resolveChatRecoveryConfig(undefined);

  function makeIncident(
    overrides: Partial<ChatRecoveryIncident> = {}
  ): ChatRecoveryIncident {
    return {
      incidentId: "inc-1",
      requestId: "req-1",
      recoveryRootRequestId: "root-1",
      recoveryKind: "continue",
      attempt: 2,
      maxAttempts: 5,
      status: "exhausted",
      firstSeenAt: 1_000,
      lastAttemptAt: 2_000,
      reason: "no_progress_timeout",
      ...overrides
    };
  }

  it("maps every incident/config field onto the exhausted context", () => {
    const ctx = buildChatRecoveryExhaustedContext({
      incident: makeIncident(),
      config,
      partialText: "hello",
      partialParts: [],
      streamId: "stream-9",
      createdAt: 1_500
    });

    expect(ctx).toEqual({
      incidentId: "inc-1",
      requestId: "req-1",
      recoveryRootRequestId: "root-1",
      attempt: 2,
      maxAttempts: 5,
      recoveryKind: "continue",
      streamId: "stream-9",
      createdAt: 1_500,
      partialText: "hello",
      partialParts: [],
      reason: "no_progress_timeout",
      terminalMessage: config.terminalMessage
    });
  });

  it("falls back recoveryRootRequestId to requestId when unset", () => {
    const ctx = buildChatRecoveryExhaustedContext({
      incident: makeIncident({ recoveryRootRequestId: undefined }),
      config,
      partialText: "",
      partialParts: [],
      streamId: "",
      createdAt: 0
    });

    expect(ctx.recoveryRootRequestId).toBe("req-1");
  });

  it("falls back reason to max_attempts_exceeded when the incident has none", () => {
    const ctx = buildChatRecoveryExhaustedContext({
      incident: makeIncident({ reason: undefined }),
      config,
      partialText: "",
      partialParts: [],
      streamId: "",
      createdAt: 0
    });

    expect(ctx.reason).toBe("max_attempts_exceeded");
  });
});

describe("notifyChatRecoveryExhausted", () => {
  const ctx: ChatRecoveryExhaustedContext = {
    incidentId: "inc-1",
    requestId: "req-1",
    recoveryRootRequestId: "root-1",
    attempt: 5,
    maxAttempts: 5,
    recoveryKind: "continue",
    streamId: "stream-1",
    createdAt: 0,
    partialText: "",
    partialParts: [],
    reason: "max_attempts_exceeded",
    terminalMessage: "Something went wrong."
  };

  it("emits the event before invoking the onExhausted hook", async () => {
    const order: string[] = [];
    await notifyChatRecoveryExhausted(ctx, {
      emit: () => order.push("emit"),
      onExhausted: () => {
        order.push("onExhausted");
      },
      onError: () => order.push("onError")
    });

    expect(order).toEqual(["emit", "onExhausted"]);
  });

  it("swallows a throwing onExhausted hook and reports it via onError", async () => {
    const order: string[] = [];
    const thrown = new Error("hook boom");
    let reported: unknown;

    await expect(
      notifyChatRecoveryExhausted(ctx, {
        emit: () => order.push("emit"),
        onExhausted: () => {
          order.push("onExhausted");
          throw thrown;
        },
        onError: (error) => {
          order.push("onError");
          reported = error;
        }
      })
    ).resolves.toBeUndefined();

    // The event still fired (terminal UX is never blocked by a bad hook), and
    // the error surfaced through onError rather than propagating.
    expect(order).toEqual(["emit", "onExhausted", "onError"]);
    expect(reported).toBe(thrown);
  });

  it("emits even when no onExhausted hook is configured", async () => {
    const order: string[] = [];
    await notifyChatRecoveryExhausted(ctx, {
      emit: () => order.push("emit"),
      onError: () => order.push("onError")
    });

    expect(order).toEqual(["emit"]);
  });
});

/**
 * Layer-2 seam test for the non-chat fiber dispatch (slice 3c). `Think` routes
 * its messenger/workflow reply fibers through `tryHandleNonChatFiberRecovery`
 * before chat recovery; `AIChatAgent` omits the hook (every fiber is a chat
 * candidate). The engine owns only the dispatch + the "handled? skip chat
 * recovery" contract.
 */
describe("ChatRecoveryEngine.handleNonChatFiber (fake adapter)", () => {
  // A minimal subset of the adapter — `handleNonChatFiber` only touches the one
  // hook, so the other methods are never called here.
  function engineWithHook(
    hook?: ChatRecoveryAdapter["tryHandleNonChatFiberRecovery"]
  ) {
    const adapter = {
      tryHandleNonChatFiberRecovery: hook
    } as unknown as ChatRecoveryAdapter;
    return new ChatRecoveryEngine(adapter);
  }

  const ctx: FiberRecoveryContext = {
    id: "fiber-1",
    name: "think:messenger-reply",
    snapshot: null,
    createdAt: 0,
    recoveryReason: "interrupted"
  };

  it("returns true when the package's hook consumes the fiber", async () => {
    const seen: FiberRecoveryContext[] = [];
    const engine = engineWithHook(async (c) => {
      seen.push(c);
      return true;
    });

    expect(await engine.handleNonChatFiber(ctx)).toBe(true);
    expect(seen).toEqual([ctx]);
  });

  it("returns false when the hook declines the fiber (falls through to chat recovery)", async () => {
    const engine = engineWithHook(async () => false);
    expect(await engine.handleNonChatFiber(ctx)).toBe(false);
  });

  it("returns false when the adapter omits the hook (AIChatAgent shape)", async () => {
    const engine = engineWithHook(undefined);
    expect(await engine.handleNonChatFiber(ctx)).toBe(false);
  });
});
