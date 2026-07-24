import { describe, expect, it } from "vitest";
import {
  ChatRecoveryEngine,
  buildChatRecoveryExhaustedContext,
  chatRecoverySchedulePolicy,
  notifyChatRecoveryExhausted,
  runChatRecoveryExhaustion,
  type ChatRecoveryAdapter,
  type ChatFiberWakeHooks,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryScheduleReason,
  type DispatchRecoveredTurnInput,
  type RecoveryPartial,
  type ResolvedRecoveryStream
} from "../recovery-engine";
import { partialHasSettledToolResults } from "../recovery-codec";
import type {
  ChatRecoveryExhaustedContext,
  ChatRecoveryOptions,
  ResolvedChatRecoveryConfig
} from "../lifecycle";
import type { ChatFiberSnapshot } from "../recovery";
import type { FiberRecoveryContext } from "../../index";
import {
  CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS,
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
      },
      exhaustChatRecovery: () => Promise.resolve(),
      resolveRecoveryStream: () => ({ streamId: "", streamStillActive: false }),
      getPartialStreamText: () => ({
        text: "",
        parts: [],
        hasSettledToolResults: false
      }),
      activeChatRecoveryRootRequestId: () => undefined,
      onGiveUpBookkeepingError: () => {}
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
      onShouldKeepRecoveringError: () => {},
      exhaustChatRecovery: () => Promise.resolve(),
      resolveRecoveryStream: () => ({ streamId: "", streamStillActive: false }),
      getPartialStreamText: () => ({
        text: "",
        parts: [],
        hasSettledToolResults: false
      }),
      activeChatRecoveryRootRequestId: () => undefined,
      onGiveUpBookkeepingError: () => {}
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
    delaySeconds: number;
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
      scheduleRecovery: (callback, data, reason, delaySeconds) => {
        order.push("schedule");
        schedules.push({ callback, data, reason, delaySeconds });
        return Promise.resolve();
      },
      setRecovering: (active, requestId) => {
        order.push("setRecovering");
        recovering.push({ active, requestId });
        return Promise.resolve();
      },
      onShouldKeepRecoveringError: () => {},
      exhaustChatRecovery: () => Promise.resolve(),
      resolveRecoveryStream: () => ({ streamId: "", streamStillActive: false }),
      getPartialStreamText: () => ({
        text: "",
        parts: [],
        hasSettledToolResults: false
      }),
      activeChatRecoveryRootRequestId: () => undefined,
      onGiveUpBookkeepingError: () => {}
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
    // The initial triplet always enqueues with delay 0.
    expect(fake.schedules[0]).toMatchObject({
      callback: "_chatRecoveryContinue",
      reason: "initial",
      delaySeconds: 0
    });
  });

  it("forwards an explicit reason and the per-callback payload verbatim (delay 0)", async () => {
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
      reason: "stable_timeout_retry",
      delaySeconds: 0
    });
  });
});

/**
 * Layer-2 seam test for `ChatRecoveryEngine.rescheduleAfterStableTimeout` (slice
 * 4c) — the byte-identical stable-state-timeout reschedule both packages ran via
 * a direct `storage.put` + non-idempotent delayed `schedule`. Pins: the attempt
 * bump + `scheduled`/`stable_timeout_retry` persist, the delayed
 * `stable_timeout_retry` (non-idempotent) enqueue, and the two short-circuits
 * (no incident, budget spent) that route the caller to the give-up path. Unlike
 * the `scheduled` transition this does NOT emit or touch the recovering flag.
 */
