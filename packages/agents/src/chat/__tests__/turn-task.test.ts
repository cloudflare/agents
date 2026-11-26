import { describe, expect, it, vi } from "vitest";
import type { TaskJson, TaskStep } from "../../tasks";
import { unwrapChatFiberSnapshot } from "../recovery";
import { dispatchChatRecoveryToHandoff } from "../recovery-task";
import {
  createChatTurnTaskDefinition,
  currentChatRun,
  currentTurnAttempt,
  runHoldingLane,
  type ChatLaneEntry,
  type ChatTurnClosureEntry
} from "../turn-task";

/** A step that runs `do` at once and keeps the checkpoint as JSON text. */
function fakeStep(local: unknown): {
  step: TaskStep;
  checkpoint: Map<string, string>;
} {
  const checkpoint = new Map<string, string>();
  const step = {
    local,
    createdAt: 1,
    interrupted: null,
    checkpoint: {
      get: (key: string) => {
        const value = checkpoint.get(key);
        return value === undefined ? undefined : JSON.parse(value);
      },
      set: (key: string, value: TaskJson) => {
        checkpoint.set(key, JSON.stringify(value));
      }
    },
    do: async (
      _name: string,
      _config: unknown,
      fn: (attempt: { signal: AbortSignal }) => Promise<unknown>
    ) => fn({ signal: new AbortController().signal }),
    sleep: async () => {}
  } as unknown as TaskStep;
  return { step, checkpoint };
}

const hooks = {
  storage: {} as DurableObjectStorage,
  snapshotKey: "__snapshot",
  keepAliveWhile: <T>(fn: () => Promise<T>) => fn(),
  withStash: <T>(
    context: { stash: (data: unknown) => void },
    fn: () => Promise<T>
  ) => {
    context.stash({ step: 1 });
    return fn();
  },
  recover: async () => {},
  attempts: {
    _chatRecoveryContinue: async () => {},
    _chatRecoveryRetry: async () => {}
  },
  replay: async () => {},
  parkUntil: () => {},
  laneHeldForRecovery: () => false,
  backingOff: () => {},
  holdParksUntil: () => {}
};

