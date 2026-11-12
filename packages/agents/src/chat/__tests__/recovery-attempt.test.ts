import { describe, expect, it, vi } from "vitest";
import {
  CHAT_RECOVERY_CANCELLED_REASON,
  ChatRecoveryEngine,
  type ChatRecoveryAdapter
} from "../recovery-engine";
import type {
  RecoveredTurnHost,
  RecoveredTurnResult,
  RecoveryAttemptData,
  RecoveryLeafCheck
} from "../recovery-attempt";
import {
  chatRecoveryIncidentKey,
  resolveChatRecoveryConfig,
  type ChatRecoveryIncident
} from "../recovery-incident";

/**
 * `runRecoveredTurn` is the body both hosts run for a recovery attempt. These
 * tests pin the order of its checks. Each one is a rule of the `ChatRecovery`
 * model (`.claude/skills/verify-chat`), and each test is the path that breaks
 * when the check moves.
 */

const INCIDENT = "incident-1";
const ROOT = "request-1";

type Scenario = {
  incident?: Partial<ChatRecoveryIncident> | null;
  /** What `waitUntilStable` resolves. */
  ready?: boolean;
  pendingInteraction?: boolean;
  leaf?: RecoveryLeafCheck;
  result?: RecoveredTurnResult;
  /** Runs while the attempt waits for a stable chat. */
  duringWait?: (context: Harness) => void | Promise<void>;
  /** Runs while the recovered turn runs. */
  duringTurn?: (context: Harness) => void | Promise<void>;
  withSettle?: boolean;
};

type Harness = {
  engine: ChatRecoveryEngine;
  /** What a client's cancel does to a running attempt. */
  stop: () => void;
  log: string[];
};

function setup(scenario: Scenario = {}) {
  const key = chatRecoveryIncidentKey(INCIDENT);
  const storage = new Map<string, ChatRecoveryIncident>();
  if (scenario.incident !== null) {
    storage.set(key, {
      incidentId: INCIDENT,
      requestId: ROOT,
      recoveryRootRequestId: ROOT,
      recoveryKind: "continue",
      attempt: 1,
      maxAttempts: 3,
      status: "scheduled",
      firstSeenAt: 0,
      lastAttemptAt: 0,
      ...scenario.incident
    });
  }
  const log: string[] = [];
  const scheduled: string[] = [];
  const exhausted: string[] = [];
  const adapter: ChatRecoveryAdapter = {
    resolveConfig: () => resolveChatRecoveryConfig(undefined),
    now: () => 1_000,
    sweepStaleIncidents: () => Promise.resolve(),
    getIncident: (k) => Promise.resolve(storage.get(k) ?? null),
    readProgress: () => Promise.resolve(0),
    putIncident: (k, incident) => {
      storage.set(k, incident);
      return Promise.resolve();
    },
    syncStorage: () => Promise.resolve(),
    deleteIncident: (k) => {
      storage.delete(k);
      return Promise.resolve();
    },
    emitRecoveryEvent: () => {},
    scheduleRecovery: (_callback, _data, reason) => {
      scheduled.push(reason);
      return Promise.resolve();
    },
    setRecovering: () => Promise.resolve(),
    onShouldKeepRecoveringError: () => {},
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
    activeChatRecoveryRootRequestId: () => undefined,
    onGiveUpBookkeepingError: () => {}
  };
  const engine = new ChatRecoveryEngine(adapter);

  let controller: AbortController | undefined;
  let activeRoot: string | undefined;
  const harness: Harness = {
    engine,
    stop: () => controller?.abort(),
    log
  };
  const turnSignals: AbortSignal[] = [];
  const host: RecoveredTurnHost<RecoveryAttemptData, RecoveredTurnResult> = {
    callback: "_chatRecoveryContinue",
    data: { incidentId: INCIDENT, originalRequestId: ROOT },
    logPrefix: "[test]",
    beginAttempt: () => {
      log.push("begin");
      controller = new AbortController();
      return {
        signal: controller.signal,
        end: () => {
          log.push("end");
        }
      };
    },
    getActiveRootRequestId: () => activeRoot,
    setActiveRootRequestId: (rootRequestId) => {
      activeRoot = rootRequestId;
    },
    waitUntilStable: async () => {
      log.push("wait");
      await scenario.duringWait?.(harness);
      return scenario.ready ?? true;
    },
    hasPendingInteraction: () => scenario.pendingInteraction ?? false,
    updateIncident: (...args) => engine.updateIncident(...args),
    checkLeaf: async () => {
      log.push("leaf");
      return scenario.leaf ?? { moved: false };
    },
    applyRequestContext: () => {
      log.push("context");
    },
    runTurn: async (signal) => {
      log.push("turn");
      turnSignals.push(signal);
      await scenario.duringTurn?.(harness);
      return scenario.result ?? { status: "completed" };
    },
    reconcile: async () => {
      log.push("reconcile");
    },
    onStopped: async () => {
      log.push("stopped");
    },
    onParked: async () => {
      log.push("parked");
    },
    onSkipped: async () => {
      log.push("skipped");
    },
    beforeOutcome: async () => {
      log.push("before-outcome");
    },
    afterOutcome: async () => {
      log.push("after-outcome");
    },
    release: () => {
      log.push("release");
    },
    ...(scenario.withSettle
      ? {
          settleCutOffReply: async () => {
            log.push("settle");
          }
        }
      : {})
  };

  return {
    host,
    engine,
    log,
    scheduled,
    exhausted,
    turnSignals,
    incident: () => storage.get(key),
    activeRoot: () => activeRoot,
    run: () => engine.runRecoveredTurn(host)
  };
}