describe("ChatRecoveryEngine.rescheduleAfterStableTimeout (fake adapter)", () => {
  type ScheduleCall = {
    callback: ChatRecoveryScheduleCallback;
    data: Record<string, unknown>;
    reason: ChatRecoveryScheduleReason;
    delaySeconds: number;
  };

  function makeFakeAdapter() {
    const storage = new Map<string, ChatRecoveryIncident>();
    const events: ChatRecoveryIncidentEvent[] = [];
    const recovering: Array<{ active: boolean; requestId?: string }> = [];
    const schedules: ScheduleCall[] = [];

    const adapter: ChatRecoveryAdapter = {
      resolveConfig: () => resolveChatRecoveryConfig(undefined),
      now: () => 9_999,
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
      scheduleRecovery: (callback, data, reason, delaySeconds) => {
        schedules.push({ callback, data, reason, delaySeconds });
        return Promise.resolve();
      },
      setRecovering: (active, requestId) => {
        recovering.push({ active, requestId });
        return Promise.resolve();
      },
      onShouldKeepRecoveringError: () => {},
      exhaustChatRecovery: () => Promise.resolve(),
      resolveRecoveryStream: () => ({ streamId: "", streamStillActive: false }),
      getPartialStreamText: () => ({
        text: "",
        parts: [],
        hasSettledToolResults: false
      }),
      activeChatRecoveryRootRequestId: () => undefined,
      onGiveUpBookkeepingError: () => {}
    };

    return { adapter, storage, events, recovering, schedules };
  }

  function seed(
    storage: Map<string, ChatRecoveryIncident>,
    overrides: Partial<ChatRecoveryIncident> = {}
  ): ChatRecoveryIncident {
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
    storage.set(chatRecoveryIncidentKey(incident.incidentId), incident);
    return incident;
  }

  it("bumps the attempt, persists scheduled/stable_timeout_retry, and enqueues a delayed non-idempotent retry", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const incident = seed(fake.storage, { attempt: 2 });

    const rescheduled = await engine.rescheduleAfterStableTimeout({
      incidentId: incident.incidentId,
      callback: "_chatRecoveryContinue",
      data: { incidentId: incident.incidentId, originalRequestId: "root-1" },
      fallbackMaxAttempts: 6
    });

    expect(rescheduled).toBe(true);
    const stored = fake.storage.get(
      chatRecoveryIncidentKey(incident.incidentId)
    );
    expect(stored).toMatchObject({
      attempt: 3,
      status: "scheduled",
      reason: "stable_timeout_retry",
      lastAttemptAt: 9_999
    });
    // No scheduled event / recovering churn on a same-turn reschedule.
    expect(fake.events).toHaveLength(0);
    expect(fake.recovering).toHaveLength(0);
    // Delayed + non-idempotent (survives the executing one-shot row deletion).
    expect(fake.schedules).toHaveLength(1);
    expect(fake.schedules[0]).toMatchObject({
      callback: "_chatRecoveryContinue",
      reason: "stable_timeout_retry",
      delaySeconds: CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS
    });
    expect(
      chatRecoverySchedulePolicy(fake.schedules[0].reason).idempotent
    ).toBe(false);
  });

  it("returns false (caller gives up) when the incident id is missing", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    const rescheduled = await engine.rescheduleAfterStableTimeout({
      incidentId: undefined,
      callback: "_chatRecoveryContinue",
      data: {},
      fallbackMaxAttempts: 6
    });

    expect(rescheduled).toBe(false);
    expect(fake.schedules).toHaveLength(0);
  });

  it("returns false when no incident record exists", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    const rescheduled = await engine.rescheduleAfterStableTimeout({
      incidentId: "gone:incident",
      callback: "_chatRecoveryRetry",
      data: {},
      fallbackMaxAttempts: 6
    });

    expect(rescheduled).toBe(false);
    expect(fake.schedules).toHaveLength(0);
  });

  it("returns false without scheduling when the attempt budget is spent", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const incident = seed(fake.storage, { attempt: 6, maxAttempts: 6 });

    const rescheduled = await engine.rescheduleAfterStableTimeout({
      incidentId: incident.incidentId,
      callback: "_chatRecoveryContinue",
      data: {},
      fallbackMaxAttempts: 6
    });

    expect(rescheduled).toBe(false);
    expect(fake.schedules).toHaveLength(0);
    // Incident left untouched (no attempt bump on a budget-spent give-up).
    expect(
      fake.storage.get(chatRecoveryIncidentKey(incident.incidentId))?.attempt
    ).toBe(6);
  });

  it("falls back to fallbackMaxAttempts when the incident omits maxAttempts", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    // maxAttempts cast away to model a legacy record without the field.
    const incident = seed(fake.storage, { attempt: 3 });
    delete (incident as { maxAttempts?: number }).maxAttempts;
    fake.storage.set(chatRecoveryIncidentKey(incident.incidentId), incident);

    const rescheduled = await engine.rescheduleAfterStableTimeout({
      incidentId: incident.incidentId,
      callback: "_chatRecoveryContinue",
      data: {},
      fallbackMaxAttempts: 3
    });

    // attempt (3) >= fallback (3) → give up.
    expect(rescheduled).toBe(false);
    expect(fake.schedules).toHaveLength(0);
  });
});

/**
 * Layer-2 seam test for `ChatRecoveryEngine.recordOomAndDecide` (#1825) — the
 * tight OOM-retry budget both packages call when a recovery callback observes a
 * Durable Object memory-limit reset. Pins: the durable `oomAttempts` bump, the
 * under-budget delayed non-idempotent reschedule (same machinery as the
 * stable-timeout reschedule), the over-budget "exhausted" verdict (caller
 * terminalizes), and the untrackable short-circuits (no id / record gone).
 */
