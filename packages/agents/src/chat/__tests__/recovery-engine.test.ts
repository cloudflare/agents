import { describe, expect, it } from "vitest";
import {
  ChatRecoveryEngine,
  chatRecoverySchedulePolicy,
  type ChatRecoveryAdapter,
  type ChatRecoveryScheduleCallback,
  type ChatRecoveryScheduleReason
} from "../recovery-engine";
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
      emitRecoveryEvent: (event) => {
        calls.push("emit");
        events.push(event);
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

    return { adapter, storage, events, calls, nowCalls: () => nowCalls };
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