describe("createChatTurnTaskDefinition", () => {
  it("runs a lane turn's model call as a run of its own when its snapshot is too large for the row", async () => {
    let began: unknown = "not asked";
    const entry: ChatLaneEntry = {
      lane: true,
      run: (inside) =>
        inside(async () => {
          began = currentChatRun()?.(
            { requestId: "r1", envelope: { big: true }, onStash: () => {} },
            async () => "reply"
          );
        }),
      dropped: () => {}
    };
    const { step, checkpoint } = fakeStep(entry);
    step.checkpoint.set = () => {
      throw new Error("SQLITE_TOOBIG");
    };
    await createChatTurnTaskDefinition(hooks)(
      { requestId: "r1", continuation: false, nonce: "n1", lane: true },
      step
    );
    // Declined: the caller starts the model call's own run.
    expect(began).toBeUndefined();
    expect(checkpoint.size).toBe(0);
  });

  it("recovers a lane turn whose snapshot could not be kept with the app's data alone", async () => {
    const recover = vi.fn(async () => {});
    const { step, checkpoint } = fakeStep(undefined);
    checkpoint.set("snapshot", JSON.stringify({ __cfBeganAt: 5 }));
    checkpoint.set("stash", JSON.stringify({ step: 1 }));
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: { delete: async () => false } as unknown as DurableObjectStorage,
      recover
    })({ requestId: "r1", continuation: false, nonce: "n1", lane: true }, step);
    const { persisted } = (
      recover.mock.calls[0] as unknown as [{ persisted: unknown }]
    )[0];
    expect(persisted).toEqual({ __snapshot: null, user: { step: 1 } });
    expect(unwrapChatFiberSnapshot("__snapshot", persisted)).toEqual({
      snapshot: null,
      user: { step: 1 }
    });
  });

  it("marks a lane turn whose model call ran as a run of its own, and does not replay or recover it", async () => {
    const recover = vi.fn(async () => {});
    const replay = vi.fn(async () => {});
    const entry: ChatLaneEntry = {
      lane: true,
      run: (inside) =>
        inside(async () => {
          currentChatRun()?.(
            { requestId: "r1", envelope: { big: true }, onStash: () => {} },
            async () => "reply"
          );
        }),
      dropped: () => {}
    };
    const { step, checkpoint } = fakeStep(entry);
    const set = step.checkpoint.set;
    let refused = false;
    step.checkpoint.set = (key, value) => {
      // The envelope is too large for the row; the small marker is not.
      if (!refused && key === "snapshot") {
        refused = true;
        throw new Error("SQLITE_TOOBIG");
      }
      set(key, value);
    };
    const input = {
      requestId: "r1",
      continuation: false,
      nonce: "n1",
      lane: true as const,
      admission: {
        messages: [],
        afterUserId: null,
        decision: { strategy: null, overlapping: false, debounceUntilMs: null },
        payload: null
      }
    };
    const definition = createChatTurnTaskDefinition({
      ...hooks,
      storage: { delete: async () => false } as unknown as DurableObjectStorage,
      recover,
      replay
    });
    await definition(input, step);
    expect(JSON.parse(checkpoint.get("snapshot")!)).toMatchObject({
      __cfElsewhere: true
    });
    // The isolate dies; the run replays with no live closure.
    const { step: again, checkpoint: kept } = fakeStep(undefined);
    kept.set("snapshot", checkpoint.get("snapshot")!);
    await definition(input, again);
    expect(replay).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it("ages a recovered lane turn from when its model call began, not from when it was queued", async () => {
    const recover = vi.fn(async () => {});
    const { step, checkpoint } = fakeStep(undefined);
    checkpoint.set(
      "snapshot",
      JSON.stringify({ __snapshot: null, user: null, __cfBeganAt: 500 })
    );
    checkpoint.set("stash", JSON.stringify({ step: 1 }));
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: { delete: async () => false } as unknown as DurableObjectStorage,
      recover
    })({ requestId: "r1", continuation: false, nonce: "n1", lane: true }, step);
    expect(recover).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "r1",
        createdAt: 500,
        persisted: { __snapshot: null, user: { step: 1 } }
      })
    );
  });

  it("runs a live turn whose stash data cannot be kept as JSON, and settles its caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const resolve = vi.fn();
    const reject = vi.fn();
    const entry: ChatTurnClosureEntry = {
      onStash: () => {},
      run: (inside) => inside(async () => "reply"),
      settle: { resolve, reject }
    };
    const { step, checkpoint } = fakeStep(entry);
    await createChatTurnTaskDefinition({
      ...hooks,
      withStash: (context, fn) => {
        context.stash({ count: 1n });
        return fn();
      }
    })({ requestId: "r1", continuation: false, nonce: "n1" }, step);
    expect(resolve).toHaveBeenCalledWith("reply");
    expect(reject).not.toHaveBeenCalled();
    expect(checkpoint.size).toBe(0);
    warn.mockRestore();
  });

  it("keeps the run of a recovery attempt's turn open until the attempt recorded its outcome", async () => {
    const resolve = vi.fn();
    const holds: number[] = [];
    let recorded!: () => void;
    const entry: ChatTurnClosureEntry = {
      onStash: () => {},
      run: (inside) => inside(async () => "reply"),
      settle: { resolve, reject: () => {} },
      hold: () => {
        // Asked only once the caller has the turn's result.
        holds.push(resolve.mock.calls.length);
        return new Promise<void>((done) => {
          recorded = done;
        });
      }
    };
    const { step } = fakeStep(entry);
    let ended = false;
    const run = createChatTurnTaskDefinition(hooks)(
      { requestId: "r1", continuation: true, nonce: "n1" },
      step
    ).then(() => {
      ended = true;
    });
    // The attempt has the turn's result, and the run is still open.
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledWith("reply"));
    await new Promise((turn) => setTimeout(turn, 0));
    expect(ended).toBe(false);

    expect(holds).toEqual([1]);

    recorded();
    await run;
    expect(ended).toBe(true);
  });

  it("keeps only the app's stash data in the checkpoint", async () => {
    const stashed: unknown[] = [];
    const entry: ChatTurnClosureEntry = {
      onStash: (data) => void stashed.push(data),
      run: (inside) => inside(async () => "reply"),
      settle: { resolve: () => {}, reject: () => {} }
    };
    const { step, checkpoint } = fakeStep(entry);
    await createChatTurnTaskDefinition(hooks)(
      {
        requestId: "r1",
        continuation: false,
        nonce: "n1",
        envelope: { __snapshot: { s: 1 }, user: null }
      },
      step
    );
    expect(stashed).toEqual([{ step: 1 }]);
    expect([...checkpoint.keys()]).toEqual(["stash"]);
    expect(JSON.parse(checkpoint.get("stash")!)).toEqual({ step: 1 });
  });

  it("clears the stash data on stash(undefined)", async () => {
    const entry: ChatTurnClosureEntry = {
      onStash: () => {},
      run: (inside) => inside(async () => "reply"),
      settle: { resolve: () => {}, reject: () => {} }
    };
    const { step, checkpoint } = fakeStep(entry);
    await createChatTurnTaskDefinition({
      ...hooks,
      withStash: (context, fn) => {
        context.stash({ step: 1 });
        context.stash(undefined);
        return fn();
      }
    })({ requestId: "r1", continuation: false, nonce: "n1" }, step);
    expect(JSON.parse(checkpoint.get("stash")!)).toBeNull();
  });

  it("hands a replay the input's snapshot with the last stash data", async () => {
    const recovered: unknown[] = [];
    const { step, checkpoint } = fakeStep(undefined);
    checkpoint.set("stash", JSON.stringify({ step: 3 }));
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) => void recovered.push(turn.persisted)
    })(
      {
        requestId: "r1",
        continuation: false,
        nonce: "n1",
        envelope: { __snapshot: { s: 1 }, user: null }
      },
      step
    );
    expect(recovered).toEqual([{ __snapshot: { s: 1 }, user: { step: 3 } }]);
  });

  it("hands a replay whose snapshot could not be kept the app's stash data", async () => {
    const recovered: unknown[] = [];
    const { step, checkpoint } = fakeStep(undefined);
    checkpoint.set("stash", JSON.stringify({ step: 4 }));
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) => void recovered.push(turn.persisted)
    })({ requestId: "r1", continuation: false, nonce: "n1" }, step);
    expect(recovered).toEqual([{ __snapshot: null, user: { step: 4 } }]);
    // Read back, it is the app's data, even when that data looks like an
    // envelope.
    expect(unwrapChatFiberSnapshot("__snapshot", recovered[0])).toEqual({
      snapshot: null,
      user: { step: 4 }
    });
  });

  it("does not read stash data shaped like an envelope as a snapshot", async () => {
    const recovered: unknown[] = [];
    const { step, checkpoint } = fakeStep(undefined);
    const lookalike = {
      __snapshot: {
        version: 1,
        kind: "k",
        requestId: "other",
        continuation: false
      },
      user: "not mine"
    };
    checkpoint.set("stash", JSON.stringify(lookalike));
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) => void recovered.push(turn.persisted)
    })({ requestId: "r1", continuation: false, nonce: "n1" }, step);
    expect(unwrapChatFiberSnapshot("__snapshot", recovered[0])).toEqual({
      snapshot: null,
      user: lookalike
    });
  });

  it("hands a replay of a run from before the input carried it the envelope it checkpointed", async () => {
    const recovered: unknown[] = [];
    const { step, checkpoint } = fakeStep(undefined);
    checkpoint.set(
      "snapshot",
      JSON.stringify({ __snapshot: { s: 0 }, user: { step: 9 } })
    );
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) => void recovered.push(turn.persisted)
    })({ requestId: "r1", nonce: "n1" }, step);
    expect(recovered).toEqual([{ __snapshot: { s: 0 }, user: { step: 9 } }]);
  });

  it("runs a replay's recovery attempt in its own run, after the backoff, from a suspension", async () => {
    const { step } = fakeStep(undefined);
    const steps: string[] = [];
    const stepDo = step.do.bind(step);
    Object.assign(step, {
      do: (name: string, config: unknown, fn: never) => {
        steps.push(name);
        return stepDo(name, config as never, fn);
      },
      sleep: async (name: string, ms: number) => {
        steps.push(`${name}:${ms}`);
      }
    });
    const continued: unknown[] = [];
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) =>
        void turn.attempt({
          callback: "_chatRecoveryContinue",
          data: { incidentId: "i1" },
          delaySeconds: 2
        }),
      attempts: {
        _chatRecoveryContinue: async (data) => void continued.push(data),
        _chatRecoveryRetry: async () => {}
      }
    })({ requestId: "r1", nonce: "n1" }, step);
    expect(steps).toEqual(["model-turn", "backoff:2000", "continuation"]);
    expect(continued).toEqual([{ incidentId: "i1" }]);
    // With no backoff it still suspends, so the attempt runs from the alarm.
    steps.length = 0;
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) =>
        void turn.attempt({
          callback: "_chatRecoveryRetry",
          data: {},
          delaySeconds: 0
        })
    })({ requestId: "r2", nonce: "n2" }, step);
    expect(steps).toEqual(["model-turn", "backoff:1", "continuation"]);
  });

  it("hands back an attempt too large to journal, and runs nothing after the replay", async () => {
    const { step } = fakeStep(undefined);
    const steps: string[] = [];
    const stepDo = step.do.bind(step);
    Object.assign(step, {
      do: (name: string, config: unknown, fn: never) => {
        steps.push(name);
        return stepDo(name, config as never, fn);
      }
    });
    let taken: boolean | undefined;
    await createChatTurnTaskDefinition({
      ...hooks,
      storage: {
        get: async () => undefined,
        delete: async () => true
      } as unknown as DurableObjectStorage,
      recover: async (turn) => {
        taken = turn.attempt({
          callback: "_chatRecoveryContinue",
          data: { lastBody: { text: "x".repeat(1_100_000) } },
          delaySeconds: 0
        });
      }
    })({ requestId: "r3", nonce: "n3" }, step);
    expect(taken).toBe(false);
    expect(steps).toEqual(["model-turn"]);
  });

  it("runs the attempt a live turn planned before its isolate died, without planning again", async () => {
    const { step, checkpoint } = fakeStep(undefined);
    checkpoint.set(
      "attempt",
      JSON.stringify({
        callback: "_chatRecoveryContinue",
        data: { incidentId: "i9" },
        delaySeconds: 0
      })
    );
    const continued: unknown[] = [];
    const recover = vi.fn(async () => {});
    await createChatTurnTaskDefinition({
      ...hooks,
      recover,
      attempts: {
        _chatRecoveryContinue: async (data) => void continued.push(data),
        _chatRecoveryRetry: async () => {}
      }
    })({ requestId: "r9", nonce: "n9" }, step);
    expect(recover).not.toHaveBeenCalled();
    expect(continued).toEqual([{ incidentId: "i9" }]);
  });

  it("runs the attempt of a run started only to run it, without journaling it", async () => {
    const steps: string[] = [];
    const { step } = fakeStep(undefined);
    Object.assign(step, {
      do: async (
        name: string,
        _config: unknown,
        fn: () => Promise<unknown>
      ) => {
        steps.push(name);
        return fn();
      },
      sleep: async (name: string, ms: number) =>
        void steps.push(`${name}:${ms}`)
    });
    const continued: unknown[] = [];
    const recover = vi.fn(async () => {});
    const run = () =>
      createChatTurnTaskDefinition({
        ...hooks,
        recover,
        attempts: {
          _chatRecoveryContinue: async (data) => void continued.push(data),
          _chatRecoveryRetry: async () => {}
        }
      })(
        {
          requestId: "r6",
          nonce: "n6",
          attempt: {
            callback: "_chatRecoveryContinue",
            data: { incidentId: "i6" },
            delaySeconds: 3
          }
        },
        step
      );
    await run();
    // No turn is recovered and no `model-turn` step journals the attempt
    // (it may be too large for one): the run waits out the attempt's own
    // delay, then dispatches it.
    expect(recover).not.toHaveBeenCalled();
    expect(steps).toEqual(["backoff:3000", "continuation"]);
    expect(continued).toEqual([{ incidentId: "i6" }]);

    // With no delay it dispatches at once: the run starts from the alarm.
    steps.length = 0;
    await createChatTurnTaskDefinition({
      ...hooks,
      attempts: {
        _chatRecoveryContinue: async () => {},
        _chatRecoveryRetry: async () => {}
      }
    })(
      {
        requestId: "r5",
        nonce: "n5",
        attempt: {
          callback: "_chatRecoveryContinue",
          data: { incidentId: "i5" },
          delaySeconds: 0
        }
      },
      step
    );
    expect(steps).toEqual(["continuation"]);
  });

  it("holds the lane of a reply that failed on the platform until its replacement's own reply ends", async () => {
    // A lane run's recovery attempt hands off, and its reply then fails on
    // the platform: the replacement gets a run of its own.
    let replacementRunId: string | undefined;
    let failReply: () => void = () => {};
    const replyFails = new Promise<void>((resolve) => {
      failReply = resolve;
    });
    const { reply: held } = await runHoldingLane(() =>
      dispatchChatRecoveryToHandoff({
        detached: async (onTurnStarted) => {
          onTurnStarted();
          await replyFails;
          throw new Error("Network connection lost.");
        },
        track: () => {},
        redefer: async (dedupeKey) => {
          replacementRunId = dedupeKey;
        },
        onDetachedError: () => {}
      })
    );
    let released = false;
    void held?.then(() => {
      released = true;
    });
    failReply();
    await vi.waitFor(() => expect(replacementRunId).toBeDefined());

    // The replacement's run runs its attempt, whose reply is still going.
    let finishReply: () => void = () => {};
    const replyEnds = new Promise<void>((resolve) => {
      finishReply = resolve;
    });
    const { step } = fakeStep(undefined);
    Object.assign(step, { id: replacementRunId });
    await createChatTurnTaskDefinition({
      ...hooks,
      attempts: {
        _chatRecoveryContinue: () =>
          dispatchChatRecoveryToHandoff({
            detached: async (onTurnStarted) => {
              onTurnStarted();
              await replyEnds;
            },
            track: () => {},
            redefer: async () => {},
            onDetachedError: () => {}
          }),
        _chatRecoveryRetry: async () => {}
      }
    })(
      {
        requestId: "r4",
        nonce: "n4",
        attempt: {
          callback: "_chatRecoveryContinue",
          data: { incidentId: "i4" },
          delaySeconds: 0
        }
      },
      step
    );
    // The run returned at the handoff; the lane is still held for the reply.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(released).toBe(false);
    finishReply();
    await held;
    expect(released).toBe(true);
  });

  it("tells the host when a lane run starts its kept attempt's backoff, before it suspends", async () => {
    const { step } = fakeStep(undefined);
    const marks: Array<[string, string, boolean]> = [];
    const suspended = new Error("suspended");
    Object.assign(step, {
      id: "run-lane",
      // The backoff has not passed: the run suspends.
      sleep: async () => {
        throw suspended;
      }
    });
    const lane: ChatLaneEntry = {
      lane: true,
      run: (inside) =>
        inside(async () => {
          currentChatRun()?.(
            { requestId: "r-lane", envelope: null, onStash: () => {} },
            async () => {
              currentTurnAttempt()?.({
                callback: "_chatRecoveryContinue",
                data: { incidentId: "i-lane" },
                delaySeconds: 30
              });
              return "reply";
            }
          );
        }),
      dropped: () => {}
    };
    Object.assign(step, { local: lane });
    await expect(
      createChatTurnTaskDefinition({
        ...hooks,
        backingOff: (runId, requestId, waiting) =>
          void marks.push([runId, requestId, waiting])
      })({ requestId: "r-lane", nonce: "n-lane", lane: true }, step)
    ).rejects.toBe(suspended);
    // Marked as waiting, and not unmarked: the wait is still going.
    expect(marks).toEqual([["run-lane", "r-lane", true]]);
  });

  it("tells the host that a lane run's backoff is over when the run wakes", async () => {
    // The wake replays the run: its turn's closure went with the attempt
    // that suspended. The host must still hear that the wait ended, or it
    // would keep the run as waiting and a later stop would end it.
    const { step, checkpoint } = fakeStep(undefined);
    Object.assign(step, { id: "run-lane" });
    checkpoint.set("snapshot", JSON.stringify({ __cfBeganAt: 1 }));
    checkpoint.set(
      "attempt",
      JSON.stringify({
        callback: "_chatRecoveryContinue",
        data: { incidentId: "i-lane" },
        delaySeconds: 30
      })
    );
    const marks: Array<[string, string, boolean]> = [];
    await createChatTurnTaskDefinition({
      ...hooks,
      backingOff: (runId, requestId, waiting) =>
        void marks.push([runId, requestId, waiting])
    })({ requestId: "r-lane", nonce: "n-lane", lane: true }, step);
    expect(marks).toEqual([
      ["run-lane", "r-lane", true],
      ["run-lane", "r-lane", false]
    ]);
  });

  it("keeps a live turn's planned attempt in the checkpoint at once", async () => {
    const { step, checkpoint } = fakeStep(undefined);
    let kept: string | undefined;
    const entry: ChatTurnClosureEntry = {
      onStash: () => {},
      run: (inside) =>
        inside(async () => {
          currentTurnAttempt()?.({
            callback: "_chatRecoveryRetry",
            data: { incidentId: "i8" },
            delaySeconds: 1
          });
          kept = checkpoint.get("attempt");
          return "reply";
        }),
      settle: { resolve: () => {}, reject: () => {} }
    };
    Object.assign(step, { local: entry });
    await createChatTurnTaskDefinition(hooks)(
      { requestId: "r8", nonce: "n8" },
      step
    );
    expect(kept && JSON.parse(kept)).toEqual({
      callback: "_chatRecoveryRetry",
      data: { incidentId: "i8" },
      delaySeconds: 1
    });
  });
});