describe("ChatRecoveryEngine.recordOomAndDecide (fake adapter)", () => {
  type ScheduleCall = {
    callback: ChatRecoveryScheduleCallback;
    data: Record<string, unknown>;
    reason: ChatRecoveryScheduleReason;
    delaySeconds: number;
  };

  function makeFakeAdapter() {
    const storage = new Map<string, ChatRecoveryIncident>();
    const events: ChatRecoveryIncidentEvent[] = [];
    const recovering: Array<{ active: boolean; requestId?: string }> = [];
    const schedules: ScheduleCall[] = [];

    const adapter: ChatRecoveryAdapter = {
      resolveConfig: () => resolveChatRecoveryConfig(undefined),
      now: () => 4_242,
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
      scheduleRecovery: (callback, data, reason, delaySeconds) => {
        schedules.push({ callback, data, reason, delaySeconds });
        return Promise.resolve();
      },
      setRecovering: (active, requestId) => {
        recovering.push({ active, requestId });
        return Promise.resolve();
      },
      onShouldKeepRecoveringError: () => {},
      exhaustChatRecovery: () => Promise.resolve(),
      resolveRecoveryStream: () => ({ streamId: "", streamStillActive: false }),
      getPartialStreamText: () => ({
        text: "",
        parts: [],
        hasSettledToolResults: false
      }),
      activeChatRecoveryRootRequestId: () => undefined,
      onGiveUpBookkeepingError: () => {}
    };

    return { adapter, storage, events, recovering, schedules };
  }

  function seed(
    storage: Map<string, ChatRecoveryIncident>,
    overrides: Partial<ChatRecoveryIncident> = {}
  ): ChatRecoveryIncident {
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
    storage.set(chatRecoveryIncidentKey(incident.incidentId), incident);
    return incident;
  }

  it("bumps oomAttempts and reschedules a delayed non-idempotent retry while under budget", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const incident = seed(fake.storage); // oomAttempts undefined → first OOM

    const decision = await engine.recordOomAndDecide({
      incidentId: incident.incidentId,
      callback: "_chatRecoveryContinue",
      data: { incidentId: incident.incidentId },
      maxOomRetries: 3
    });

    expect(decision).toBe("rescheduled");
    const stored = fake.storage.get(
      chatRecoveryIncidentKey(incident.incidentId)
    );
    expect(stored).toMatchObject({
      oomAttempts: 1,
      status: "scheduled",
      reason: "oom_retry",
      lastAttemptAt: 4_242
    });
    // The attempt cap is deliberately NOT bumped — OOM has its own budget.
    expect(stored?.attempt).toBe(1);
    expect(fake.schedules).toHaveLength(1);
    expect(fake.schedules[0]).toMatchObject({
      callback: "_chatRecoveryContinue",
      reason: "stable_timeout_retry",
      delaySeconds: CHAT_RECOVERY_STABLE_RETRY_DELAY_SECONDS
    });
    expect(
      chatRecoverySchedulePolicy(fake.schedules[0].reason).idempotent
    ).toBe(false);
  });

  it("returns exhausted (caller terminalizes) once the bump crosses the budget", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    // Already at the budget: this OOM (→ 4) is one past maxOomRetries = 3.
    const incident = seed(fake.storage, { oomAttempts: 3 });

    const decision = await engine.recordOomAndDecide({
      incidentId: incident.incidentId,
      callback: "_chatRecoveryContinue",
      data: {},
      maxOomRetries: 3
    });

    expect(decision).toBe("exhausted");
    // The crossed count is persisted so the begin-path backstop agrees, but NO
    // reschedule is enqueued (the caller routes to the give-up path).
    expect(
      fake.storage.get(chatRecoveryIncidentKey(incident.incidentId))
        ?.oomAttempts
    ).toBe(4);
    expect(fake.schedules).toHaveLength(0);
  });

  it("seals on the first OOM when maxOomRetries is 0", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const incident = seed(fake.storage);

    const decision = await engine.recordOomAndDecide({
      incidentId: incident.incidentId,
      callback: "_chatRecoveryContinue",
      data: {},
      maxOomRetries: 0
    });

    expect(decision).toBe("exhausted");
    expect(fake.schedules).toHaveLength(0);
  });

  it("returns exhausted without scheduling when the incident id is missing", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    const decision = await engine.recordOomAndDecide({
      incidentId: undefined,
      callback: "_chatRecoveryContinue",
      data: {},
      maxOomRetries: 3
    });

    expect(decision).toBe("exhausted");
    expect(fake.schedules).toHaveLength(0);
  });

  it("returns exhausted when no incident record exists", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    const decision = await engine.recordOomAndDecide({
      incidentId: "gone:incident",
      callback: "_chatRecoveryRetry",
      data: {},
      maxOomRetries: 3
    });

    expect(decision).toBe("exhausted");
    expect(fake.schedules).toHaveLength(0);
  });
});

/**
 * Layer-2 seam test for `ChatRecoveryEngine.exhaustRecoveryGiveUp` (slice 4d-1)
 * — the give-up spine both packages ran verbatim to terminalize a turn whose
 * retry budget drained (#1645). Pins the sequence + its invariants: best-effort
 * read (tolerated failure → synthesize), the `exhausted` re-entry guard, the
 * synthesized-incident root-id chain, terminalize-BEFORE-seal (so a transient in
 * the terminal write re-runs the WHOLE give-up instead of half-sealing #1730),
 * and the tolerated best-effort seal. The only package divergences (`reason`,
 * the `recoveredRequestId` link in the root chain) are caller parameters here.
 */
