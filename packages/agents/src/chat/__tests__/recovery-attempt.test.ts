import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_RECOVERY_CANCELLED_REASON,
  CHAT_RECOVERY_CONTINUED_REASON,
  ChatRecoveryEngine,
  type ChatRecoveryAdapter,
  type ChatRecoveryAttemptScope,
  type ChatRecoveryTurnBindings
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
  /** The settle removed the reply: it held nothing. */
  settleRemovesReply?: boolean;
  /** What the retry's leaf check returns. */
  retryLeaf?: RecoveryLeafCheck;
  /** The latest stored message. Defaults to an assistant reply. */
  latestMessage?: { id: string; role: string };
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
  const terminalErrors: Array<{ requestId: string; errorText: string }> = [];
  const events: string[] = [];
  const scheduled: string[] = [];
  const exhausted: string[] = [];
  // The context each turn was handed.
  const pinned: unknown[] = [];
  let controller: AbortController | undefined;
  // The host's turn machinery, as its adapter binds it.
  const turns: ChatRecoveryTurnBindings = {
    label: "[test]",
    beginRecoveryAttempt: () => {
      log.push("begin");
      controller = new AbortController();
      return {
        signal: controller.signal,
        end: () => {
          log.push("end");
        }
      };
    },
    waitUntilStable: async () => {
      log.push("wait");
      await scenario.duringWait?.(harness);
      return scenario.ready ?? true;
    },
    reconcileAgentToolChildRuns: async () => {
      log.push("reconcile");
    },
    trackAlarmWork: () => {},
    attemptScope: new AsyncLocalStorage<ChatRecoveryAttemptScope>(),
    latestMessage: () =>
      scenario.latestMessage ?? { id: "assistant-1", role: "assistant" },
    originMessageIdsScope: new AsyncLocalStorage<string[] | undefined>(),
    recordTerminalError: async (requestId, errorText) => {
      terminalErrors.push({ requestId, errorText });
    },
    attempts: {
      _chatRecoveryContinue: async () => {},
      _chatRecoveryRetry: async () => {}
    }
  };
  const adapter: ChatRecoveryAdapter = {
    resolveConfig: () => resolveChatRecoveryConfig(undefined),
    now: () => 1_000,
    sweepStaleIncidents: () => Promise.resolve(),
    getIncident: (k) => Promise.resolve(storage.get(k) ?? null),
    listActiveIncidents: () => Promise.resolve([...storage.values()]),
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
    emitRecoveryEvent: (event) => {
      events.push(event.type);
    },
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
    isAwaitingClientInteraction: () => scenario.pendingInteraction ?? false,
    turns,
    onGiveUpBookkeepingError: () => {}
  };
  const engine = new ChatRecoveryEngine(adapter);
  const harness: Harness = {
    engine,
    stop: () => controller?.abort(),
    log
  };
  const turnSignals: AbortSignal[] = [];
  const host: RecoveredTurnHost<RecoveryAttemptData, RecoveredTurnResult> = {
    callback: "_chatRecoveryContinue",
    data: {
      incidentId: INCIDENT,
      originalRequestId: ROOT,
      lastBody: { model: "m" },
      lastClientTools: null
    },
    checkLeaf: async () => {
      log.push("leaf");
      return scenario.leaf ?? { moved: false };
    },
    runTurn: async (signal, context) => {
      log.push("turn");
      pinned.push(context);
      turnSignals.push(signal);
      await scenario.duringTurn?.(harness);
      return scenario.result ?? { status: "completed" };
    },
    onStopped: async () => {
      log.push("stopped");
    },
    onClientContinued: async () => {
      log.push("client-continued");
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
          settleCutOffReply: async (removal) => {
            log.push("settle");
            if (removal.removedEarlier === true) return "removed";
            if (!scenario.settleRemovesReply) return undefined;
            await removal.beforeRemove();
            return "removed";
          },
          retryLostReply: {
            checkLeaf: async () => {
              log.push("retry-leaf");
              return scenario.retryLeaf ?? { moved: false };
            },
            runTurn: async (signal) => {
              log.push("retry-turn");
              turnSignals.push(signal);
              return scenario.result ?? { status: "completed" };
            }
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
    turns,
    activeRoot: () => engine.activeRootRequestId,
    pinned,
    events,
    run: () => engine.runRecoveredTurn(host),
    // The same payload delivered again, as a deferral or a Task retry does.
    rerun: () => engine.runRecoveredTurn(host)
  };
}

const cancelled = {
  status: "skipped",
  reason: CHAT_RECOVERY_CANCELLED_REASON
} as const;

describe("runRecoveryCallback", () => {
  it("runs the callback's attempt inside the origin-message-ids scope", async () => {
    const t = setup();
    let scoped: string[] | undefined;
    let outside: string[] | undefined;
    t.turns.attempts._chatRecoveryRetry = async (data, onTurnStarted) => {
      scoped = t.turns.originMessageIdsScope.getStore();
      expect(data).toMatchObject({ incidentId: INCIDENT });
      onTurnStarted();
    };
    await t.engine.runRecoveryCallback("_chatRecoveryRetry", {
      incidentId: INCIDENT,
      originMessageIds: ["user-1"]
    });
    outside = t.turns.originMessageIdsScope.getStore();

    expect(scoped).toEqual(["user-1"]);
    // A request outside the callback never inherits the ids.
    expect(outside).toBeUndefined();
  });
});

describe("runRecoveredTurn, a reply the settle removed", () => {
  it("retries the question and does not go on to continue", async () => {
    const t = setup({ withSettle: true, settleRemovesReply: true });
    await t.run();

    expect(t.log).toContain("retry-leaf");
    expect(t.log).toContain("retry-turn");
    expect(t.log).not.toContain("leaf");
    expect(t.log).not.toContain("turn");
    expect(t.log).toContain("after-outcome");
  });

  it("skips when the question is no longer the latest message", async () => {
    const t = setup({
      withSettle: true,
      settleRemovesReply: true,
      retryLeaf: { moved: true, reason: "no_unanswered_user_message" }
    });
    await t.run();

    expect(t.log).not.toContain("retry-turn");
    expect(t.log).not.toContain("turn");
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: "no_unanswered_user_message"
    });
  });

  it("records the removal on the incident, so a second delivery of the payload retries too", async () => {
    // The first run removes the reply, and its retry turn is cut off.
    const first = setup({
      withSettle: true,
      settleRemovesReply: true,
      result: { status: "error", error: "Network connection lost." }
    });
    await first.run();
    expect(first.incident()).toMatchObject({ replyRemoved: true });

    // The same continue payload again. The reply is gone, so this run's
    // settle removes nothing. The incident still says to retry.
    const second = setup({
      withSettle: true,
      incident: { replyRemoved: true }
    });
    await second.run();

    expect(second.log).toContain("retry-turn");
    expect(second.log).not.toContain("turn");
  });

  it("continues as before when the reply was kept", async () => {
    const t = setup({ withSettle: true });
    await t.run();

    expect(t.log).toContain("turn");
    expect(t.log).not.toContain("retry-turn");
  });
});