const cancelled = {
  status: "skipped",
  reason: CHAT_RECOVERY_CANCELLED_REASON
} as const;

describe("runRecoveredTurn", () => {
  it("runs the steps in order and records a completed turn", async () => {
    const t = setup({ withSettle: true });
    await t.run();

    expect(t.log).toEqual([
      "begin",
      "settle",
      "wait",
      "leaf",
      "context",
      "turn",
      "before-outcome",
      "after-outcome",
      "end",
      "release",
      "reconcile"
    ]);
    // A completed incident is dropped.
    expect(t.incident()).toBeUndefined();
    expect(t.activeRoot()).toBeUndefined();
  });

  it("sets the root request id for the attempt and restores it after", async () => {
    let during: string | undefined;
    const t = setup({
      duringTurn: () => {
        during = t.activeRoot();
      }
    });
    await t.run();
    expect(during).toBe(ROOT);
    expect(t.activeRoot()).toBeUndefined();
  });

  it("does nothing for an incident cancelled while it was scheduled", async () => {
    const t = setup({ incident: cancelled });
    await t.run();
    expect(t.log).toEqual(["stopped"]);
    expect(t.incident()).toMatchObject(cancelled);
  });

  it("skips an attempt the host does not admit, before registering it", async () => {
    const t = setup();
    t.host.admit = async () => false;
    await t.run();
    expect(t.log).toEqual([]);
  });

  it("a stop during the wait wins over a timeout that would reschedule", async () => {
    const t = setup({ ready: false, duringWait: ({ stop }) => stop() });
    await t.run();

    expect(t.scheduled).toEqual([]);
    expect(t.exhausted).toEqual([]);
    expect(t.incident()).toMatchObject(cancelled);
    expect(t.log).toEqual([
      "begin",
      "wait",
      "stopped",
      "end",
      "release",
      "reconcile"
    ]);
  });

  it("a stop during the wait wins over a timeout that would give up", async () => {
    const t = setup({
      ready: false,
      incident: { attempt: 3 },
      duringWait: ({ stop }) => stop()
    });
    await t.run();
    expect(t.exhausted).toEqual([]);
    expect(t.incident()).toMatchObject(cancelled);
  });

  it("a stop during the wait wins over a park", async () => {
    const t = setup({
      ready: false,
      pendingInteraction: true,
      duringWait: ({ stop }) => stop()
    });
    await t.run();
    expect(t.log).not.toContain("parked");
    expect(t.incident()).toMatchObject(cancelled);
  });

  it("a timeout parks while a client has something to answer", async () => {
    const t = setup({
      ready: false,
      pendingInteraction: true,
      // No budget left: without the park this would give up.
      incident: { attempt: 3 }
    });
    await t.run();

    expect(t.scheduled).toEqual([]);
    expect(t.exhausted).toEqual([]);
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: "awaiting_client_interaction"
    });
    expect(t.log).toContain("parked");
    expect(t.log).not.toContain("turn");
  });

  it("a timeout reschedules while the budget lasts", async () => {
    const t = setup({ ready: false });
    await t.run();
    expect(t.scheduled).toEqual(["stable_timeout_retry"]);
    expect(t.exhausted).toEqual([]);
    expect(t.incident()).toMatchObject({ status: "scheduled", attempt: 2 });
    expect(t.log).not.toContain("turn");
  });

  it("a timeout gives up once the budget is spent", async () => {
    const t = setup({ ready: false, incident: { attempt: 3 } });
    await t.run();
    expect(t.scheduled).toEqual([]);
    expect(t.exhausted).toEqual(["stable_timeout"]);
    expect(t.incident()).toMatchObject({ status: "exhausted" });
  });

  it("skips when the conversation moved", async () => {
    const t = setup({
      leaf: { moved: true, reason: "conversation_changed" }
    });
    await t.run();
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: "conversation_changed"
    });
    expect(t.log).toContain("skipped");
    expect(t.log).not.toContain("turn");
  });

  it("passes the stop signal into the turn", async () => {
    const t = setup({ duringTurn: ({ stop }) => stop() });
    await t.run();
    expect(t.turnSignals[0]?.aborted).toBe(true);
  });

  it("a stop during the turn is the outcome, not the turn's result", async () => {
    const t = setup({
      result: { status: "aborted" },
      duringTurn: ({ stop }) => stop()
    });
    await t.run();
    expect(t.incident()).toMatchObject(cancelled);
    expect(t.log).toContain("stopped");
    expect(t.log).not.toContain("before-outcome");
  });

  it("leaves the incident to the attempt an interrupted turn scheduled", async () => {
    const t = setup({
      result: { status: "aborted" },
      duringTurn: ({ engine }) => engine.markRescheduled(INCIDENT)
    });
    await t.run();
    expect(t.incident()).toMatchObject({ status: "scheduled" });
    expect(t.log).not.toContain("before-outcome");
  });

  it("drops a reschedule mark an earlier interruption left", async () => {
    const t = setup({ result: { status: "error", error: "boom" } });
    // The turn that was cut off first marked the incident and nothing took
    // the mark back.
    t.engine.markRescheduled(INCIDENT);
    await t.run();
    expect(t.incident()).toMatchObject({ status: "failed", reason: "boom" });
  });

  it("records a completed turn even when it marked a reschedule", async () => {
    const t = setup({
      duringTurn: ({ engine }) => engine.markRescheduled(INCIDENT)
    });
    await t.run();
    expect(t.incident()).toBeUndefined();
  });

  it("does not mark failed an incident the turn already gave up on", async () => {
    const t = setup({
      result: { status: "aborted" },
      duringTurn: async ({ engine }) => {
        await engine.exhaustRecoveryGiveUp({
          callback: "_chatRecoveryContinue",
          data: { incidentId: INCIDENT },
          reason: "no_progress_timeout"
        });
      }
    });
    await t.run();
    expect(t.incident()).toMatchObject({
      status: "exhausted",
      reason: "no_progress_timeout"
    });
    // The host still completes its own bookkeeping.
    expect(t.log).toContain("after-outcome");
  });

  it("gives up with recovery_error when the attempt throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup({
      duringTurn: () => {
        throw new Error("application bug");
      }
    });
    await expect(t.run()).resolves.toBeUndefined();
    error.mockRestore();

    expect(t.exhausted).toEqual(["recovery_error"]);
    expect(t.incident()).toMatchObject({ status: "exhausted" });
    expect(t.log.slice(-3)).toEqual(["end", "release", "reconcile"]);
  });

  it("records the stop when a stopped attempt throws", async () => {
    const t = setup({
      duringWait: ({ stop }) => {
        stop();
        throw new Error("application bug");
      }
    });
    await expect(t.run()).resolves.toBeUndefined();
    expect(t.exhausted).toEqual([]);
    expect(t.incident()).toMatchObject(cancelled);
    expect(t.log).toContain("stopped");
  });

  it("rethrows when a stopped attempt that threw cannot record the stop", async () => {
    const t = setup({
      duringWait: ({ stop }) => {
        stop();
        throw new Error("application bug");
      }
    });
    t.host.onStopped = async () => {
      throw new Error("submission write failed");
    };
    await expect(t.run()).rejects.toThrow("submission write failed");
    expect(t.exhausted).toEqual([]);
    expect(t.log.slice(-3)).toEqual(["end", "release", "reconcile"]);
  });

  it("rethrows a platform transient without giving up", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const deferred: string[] = [];
    const t = setup({
      duringTurn: () => {
        throw new Error("Network connection lost.");
      }
    });
    t.host.whileDeferring = async (incidentId, write) => {
      deferred.push(incidentId);
      await write();
    };
    await expect(t.run()).rejects.toThrow("Network connection lost.");
    error.mockRestore();

    expect(t.exhausted).toEqual([]);
    expect(deferred).toEqual([INCIDENT]);
    expect(t.incident()).toMatchObject({ status: "failed" });
    expect(t.log.slice(-3)).toEqual(["end", "release", "reconcile"]);
  });

  it("rethrows a memory-limit reset with no bookkeeping", async () => {
    const t = setup({
      duringTurn: ({ stop }) => {
        stop();
        throw new Error(
          "Durable Object's isolate exceeded its memory limit and was reset."
        );
      }
    });
    await expect(t.run()).rejects.toThrow("memory limit");
    expect(t.incident()).toMatchObject({ status: "scheduled" });
    expect(t.log).not.toContain("stopped");
  });
});