describe("ChatRecoveryEngine.exhaustRecoveryGiveUp (fake adapter)", () => {
  type ExhaustCall = {
    incident: ChatRecoveryIncident;
    config: ResolvedChatRecoveryConfig;
    partial: RecoveryPartial;
    streamId: string;
    createdAt: number;
  };

  type GiveUpOptions = {
    getThrows?: boolean;
    putThrows?: boolean;
    streamId?: string;
    partial?: RecoveryPartial;
    activeRoot?: string;
  };

  function makeFakeAdapter(options: GiveUpOptions = {}) {
    const storage = new Map<string, ChatRecoveryIncident>();
    const exhausts: ExhaustCall[] = [];
    const bookkeeping: Array<{ phase: "read" | "seal"; error: unknown }> = [];
    const order: string[] = [];
    const streamIdArgs: string[] = [];
    const partialArgs: string[] = [];

    const adapter: ChatRecoveryAdapter = {
      resolveConfig: () => resolveChatRecoveryConfig(undefined),
      now: () => 7_777,
      sweepStaleIncidents: () => Promise.resolve(),
      getIncident: (key) => {
        if (options.getThrows) return Promise.reject(new Error("read boom"));
        return Promise.resolve(storage.get(key) ?? null);
      },
      readProgress: () => Promise.resolve(0),
      isAwaitingClientInteraction: () => false,
      putIncident: (key, incident) => {
        if (options.putThrows) return Promise.reject(new Error("seal boom"));
        order.push("seal");
        storage.set(key, incident);
        return Promise.resolve();
      },
      deleteIncident: (key) => {
        storage.delete(key);
        return Promise.resolve();
      },
      emitRecoveryEvent: () => {},
      scheduleRecovery: () => Promise.resolve(),
      setRecovering: () => Promise.resolve(),
      onShouldKeepRecoveringError: () => {},
      exhaustChatRecovery: (incident, config, partial, streamId, createdAt) => {
        order.push("exhaust");
        exhausts.push({ incident, config, partial, streamId, createdAt });
        return Promise.resolve();
      },
      resolveRecoveryStream: (requestId) => {
        streamIdArgs.push(requestId);
        return { streamId: options.streamId ?? "", streamStillActive: false };
      },
      getPartialStreamText: (streamId) => {
        partialArgs.push(streamId);
        return (
          options.partial ?? {
            text: "",
            parts: [],
            hasSettledToolResults: false
          }
        );
      },
      activeChatRecoveryRootRequestId: () => options.activeRoot,
      onGiveUpBookkeepingError: (phase, error) => {
        bookkeeping.push({ phase, error });
      }
    };

    return {
      adapter,
      storage,
      exhausts,
      bookkeeping,
      order,
      streamIdArgs,
      partialArgs
    };
  }

  function seed(
    storage: Map<string, ChatRecoveryIncident>,
    overrides: Partial<ChatRecoveryIncident> = {}
  ): { incidentId: string; key: string } {
    const incident: ChatRecoveryIncident = {
      incidentId: "root-1:user-1",
      requestId: "req-1",
      recoveryRootRequestId: "root-1",
      recoveryKind: "continue",
      attempt: 6,
      maxAttempts: 6,
      status: "attempting",
      firstSeenAt: 1_000,
      lastAttemptAt: 2_000,
      ...overrides
    };
    const key = chatRecoveryIncidentKey(incident.incidentId);
    storage.set(key, incident);
    return { incidentId: incident.incidentId, key };
  }

  it("terminalizes a stored incident BEFORE sealing it, threading the reason", async () => {
    const fake = makeFakeAdapter({
      streamId: "stream-1",
      partial: { text: "hi", parts: [], hasSettledToolResults: false }
    });
    const engine = new ChatRecoveryEngine(fake.adapter);
    const { incidentId, key } = seed(fake.storage);

    await engine.exhaustRecoveryGiveUp({
      callback: "_chatRecoveryContinue",
      data: { incidentId, originalRequestId: "root-1" },
      reason: "recovery_error"
    });

    // Terminalize before seal: a transient terminal write must re-run the whole
    // give-up rather than be no-op'd by an already-armed re-entry guard (#1730).
    expect(fake.order).toEqual(["exhaust", "seal"]);
    expect(fake.exhausts).toHaveLength(1);
    const call = fake.exhausts[0];
    expect(call.incident).toMatchObject({
      incidentId,
      status: "exhausted",
      reason: "recovery_error"
    });
    // createdAt is the (preserved) firstSeenAt of the stored incident.
    expect(call.createdAt).toBe(1_000);
    expect(call.streamId).toBe("stream-1");
    expect(call.partial).toEqual({
      text: "hi",
      parts: [],
      hasSettledToolResults: false
    });
    // Stream id resolved from the recovery ROOT; partial read for that stream.
    expect(fake.streamIdArgs).toEqual(["root-1"]);
    expect(fake.partialArgs).toEqual(["stream-1"]);
    // The sealed record is persisted as exhausted (arms the re-entry guard).
    expect(fake.storage.get(key)).toMatchObject({
      status: "exhausted",
      reason: "recovery_error"
    });
  });

  it("re-entry guard: an already-exhausted record terminalizes nothing", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);
    const { incidentId } = seed(fake.storage, { status: "exhausted" });

    await engine.exhaustRecoveryGiveUp({
      callback: "_chatRecoveryContinue",
      data: { incidentId },
      reason: "stable_timeout"
    });

    expect(fake.exhausts).toHaveLength(0);
    expect(fake.order).toHaveLength(0);
  });

  it("tolerates a failed incident read and synthesizes (still terminalizes)", async () => {
    const fake = makeFakeAdapter({ getThrows: true });
    const engine = new ChatRecoveryEngine(fake.adapter);

    await engine.exhaustRecoveryGiveUp({
      callback: "_chatRecoveryRetry",
      data: { incidentId: "lost:incident", originalRequestId: "root-9" },
      reason: "stable_timeout"
    });

    expect(fake.bookkeeping).toEqual([
      { phase: "read", error: expect.any(Error) }
    ]);
    expect(fake.exhausts).toHaveLength(1);
    const cfg = resolveChatRecoveryConfig(undefined);
    expect(fake.exhausts[0].incident).toMatchObject({
      incidentId: "lost:incident",
      requestId: "root-9",
      recoveryRootRequestId: "root-9",
      recoveryKind: "retry",
      attempt: cfg.maxAttempts,
      maxAttempts: cfg.maxAttempts,
      status: "exhausted",
      reason: "stable_timeout"
    });
  });

  it("tolerates a failed seal write AFTER terminalizing", async () => {
    const fake = makeFakeAdapter({ putThrows: true });
    const engine = new ChatRecoveryEngine(fake.adapter);
    const { incidentId } = seed(fake.storage);

    await expect(
      engine.exhaustRecoveryGiveUp({
        callback: "_chatRecoveryContinue",
        data: { incidentId },
        reason: "stable_timeout"
      })
    ).resolves.toBeUndefined();

    // Terminalization happened; only the best-effort seal failed.
    expect(fake.exhausts).toHaveLength(1);
    expect(fake.bookkeeping).toEqual([
      { phase: "seal", error: expect.any(Error) }
    ]);
  });

  it("root-id chain: recoveredRequestId beats activeRoot when no originalRequestId", async () => {
    const fake = makeFakeAdapter({ activeRoot: "active-root", streamId: "s" });
    const engine = new ChatRecoveryEngine(fake.adapter);

    await engine.exhaustRecoveryGiveUp({
      callback: "_chatRecoveryContinue",
      data: { incidentId: "i:1", recoveredRequestId: "recovered-root" },
      reason: "stable_timeout"
    });

    expect(fake.exhausts[0].incident).toMatchObject({
      requestId: "recovered-root",
      recoveryRootRequestId: "recovered-root"
    });
    expect(fake.streamIdArgs).toEqual(["recovered-root"]);
  });

  it("root-id chain: falls back to the active recovery root when the payload omits both", async () => {
    const fake = makeFakeAdapter({ activeRoot: "active-root" });
    const engine = new ChatRecoveryEngine(fake.adapter);

    await engine.exhaustRecoveryGiveUp({
      callback: "_chatRecoveryContinue",
      data: { incidentId: "i:1" },
      reason: "stable_timeout"
    });

    expect(fake.exhausts[0].incident.recoveryRootRequestId).toBe("active-root");
  });

  it("synthesizes a uuid incident and never reads/seals when the payload has no incidentId", async () => {
    const fake = makeFakeAdapter();
    const engine = new ChatRecoveryEngine(fake.adapter);

    await engine.exhaustRecoveryGiveUp({
      callback: "_chatRecoveryRetry",
      data: undefined,
      reason: "stable_timeout"
    });

    expect(fake.exhausts).toHaveLength(1);
    expect(fake.exhausts[0].incident.incidentId.length).toBeGreaterThan(0);
    expect(fake.exhausts[0].incident.recoveryKind).toBe("retry");
    // No incident key → no read, no seal, nothing persisted.
    expect(fake.bookkeeping).toHaveLength(0);
    expect(fake.storage.size).toBe(0);
    expect(fake.order).toEqual(["exhaust"]);
  });

  it("skips the partial read when no orphaned stream survives", async () => {
    const fake = makeFakeAdapter({ streamId: "" });
    const engine = new ChatRecoveryEngine(fake.adapter);

    await engine.exhaustRecoveryGiveUp({
      callback: "_chatRecoveryContinue",
      data: { incidentId: "i:1", originalRequestId: "r" },
      reason: "stable_timeout"
    });

    expect(fake.partialArgs).toHaveLength(0);
    expect(fake.exhausts[0].streamId).toBe("");
    expect(fake.exhausts[0].partial).toEqual({
      text: "",
      parts: [],
      hasSettledToolResults: false
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

describe("runChatRecoveryExhaustion", () => {
  const config = resolveChatRecoveryConfig(undefined);

  function makeIncident(
    overrides: Partial<ChatRecoveryIncident> = {}
  ): ChatRecoveryIncident {
    return {
      incidentId: "inc-1",
      requestId: "req-1",
      recoveryRootRequestId: "root-1",
      recoveryKind: "continue",
      attempt: 5,
      maxAttempts: 5,
      status: "exhausted",
      firstSeenAt: 1_000,
      lastAttemptAt: 2_000,
      reason: "max_attempts_exceeded",
      ...overrides
    };
  }

  it("runs notify (emit -> onExhausted) before terminalize, passing the built context to both", async () => {
    const order: string[] = [];
    let emittedCtx: ChatRecoveryExhaustedContext | undefined;
    let terminalizedCtx: ChatRecoveryExhaustedContext | undefined;

    await runChatRecoveryExhaustion(
      {
        incident: makeIncident(),
        config,
        partialText: "partial reply",
        partialParts: [],
        streamId: "stream-9",
        createdAt: 1_500
      },
      {
        emit: (c) => {
          order.push("emit");
          emittedCtx = c;
        },
        onExhausted: () => {
          order.push("onExhausted");
        },
        onError: () => order.push("onError"),
        terminalize: (c) => {
          order.push("terminalize");
          terminalizedCtx = c;
        }
      }
    );

    // The notification fully completes before the host terminalizes.
    expect(order).toEqual(["emit", "onExhausted", "terminalize"]);
    // Both sides see the SAME built context (so terminalize never rebuilds it).
    expect(terminalizedCtx).toBe(emittedCtx);
    expect(terminalizedCtx).toMatchObject({
      requestId: "req-1",
      recoveryRootRequestId: "root-1",
      partialText: "partial reply",
      streamId: "stream-9",
      createdAt: 1_500,
      terminalMessage: config.terminalMessage
    });
  });

  it("still terminalizes when onExhausted throws (a bad hook never blocks terminal UX)", async () => {
    const order: string[] = [];
    const thrown = new Error("hook boom");
    let reported: unknown;

    await expect(
      runChatRecoveryExhaustion(
        {
          incident: makeIncident(),
          config,
          partialText: "",
          partialParts: [],
          streamId: "",
          createdAt: 0
        },
        {
          emit: () => order.push("emit"),
          onExhausted: () => {
            order.push("onExhausted");
            throw thrown;
          },
          onError: (error) => {
            order.push("onError");
            reported = error;
          },
          terminalize: () => {
            order.push("terminalize");
          }
        }
      )
    ).resolves.toBeUndefined();

    expect(order).toEqual(["emit", "onExhausted", "onError", "terminalize"]);
    expect(reported).toBe(thrown);
  });

  it("propagates a throwing terminalize (so the give-up re-runs on a healthy isolate, #1730)", async () => {
    const order: string[] = [];
    const thrown = new Error("storage transient");

    await expect(
      runChatRecoveryExhaustion(
        {
          incident: makeIncident(),
          config,
          partialText: "",
          partialParts: [],
          streamId: "",
          createdAt: 0
        },
        {
          emit: () => order.push("emit"),
          onError: () => order.push("onError"),
          terminalize: () => {
            order.push("terminalize");
            return Promise.reject(thrown);
          }
        }
      )
    ).rejects.toBe(thrown);

    // The notification still fired before the failing terminalize.
    expect(order).toEqual(["emit", "terminalize"]);
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

/**
 * Shared settled-tool-results predicate (slice 4d-2). Both packages' private
 * copies were byte-equivalent; this pins the lifted single source of truth that
 * the engine's persist gate now consults.
 */
describe("partialHasSettledToolResults", () => {
  it("is true for a tool part carrying output/result", () => {
    expect(
      partialHasSettledToolResults([
        { type: "tool-foo", output: { ok: true } } as never
      ])
    ).toBe(true);
    expect(
      partialHasSettledToolResults([
        { type: "dynamic-tool", result: 1 } as never
      ])
    ).toBe(true);
  });

  it("is true for a tool part in a terminal output-* state", () => {
    for (const state of ["output-available", "output-error", "output-denied"]) {
      expect(
        partialHasSettledToolResults([{ type: "tool-foo", state } as never])
      ).toBe(true);
    }
  });

  it("is false for non-tool parts and unsettled tool parts", () => {
    expect(
      partialHasSettledToolResults([{ type: "text", text: "hi" } as never])
    ).toBe(false);
    expect(
      partialHasSettledToolResults([
        { type: "tool-foo", state: "input-available" } as never
      ])
    ).toBe(false);
    expect(partialHasSettledToolResults([])).toBe(false);
  });
});

/**
 * Layer-2 seam test for the wake-recovery lifecycle (slice 4d-2). The engine owns
 * the FRAME (non-chat dispatch → chat gate → unwrap → stream/partial → classify →
 * begin-incident → exhausted-branch → onChatRecovery → persist → complete →
 * dispatch → catch→failed) and the shared persist clause; the {@link
 * ChatFiberWakeHooks} own the divergent organs. These tests pin the ordering, the
 * shared `base && (persist !== false || settled)` gate, the exhausted
 * short-circuit, and the failed-on-throw guard — the exact contract `AIChatAgent`
 * and `Think` now delegate.
 */
describe("ChatRecoveryEngine.handleChatFiberRecovery (fake adapter + wake hooks)", () => {
  type TestDetail = { tag: string };

  type HarnessOptions = {
    name?: string;
    /** When set, the adapter's non-chat hook consumes the fiber first. */
    nonChatHandled?: boolean;
    snapshot?: ChatFiberSnapshot | null;
    stream?: ResolvedRecoveryStream;
    partial?: RecoveryPartial;
    recoveryKind?: "retry" | "continue";
    detail?: TestDetail;
    onChatRecovery?: ChatRecoveryOptions | void;
    basePersist?: boolean;
    dispatchThrows?: boolean;
    seedExhausted?: boolean;
    /**
     * Drop the engine-defaulted optional hooks (`isAwaitingClientInteraction`,
     * `onShouldKeepRecoveringError`, `invokeOnChatRecovery`) so a MINIMAL adapter
     * is exercised — proving the engine supplies the documented defaults
     * (`false` / no-op / `{}`) rather than crashing on the missing functions.
     */
    omitOptionalHooks?: boolean;
  };

  const NOW = 10_000_000;

  function makeHarness(options: HarnessOptions = {}) {
    const calls: string[] = [];
    const storage = new Map<string, ChatRecoveryIncident>();
    const events: ChatRecoveryIncidentEvent[] = [];
    const dispatched: DispatchRecoveredTurnInput<TestDetail>[] = [];
    const persisted: string[] = [];
    const completed: string[] = [];
    const exhausted: Array<{ streamId: string; createdAt: number }> = [];
    const config = resolveChatRecoveryConfig(undefined);

    const partial: RecoveryPartial = options.partial ?? {
      text: "",
      parts: [],
      hasSettledToolResults: false
    };
    const stream: ResolvedRecoveryStream = options.stream ?? {
      streamId: "s1",
      streamStillActive: true
    };

    const adapter: ChatRecoveryAdapter = {
      resolveConfig: () => config,
      now: () => NOW,
      ...(options.nonChatHandled
        ? {
            tryHandleNonChatFiberRecovery: () => {
              calls.push("nonChat");
              return Promise.resolve(true);
            }
          }
        : {}),
      sweepStaleIncidents: () => {
        calls.push("sweep");
        return Promise.resolve();
      },
      getIncident: (key) => {
        calls.push("get");
        return Promise.resolve(storage.get(key) ?? null);
      },
      readProgress: () => Promise.resolve(0),
      isAwaitingClientInteraction: () => false,
      putIncident: (key, incident) => {
        calls.push("put");
        storage.set(key, incident);
        return Promise.resolve();
      },
      deleteIncident: (key) => {
        storage.delete(key);
        return Promise.resolve();
      },
      emitRecoveryEvent: (event) => events.push(event),
      scheduleRecovery: () => Promise.resolve(),
      setRecovering: () => Promise.resolve(),
      onShouldKeepRecoveringError: () => {},
      exhaustChatRecovery: (
        _incident,
        _config,
        _partial,
        streamId,
        createdAt
      ) => {
        calls.push("exhaust");
        exhausted.push({ streamId, createdAt });
        return Promise.resolve();
      },
      resolveRecoveryStream: () => {
        calls.push("resolveStream");
        return stream;
      },
      getPartialStreamText: (streamId) => {
        calls.push(`getPartial:${streamId}`);
        return partial;
      },
      activeChatRecoveryRootRequestId: () => undefined,
      onGiveUpBookkeepingError: () => {}
    };

    const wake: ChatFiberWakeHooks<TestDetail> = {
      chatFiberPrefix: () => "chat:",
      unwrapRecoverySnapshot: () => {
        calls.push("unwrap");
        return { snapshot: options.snapshot ?? null, recoveryData: null };
      },
      classifyRecoveredTurn: () => {
        calls.push("classify");
        return {
          recoveryKind: options.recoveryKind ?? "continue",
          detail: options.detail ?? { tag: "d" }
        };
      },
      invokeOnChatRecovery: () => {
        calls.push("invokeOnChatRecovery");
        return Promise.resolve(options.onChatRecovery);
      },
      shouldPersistOrphanedPartial: () => {
        calls.push("shouldPersist");
        return options.basePersist ?? true;
      },
      persistOrphanedStream: (streamId) => {
        calls.push("persist");
        persisted.push(streamId);
        return Promise.resolve();
      },
      completeRecoveredStream: (streamId) => {
        calls.push("complete");
        completed.push(streamId);
      },
      dispatchRecoveredTurn: (dispatchInput) => {
        calls.push("dispatch");
        dispatched.push(dispatchInput);
        if (options.dispatchThrows) {
          return Promise.reject(new Error("dispatch boom"));
        }
        return Promise.resolve();
      }
    };

    if (options.omitOptionalHooks) {
      // Shrink to a minimal adapter: the engine must treat these as
      // `false` (awaiting), a swallowed no-op (shouldKeepRecovering error),
      // and empty options (`{}`) respectively.
      delete adapter.isAwaitingClientInteraction;
      delete adapter.onShouldKeepRecoveringError;
      delete wake.invokeOnChatRecovery;
    }

    if (options.seedExhausted) {
      // Seed an at-cap, long-stale incident so `beginIncident` evaluates as
      // exhausted (both the no-progress and attempt-cap bounds trip at NOW).
      const incidentId = chatRecoveryIncidentId({
        requestId: "req-1",
        recoveryRootRequestId:
          options.snapshot?.recoveryRootRequestId ?? "req-1",
        latestUserMessageId: options.snapshot?.latestUserMessageId ?? null,
        recoveryKind: options.recoveryKind ?? "continue"
      });
      storage.set(chatRecoveryIncidentKey(incidentId), {
        incidentId,
        requestId: "req-1",
        recoveryRootRequestId: "req-1",
        recoveryKind: options.recoveryKind ?? "continue",
        attempt: config.maxAttempts,
        maxAttempts: config.maxAttempts,
        status: "attempting",
        firstSeenAt: 0,
        lastAttemptAt: 0,
        lastProgressAt: 0,
        progress: 0
      });
    }

    const ctx: FiberRecoveryContext = {
      id: "fiber-1",
      name: options.name ?? "chat:req-1",
      snapshot: null,
      createdAt: 4242,
      recoveryReason: "interrupted"
    };

    return {
      engine: new ChatRecoveryEngine(adapter),
      ctx,
      wake,
      calls,
      events,
      dispatched,
      persisted,
      completed,
      exhausted,
      config
    };
  }

  it("dispatches a non-chat fiber first and skips chat processing", async () => {
    const h = makeHarness({ nonChatHandled: true });

    expect(await h.engine.handleChatFiberRecovery(h.ctx, h.wake)).toBe(true);
    // The non-chat hook ran; the chat path never did.
    expect(h.calls).toContain("nonChat");
    expect(h.calls).not.toContain("classify");
    expect(h.calls).not.toContain("dispatch");
  });

  it("returns false (not a chat fiber) when the name lacks the prefix", async () => {
    const h = makeHarness({ name: "think:messenger-reply" });
    expect(await h.engine.handleChatFiberRecovery(h.ctx, h.wake)).toBe(false);
    expect(h.calls).not.toContain("classify");
    expect(h.calls).not.toContain("put");
  });

  it("drives the wake lifecycle in order and threads the classification detail", async () => {
    const detail: TestDetail = { tag: "carry-me" };
    const h = makeHarness({ recoveryKind: "retry", detail });

    expect(await h.engine.handleChatFiberRecovery(h.ctx, h.wake)).toBe(true);

    const order = (label: string) => h.calls.indexOf(label);
    // unwrap → resolveStream → getPartial → classify → begin(put) →
    // onChatRecovery → shouldPersist → complete → dispatch.
    expect(order("unwrap")).toBeLessThan(order("resolveStream"));
    expect(order("resolveStream")).toBeLessThan(order("classify"));
    expect(order("classify")).toBeLessThan(order("put"));
    expect(order("put")).toBeLessThan(order("invokeOnChatRecovery"));
    expect(order("invokeOnChatRecovery")).toBeLessThan(order("shouldPersist"));
    expect(order("shouldPersist")).toBeLessThan(order("complete"));
    expect(order("complete")).toBeLessThan(order("dispatch"));

    // Dispatch receives the classify detail + the reported kind verbatim.
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0].detail).toBe(detail);
    expect(h.dispatched[0].recoveryKind).toBe("retry");
    expect(h.dispatched[0].requestId).toBe("req-1");
  });

  it("persists with the default clause (persist undefined) when the base gate is open", async () => {
    const h = makeHarness({ basePersist: true, onChatRecovery: {} });
    await h.engine.handleChatFiberRecovery(h.ctx, h.wake);
    expect(h.persisted).toEqual(["s1"]);
  });

  it("does NOT persist a settle-free partial the hook discarded (persist:false)", async () => {
    const h = makeHarness({
      basePersist: true,
      onChatRecovery: { persist: false },
      partial: {
        text: "hi",
        parts: [{ type: "text", text: "hi" }],
        hasSettledToolResults: false
      }
    });
    await h.engine.handleChatFiberRecovery(h.ctx, h.wake);
    expect(h.persisted).toEqual([]);
  });

  it("ALWAYS persists settled tool results even when the hook returns persist:false (#1631)", async () => {
    const h = makeHarness({
      basePersist: true,
      onChatRecovery: { persist: false },
      // The codec — not the engine — decides settledness; the engine consumes
      // only the precomputed boolean (so the seam stays vocabulary-agnostic).
      partial: {
        text: "",
        parts: [{ type: "tool-foo", state: "output-available" }],
        hasSettledToolResults: true
      }
    });
    await h.engine.handleChatFiberRecovery(h.ctx, h.wake);
    expect(h.persisted).toEqual(["s1"]);
  });

  it("never persists when the base gate is closed, even with settled work", async () => {
    const h = makeHarness({
      basePersist: false,
      onChatRecovery: {},
      partial: {
        text: "",
        parts: [{ type: "tool-foo", state: "output-available" }],
        hasSettledToolResults: true
      }
    });
    await h.engine.handleChatFiberRecovery(h.ctx, h.wake);
    expect(h.persisted).toEqual([]);
  });

  it("completes the stream only while it is still active", async () => {
    const h = makeHarness({
      stream: { streamId: "s1", streamStillActive: false }
    });
    await h.engine.handleChatFiberRecovery(h.ctx, h.wake);
    expect(h.completed).toEqual([]);
    // Dispatch still runs (the decision owns the not-active case).
    expect(h.calls).toContain("dispatch");
  });

  it("terminalizes the exhausted budget BEFORE onChatRecovery and skips dispatch", async () => {
    const h = makeHarness({ seedExhausted: true });

    expect(await h.engine.handleChatFiberRecovery(h.ctx, h.wake)).toBe(true);

    // Exhausted path: persist gate (no options) + exhaustChatRecovery, with the
    // fiber's createdAt; never consults onChatRecovery or dispatch.
    expect(h.calls).toContain("exhaust");
    expect(h.exhausted[0]?.createdAt).toBe(4242);
    expect(h.calls).not.toContain("invokeOnChatRecovery");
    expect(h.calls).not.toContain("dispatch");
  });

  it("flips the incident to failed and rethrows when dispatch throws", async () => {
    const h = makeHarness({ dispatchThrows: true });

    await expect(
      h.engine.handleChatFiberRecovery(h.ctx, h.wake)
    ).rejects.toThrow("dispatch boom");

    // The incident was sealed `failed` (not left leaking in `attempting`).
    const sealed = [...h.events]
      .reverse()
      .find((e) => e.type === "chat:recovery:failed");
    expect(sealed?.reason).toBe("dispatch boom");
  });

  it("drives a MINIMAL adapter (omitted optional hooks) via engine defaults", async () => {
    // A host with no client-interaction / shouldKeepRecovering-diagnostic /
    // user-onChatRecovery surface (e.g. the pi fixture) omits these hooks. The
    // engine must default them rather than throw on the missing functions
    // (T2-3b). The run completing + dispatching is the proof.
    const h = makeHarness({ omitOptionalHooks: true });

    expect(await h.engine.handleChatFiberRecovery(h.ctx, h.wake)).toBe(true);

    // `invokeOnChatRecovery` was omitted, so it is never called and the engine
    // proceeds with empty options (`{}`) — which still flow through to dispatch.
    expect(h.calls).not.toContain("invokeOnChatRecovery");
    expect(h.calls).toContain("dispatch");
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0].options).toEqual({});
  });

  it("minimal adapter still terminalizes an exhausted budget without onChatRecovery", async () => {
    // The default for `isAwaitingClientInteraction` is `false`, so an at-cap
    // incident still evaluates as exhausted and terminalizes — exercising the
    // `?? false` default on the give-up-adjacent path.
    const h = makeHarness({ omitOptionalHooks: true, seedExhausted: true });

    expect(await h.engine.handleChatFiberRecovery(h.ctx, h.wake)).toBe(true);
    expect(h.calls).toContain("exhaust");
    expect(h.calls).not.toContain("dispatch");
  });
});