describe("runRecoveredTurn", () => {
  it("runs the steps in order and records a completed turn", async () => {
    const t = setup({ withSettle: true });
    await t.run();

    expect(t.log).toEqual([
      "begin",
      "settle",
      "wait",
      "leaf",
      "turn",
      "before-outcome",
      "after-outcome",
      "end",
      "reconcile",
      "release"
    ]);
    // A completed incident is dropped.
    expect(t.incident()).toBeUndefined();
    expect(t.activeRoot()).toBeUndefined();
  });

  it("hands the turn the interrupted request's tools and body, and writes nothing", async () => {
    const t = setup();
    await t.run();
    // `null` in the payload means the request had none: the key is pinned
    // as "none", not left for the stored one.
    expect(t.pinned).toEqual([{ body: { model: "m" }, clientTools: null }]);
  });

  it("pins nothing when the payload names neither, so the turn reads the stored ones", async () => {
    const t = setup();
    t.host.data = { incidentId: INCIDENT, originalRequestId: ROOT };
    await t.run();
    expect(t.pinned).toEqual([{}]);
  });

  it("the attempt's turn runs under the attempt's root request id", async () => {
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

  it("a turn another request runs while the attempt waits is not the attempt's", async () => {
    // The other turn's code runs in its own async chain. Here it is started
    // before the attempt and observed while the attempt waits.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seenByOtherTurn: string | undefined = "unset";
    let t: ReturnType<typeof setup> | undefined;
    const otherTurn = (async () => {
      await gate;
      seenByOtherTurn = t?.activeRoot();
    })();
    let seenByAttempt: string | undefined;
    t = setup({
      duringWait: async () => {
        seenByAttempt = t?.activeRoot();
        release?.();
        await otherTurn;
      }
    });
    await t.run();

    expect(seenByAttempt).toBe(ROOT);
    expect(seenByOtherTurn).toBeUndefined();
  });

  it("a turn body set up inside the attempt runs under its root, wherever the fiber runs it", async () => {
    let body: (() => Promise<string | undefined>) | undefined;
    const t = setup({
      // Set up in the attempt, as the host's fiber wrapper is.
      duringTurn: ({ engine }) => {
        body = engine.turnBody(false, async () => engine.activeRootRequestId);
      }
    });
    await t.run();
    // Run later, outside the attempt's async chain, as a Task runner might.
    expect(await body?.()).toBe(ROOT);
    expect(t.activeRoot()).toBeUndefined();
  });

  it("does nothing for an incident cancelled while it was scheduled", async () => {
    const t = setup({ incident: cancelled });
    await t.run();
    expect(t.log).toEqual(["stopped", "reconcile", "release"]);
    expect(t.incident()).toMatchObject(cancelled);
  });

  it("skips an attempt the host does not admit, before registering it", async () => {
    const t = setup();
    t.host.admit = async () => false;
    await t.run();
    expect(t.log).toEqual(["reconcile", "release"]);
  });

  it("releases what the host admitted when the attempt cannot start", async () => {
    const t = setup();
    t.host.admit = async () => true;
    t.turns.beginRecoveryAttempt = () => {
      throw new Error("cannot register");
    };
    await expect(t.run()).rejects.toThrow("cannot register");
    expect(t.log).toEqual(["reconcile", "release"]);
  });

  it("ends without a turn when a client's answer continued the reply during the wait", async () => {
    const t = setup({
      duringWait: async ({ engine }) => {
        await engine.supersedeScheduledRecovery();
      }
    });
    await t.run();
    expect(t.log).not.toContain("turn");
    expect(t.log).toContain("client-continued");
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: CHAT_RECOVERY_CONTINUED_REASON
    });
  });

  it("does not give up when its turn throws after another turn continued the reply", async () => {
    let other: (() => Promise<void>) | undefined;
    const t = setup({
      duringTurn: async () => {
        await other?.();
        // A turn that throws on its aborted signal.
        throw new Error("aborted");
      }
    });
    other = t.engine.turnBody(true, async (takeReply) => {
      await takeReply();
    });
    await expect(t.run()).resolves.toBeUndefined();

    expect(t.exhausted).toEqual([]);
    expect(t.log).toContain("client-continued");
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: CHAT_RECOVERY_CONTINUED_REASON
    });
  });

  it("the attempt's own continuation turn does not supersede its incident", async () => {
    let superseded: boolean | undefined;
    const t = setup({
      // What the host's fiber wrapper does for every continuation turn: it
      // wraps the body where the fiber is set up and runs it inside.
      duringTurn: async ({ engine }) => {
        const body = engine.turnBody(true, async (takeReply) => {
          await takeReply();
          return engine.isRecoverySuperseded(INCIDENT);
        });
        superseded = await body();
      }
    });
    await t.run();
    expect(superseded).toBe(false);
    expect(t.turnSignals[0]?.aborted).toBe(false);
    // The attempt recorded its own outcome: a completed incident is dropped.
    expect(t.incident()).toBeUndefined();
  });

  it("a continuation turn that is not the attempt's supersedes the scheduled incident", async () => {
    const t = setup();
    const body = t.engine.turnBody(true, async (takeReply) => {
      await takeReply();
      return t.engine.isRecoverySuperseded(INCIDENT);
    });
    expect(await body()).toBe(true);
  });

  it("a continuation turn that never commits to the model leaves the recovery scheduled", async () => {
    const t = setup();
    // The body ends without calling `takeReply`: it called no model.
    await t.engine.turnBody(true, async () => {})();
    expect(t.incident()).toMatchObject({ status: "scheduled" });
  });

  it("a turn that starts a new reply supersedes nothing", async () => {
    const t = setup();
    await t.engine.turnBody(false, async (takeReply) => {
      await takeReply();
    })();
    expect(t.incident()).toMatchObject({ status: "scheduled" });
  });

  it("a continuation turn does not supersede a scheduled retry", async () => {
    const t = setup({
      incident: {
        recoveryKind: "retry",
        scheduled: { callback: "_chatRecoveryRetry" }
      }
    });
    expect(await t.engine.supersedeScheduledRecovery()).toBe(false);
    expect(t.incident()).toMatchObject({ status: "scheduled" });
  });

  it("a continuation turn does not supersede a retry scheduled on a continue incident", async () => {
    // A lost partial opens a `continue` incident and schedules a retry.
    const t = setup({
      incident: {
        recoveryKind: "continue",
        scheduled: { callback: "_chatRecoveryRetry" }
      }
    });
    expect(await t.engine.supersedeScheduledRecovery()).toBe(false);
  });

  it("a continuation turn does not supersede a recovery that continues another reply", async () => {
    const t = setup({
      incident: {
        scheduled: {
          callback: "_chatRecoveryContinue",
          targetMessageId: "assistant-older"
        }
      },
      latestMessage: { id: "assistant-newer", role: "assistant" }
    });
    expect(await t.engine.supersedeScheduledRecovery()).toBe(false);
    expect(t.incident()).toMatchObject({ status: "scheduled" });
  });

  it("a continuation turn supersedes the recovery that continues the same reply", async () => {
    const t = setup({
      incident: {
        scheduled: {
          callback: "_chatRecoveryContinue",
          targetMessageId: "assistant-1"
        }
      }
    });
    expect(await t.engine.supersedeScheduledRecovery()).toBe(true);
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: CHAT_RECOVERY_CONTINUED_REASON
    });
  });

  it("supersedes nothing when the latest message is not a reply", async () => {
    const t = setup({ latestMessage: { id: "user-2", role: "user" } });
    expect(await t.engine.supersedeScheduledRecovery()).toBe(false);
  });

  it("stands down when another turn continues the reply while its own turn is queued", async () => {
    // Set up outside the attempt, as an app's `continueLastTurn()` would be.
    let other: (() => Promise<void>) | undefined;
    const t = setup({
      result: { status: "aborted" },
      // The attempt is past its checks. The other turn reaches the front of
      // the queue first and runs.
      duringTurn: async () => {
        await other?.();
      }
    });
    other = t.engine.turnBody(true, async (takeReply) => {
      await takeReply();
    });
    await t.run();

    // The attempt's turn was told to stop, and the incident says why.
    expect(t.turnSignals[0]?.aborted).toBe(true);
    expect(t.log).toContain("client-continued");
    expect(t.log).not.toContain("before-outcome");
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: CHAT_RECOVERY_CONTINUED_REASON
    });
  });

  it("a client's answer that continued the reply wins over a timeout that would reschedule", async () => {
    const t = setup({
      ready: false,
      duringWait: async ({ engine }) => {
        await engine.supersedeScheduledRecovery();
      }
    });
    await t.run();
    expect(t.scheduled).toEqual([]);
    expect(t.exhausted).toEqual([]);
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: CHAT_RECOVERY_CONTINUED_REASON
    });
  });

  it("a stop wins over a client's answer that continued the reply", async () => {
    const t = setup({
      duringWait: async ({ engine, stop }) => {
        await engine.supersedeScheduledRecovery();
        stop();
      }
    });
    await t.run();
    expect(t.incident()).toMatchObject(cancelled);
  });

  it("records a turn stopped by its own request id as stopped, not failed", async () => {
    // The attempt's own signal never fired: the stop reached the turn only.
    const t = setup({ result: { status: "aborted" } });
    await t.run();
    expect(t.incident()).toMatchObject(cancelled);
    expect(t.log).toContain("after-outcome");
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
      "reconcile",
      "release"
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
    expect(t.log).not.toContain("client-continued");
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
    expect(t.log).toContain("client-continued");
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

  // What `routeStreamInterruption` does when a turn is cut off again and
  // schedules the next attempt.
  const scheduleNext = (engine: ChatRecoveryEngine) =>
    engine.scheduleRecovery({
      incident: { incidentId: INCIDENT } as ChatRecoveryIncident,
      recoveryKind: "continue",
      callback: "_chatRecoveryContinue",
      data: { incidentId: INCIDENT },
      reason: "chained_retry"
    });

  it("leaves the incident to the attempt an interrupted turn scheduled", async () => {
    const t = setup({
      result: { status: "aborted" },
      duringTurn: ({ engine }) => scheduleNext(engine)
    });
    await t.run();
    expect(t.incident()).toMatchObject({ status: "scheduled" });
    expect(t.log).not.toContain("before-outcome");
  });

  it("an earlier interruption's schedule does not swallow this attempt's outcome", async () => {
    const t = setup({ result: { status: "error", error: "boom" } });
    // The turn that was cut off first scheduled this attempt.
    await scheduleNext(t.engine);
    await t.run();
    expect(t.incident()).toMatchObject({ status: "failed", reason: "boom" });
  });

  it("records a completed turn even when it scheduled another attempt", async () => {
    const t = setup({
      duringTurn: ({ engine }) => scheduleNext(engine)
    });
    await t.run();
    expect(t.incident()).toBeUndefined();
  });

  it("keeps the outcome of a turn the app declined to continue, with one event", async () => {
    const t = setup({
      result: { status: "error", error: "stream broke" },
      // routeStreamInterruption, `continue: false`
      duringTurn: ({ engine }) =>
        engine.updateIncident(INCIDENT, "skipped", "continue_disabled")
    });
    await t.run();
    expect(t.incident()).toMatchObject({
      status: "skipped",
      reason: "continue_disabled"
    });
    expect(t.events).toEqual(["chat:recovery:skipped"]);
    expect(t.log).toContain("after-outcome");
  });

  it("a stop by the incident's current request id during the wait stops the attempt", async () => {
    // A chained attempt: the incident's request id is the recovered turn the
    // client last saw cut off. The attempt is registered under the root.
    const t = setup({
      incident: { requestId: "request-cut-off" },
      duringWait: async ({ engine }) => {
        expect(await engine.cancelScheduledRecovery("request-cut-off")).toBe(
          true
        );
      }
    });
    await t.run();
    expect(t.log).not.toContain("turn");
    expect(t.log).toContain("stopped");
    expect(t.incident()).toMatchObject(cancelled);
  });

  it("a stop by the recovered turn's own request id reaches the attempt", async () => {
    const t = setup({
      // The turn throws a platform transient after it was stopped. Without
      // the stop reaching the attempt, it would be deferred and run again.
      duringTurn: async ({ engine }) => {
        // The host's fiber wrapper registers the turn's request id.
        engine.turnBody(true, async () => {}, "request-recovered-turn");
        expect(
          await engine.cancelScheduledRecovery("request-recovered-turn")
        ).toBe(true);
        throw new Error("Network connection lost.");
      }
    });
    await expect(t.run()).resolves.toBeUndefined();
    expect(t.turnSignals[0]?.aborted).toBe(true);
    expect(t.incident()).toMatchObject(cancelled);
  });

  it("a request id that names no incident cancels nothing", async () => {
    const t = setup({
      duringWait: async ({ engine }) => {
        expect(await engine.cancelScheduledRecovery("some-other-request")).toBe(
          false
        );
      }
    });
    await t.run();
    expect(t.log).toContain("turn");
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
    expect(t.log.slice(-3)).toEqual(["end", "reconcile", "release"]);
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
    expect(t.log.slice(-3)).toEqual(["end", "reconcile", "release"]);
  });

  it("records the stop and resolves when a stopped attempt hits a platform transient", async () => {
    const t = setup({
      duringWait: ({ stop }) => {
        stop();
        throw new Error("Network connection lost.");
      }
    });
    const statuses: string[] = [];
    const update = t.engine.updateIncident.bind(t.engine);
    t.engine.updateIncident = (incidentId, status, reason) => {
      statuses.push(status);
      return update(incidentId, status, reason);
    };
    // No rerun is needed: a rerun would return at the cancelled check.
    await expect(t.run()).resolves.toBeUndefined();
    expect(statuses).toEqual(["skipped"]);
    expect(t.incident()).toMatchObject(cancelled);
  });

  it("defers on a platform transient and keeps the incident live", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup({
      duringTurn: () => {
        throw new Error("Network connection lost.");
      }
    });
    await expect(t.run()).rejects.toThrow("Network connection lost.");
    error.mockRestore();

    expect(t.exhausted).toEqual([]);
    // Not an outcome: no event, and the status a stop or a continuation
    // looks for.
    expect(t.events).toEqual([]);
    expect(t.incident()).toMatchObject({
      status: "scheduled",
      deferredError: "Network connection lost."
    });
    expect(t.log.slice(-3)).toEqual(["end", "reconcile", "release"]);

    // The same payload runs again a few seconds later. A stop in between:
    expect(await t.engine.cancelScheduledRecovery(ROOT)).toBe(true);
    t.log.length = 0;
    await t.rerun();
    expect(t.log).toEqual(["stopped", "reconcile", "release"]);
  });

  it("a turn that continued the reply during a deferral supersedes the rerun", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup({
      duringTurn: () => {
        throw new Error("Network connection lost.");
      }
    });
    await expect(t.run()).rejects.toThrow("Network connection lost.");
    error.mockRestore();

    expect(await t.engine.supersedeScheduledRecovery()).toBe(true);
    t.log.length = 0;
    await t.rerun();
    expect(t.log).not.toContain("turn");
    expect(t.log).toContain("client-continued");
  });

  it("reconciles agent-tool child runs for an attempt cancelled before it started", async () => {
    const t = setup({ incident: cancelled });
    await t.run();
    expect(t.log).toEqual(["stopped", "reconcile", "release"]);
  });

  it("a reconcile that throws does not replace the transient the attempt threw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup({
      duringTurn: () => {
        throw new Error("Network connection lost.");
      }
    });
    t.turns.reconcileAgentToolChildRuns = async () => {
      throw new Error("storage is down");
    };
    await expect(t.run()).rejects.toThrow("Network connection lost.");
    error.mockRestore();
  });

  it("runs outsideAttempt code outside the attempt's scope and the origin ids scope", async () => {
    let inside: string | undefined;
    let outside: string | undefined = "unset";
    let idsOutside: string[] | undefined = ["unset"];
    const t = setup({
      duringTurn: ({ engine }) => {
        inside = engine.activeRootRequestId;
        t.turns.originMessageIdsScope.run(["user-1"], () => {
          engine.outsideAttempt(() => {
            outside = engine.activeRootRequestId;
            idsOutside = t.turns.originMessageIdsScope.getStore();
          });
        });
      }
    });
    await t.run();
    expect(inside).toBe(ROOT);
    expect(outside).toBeUndefined();
    expect(idsOutside).toBeUndefined();
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

describe("a recovery callback delivered more than once", () => {
  // The host's turn: its body runs through `engine.turnBody`, inside the
  // turn's fiber, as `_runChatRecoveryFiber` does in both classes.
  const turnThroughFiber =
    (during?: () => void | Promise<void>) =>
    async ({ engine }: Harness) => {
      await engine.turnBody(true, async () => during?.(), "turn-request")();
    };

  it("records on the incident that the turn of its schedule started", async () => {
    let duringTurn: unknown;
    const t = setup({
      incident: { scheduleCount: 2 },
      duringTurn: turnThroughFiber(() => {
        duringTurn = t.incident()?.startedDelivery;
      })
    });
    t.host.data = { ...t.host.data, delivery: 2 };

    await t.run();

    expect(duringTurn).toBe(2);
    expect(t.log).toContain("turn");
  });

  it("does not run the turn again after a reset cut it off: the interrupted turn's recovery owns it", async () => {
    // The first delivery's turn started, then the isolate was reset. The
    // incident still reads `scheduled`, with the started mark.
    const t = setup({ incident: { scheduleCount: 2, startedDelivery: 2 } });
    t.host.data = { ...t.host.data, delivery: 2 };

    await t.run();

    expect(t.log).not.toContain("turn");
    expect(t.log).not.toContain("begin");
    // Nothing is recorded: the incident is the wake's to move on.
    expect(t.incident()).toMatchObject({ status: "scheduled" });
    expect(t.events).toEqual([]);
    // What the callback holds is still released.
    expect(t.log).toContain("reconcile");
  });

  it("does not run an older schedule's payload once a newer attempt is scheduled", async () => {
    const t = setup({ incident: { scheduleCount: 3 } });
    t.host.data = { ...t.host.data, delivery: 2 };

    await t.run();

    expect(t.log).not.toContain("turn");
    expect(t.incident()).toMatchObject({ status: "scheduled" });
  });

  it("runs a payload an older version scheduled, which has no schedule number", async () => {
    const t = setup({ incident: { scheduleCount: 2, startedDelivery: 2 } });

    await t.run();

    expect(t.log).toContain("turn");
  });

  it("runs the same payload again after a deferral, which ends the turn without a reset", async () => {
    let failing = true;
    const t = setup({
      incident: { scheduleCount: 1 },
      duringTurn: turnThroughFiber(() => {
        if (failing) throw new Error("Network connection lost.");
      })
    });
    t.host.data = { ...t.host.data, delivery: 1 };

    await expect(t.run()).rejects.toThrow("Network connection lost.");
    expect(t.incident()?.startedDelivery).toBeUndefined();

    failing = false;
    await t.rerun();
    expect(t.incident()).toBeUndefined();
    expect(t.log.filter((entry) => entry === "turn")).toHaveLength(2);
  });

  it("hands each schedule its number in the callback's payload", async () => {
    const t = setup({ incident: { scheduleCount: 4 } });
    const payloads: unknown[] = [];
    const adapter = (
      t.engine as unknown as {
        adapter: { scheduleRecovery: (...args: unknown[]) => Promise<void> };
      }
    ).adapter;
    adapter.scheduleRecovery = (_callback, data) => {
      payloads.push(data);
      return Promise.resolve();
    };

    await t.engine.scheduleRecovery({
      incident: t.incident()!,
      recoveryKind: "continue",
      callback: "_chatRecoveryContinue",
      data: { incidentId: INCIDENT }
    });

    expect(payloads).toEqual([{ incidentId: INCIDENT, delivery: 5 }]);
    expect(t.incident()?.scheduleCount).toBe(5);
  });
});

describe("what an attempt records, and in what order", () => {
  it("records a turn the host skipped as skipped, not failed", async () => {
    const t = setup({ result: { status: "skipped" } });
    await t.run();
    expect(t.incident()).toMatchObject({ status: "skipped" });
    expect(t.events).not.toContain("chat:recovery:failed");
  });

  // Each of these writes the incident before it runs the host's hook. If
  // the isolate dies between the two, the callback is delivered again and
  // reads the incident. With the hook first, it would read `scheduled` and
  // run the turn the user stopped, or continue a reply a second time.
  const statusWhen = (
    t: ReturnType<typeof setup>,
    hook: "onStopped" | "onClientContinued" | "onSkipped"
  ) => {
    const seen: Array<string | undefined> = [];
    t.host[hook] = async () => {
      seen.push(t.incident()?.status);
    };
    return seen;
  };

  it("records a stop before the host is told", async () => {
    const t = setup({ duringWait: ({ stop }) => stop() });
    const seen = statusWhen(t, "onStopped");
    await t.run();
    expect(seen).toEqual(["skipped"]);
    expect(t.incident()).toMatchObject({ reason: "user_cancelled" });
  });

  it("records that a client still has to answer before the host is told", async () => {
    const t = setup({ ready: false, pendingInteraction: true });
    const seen = statusWhen(t, "onClientContinued");
    await t.run();
    expect(seen).toEqual(["skipped"]);
    expect(t.incident()).toMatchObject({
      reason: "awaiting_client_interaction"
    });
  });

  it("records that the conversation moved on before the host is told", async () => {
    const t = setup({ leaf: { moved: true, reason: "conversation_changed" } });
    const seen = statusWhen(t, "onSkipped");
    await t.run();
    expect(seen).toEqual(["skipped"]);
  });

  it("marks a superseded incident before it tells the attempt running here", async () => {
    // The mark is what a callback delivered again after a reset reads. The
    // signal only reaches an attempt in this isolate.
    const t = setup();
    const attempt = t.engine.beginAttempt(INCIDENT);
    let seen: string | undefined;
    attempt.superseded.addEventListener("abort", () => {
      seen = t.incident()?.status;
    });

    await t.engine.supersedeScheduledRecovery();

    expect(attempt.superseded.aborted).toBe(true);
    expect(seen).toBe("skipped");
    attempt.end();
  });

  it("records a stop on the incident before it stops the attempt running here", async () => {
    const t = setup();
    const attempt = t.engine.beginAttempt(INCIDENT);
    let seen: string | undefined;
    attempt.stopped.addEventListener("abort", () => {
      seen = t.incident()?.status;
    });

    await t.engine.cancelScheduledRecovery(ROOT);

    expect(attempt.stopped.aborted).toBe(true);
    expect(seen).toBe("skipped");
    attempt.end();
  });
});
