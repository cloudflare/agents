import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it, expect, beforeEach } from "vitest";
import { createChatFiberSnapshot } from "../recovery";
import { ChatTurnFibers, type ChatTurnFiberHost } from "../turn-fiber";
import type { ChatTurnClosureEntry } from "../turn-task";

const snapshot = (requestId: string) =>
  createChatFiberSnapshot({
    kind: "test-turn",
    requestId,
    continuation: false,
    messages: []
  });

describe("ChatTurnFibers", () => {
  let log: string[];
  let turnSignal: AbortSignal | undefined;
  let fibers: ChatTurnFibers;
  let host: ChatTurnFiberHost;

  beforeEach(() => {
    log = [];
    turnSignal = undefined;
    host = {
      fiberName: "chat",
      snapshotKey: "__snapshot",
      generateId: () => "nonce-1",
      turnSignal: () => turnSignal,
      // The Task runs the closure it was given and settles the caller.
      runTask: async ({ requestId, continuation, nonce }, closure) => {
        log.push(`task:${requestId}:${continuation}:${nonce}`);
        try {
          closure.settle.resolve(await closure.run((fn) => fn()));
        } catch (error) {
          log.push("engine:failed");
          closure.settle.reject(error);
        }
      },
      turnBody: (continuation, body) => () =>
        body(async () => void log.push(`takeReply:${continuation}`))
    };
    fibers = new ChatTurnFibers(host);
  });

  it("runs a turn as a Task closure in the caller's context and returns its value", async () => {
    let liveDuringRun = false;
    const value = await fibers.run(
      { requestId: "r1", continuation: true, snapshot: snapshot("r1") },
      async (takeReply) => {
        liveDuringRun = fibers.liveTurns.has("r1");
        log.push("model");
        // The model returned a reply: the turn takes it.
        await takeReply();
        log.push("run");
        return "reply";
      }
    );
    expect(value).toBe("reply");
    expect(liveDuringRun).toBe(true);
    expect(log).toEqual([
      "task:r1:true:nonce-1",
      "model",
      "takeReply:true",
      "run"
    ]);
    expect(fibers.liveTurns.size).toBe(0);
  });

  it("runs the turn in the caller's async context even when another context starts it", async () => {
    const caller = new AsyncLocalStorage<string>();
    // The alarm, not the caller, claims the run and starts the closure.
    host.runTask = (_input, closure) =>
      caller.run("alarm", async () => {
        closure.settle.resolve(await closure.run((fn) => fn()));
      });
    const seen = await caller.run("caller", () =>
      fibers.run(
        { requestId: "r1", continuation: false, snapshot: snapshot("r1") },
        async () => caller.getStore()
      )
    );
    expect(seen).toBe("caller");
  });

  it("names the turn's request id to the recovery engine, so a stop by it reaches a recovery attempt", async () => {
    const named: string[] = [];
    host.turnBody = (_continuation, body, requestId) => () => {
      named.push(requestId);
      return body(async () => {});
    };
    await fibers.run(
      { requestId: "r1", continuation: true, snapshot: snapshot("r1") },
      async () => {}
    );
    expect(named).toEqual(["r1"]);
  });

  it("does not take the reply for a turn that ends before its model call returned one", async () => {
    // The repair or a hook threw, or the model call returned nothing: a
    // recovery scheduled to continue the reply must stay in place.
    await expect(
      fibers.run(
        { requestId: "r1", continuation: true, snapshot: snapshot("r1") },
        async () => {
          throw new Error("hook failed");
        }
      )
    ).rejects.toThrow("hook failed");
    await fibers.run(
      { requestId: "r2", continuation: true, snapshot: snapshot("r2") },
      async () => undefined
    );
    expect(log.some((entry) => entry.startsWith("takeReply"))).toBe(false);
  });

  it("gives the tools and body a running turn was started with", async () => {
    const pinned = createChatFiberSnapshot({
      kind: "test-turn",
      requestId: "r1",
      continuation: false,
      messages: [],
      lastBody: { agentToolInput: "x" },
      lastClientTools: undefined
    });
    let during: unknown;
    await fibers.run(
      { requestId: "r1", continuation: false, snapshot: pinned },
      async () => {
        during = fibers.requestContext("r1");
      }
    );
    expect(during).toEqual({
      lastBody: { agentToolInput: "x" },
      lastClientTools: undefined
    });
    expect(fibers.requestContext("r1")).toBeUndefined();
  });

  it("wraps the snapshot and the app's stash data into one envelope", async () => {
    let envelope: unknown;
    // One snapshot for the run and the expectation: it carries a timestamp.
    const turnSnapshot = snapshot("r1");
    let closure!: ChatTurnClosureEntry;
    const runTask = host.runTask;
    host.runTask = (input, local) => {
      closure = local;
      return runTask(input, local);
    };
    await fibers.run(
      { requestId: "r1", continuation: false, snapshot: turnSnapshot },
      async () => {
        envelope = closure.wrap({ step: 2 });
        expect(fibers.liveTurns.get("r1")?.recoveryData).toEqual({ step: 2 });
      }
    );
    expect(envelope).toEqual({ __snapshot: turnSnapshot, user: { step: 2 } });
  });

  it("tells the host once the fiber is accepted, before the turn runs", async () => {
    await fibers.run(
      {
        requestId: "r1",
        continuation: false,
        snapshot: snapshot("r1"),
        onAccepted: (requestId) => void log.push(`accepted:${requestId}`)
      },
      async () => void log.push("run")
    );
    expect(log.indexOf("accepted:r1")).toBeLessThan(log.indexOf("run"));
    expect(log.indexOf("task:r1:false:nonce-1")).toBeLessThan(
      log.indexOf("accepted:r1")
    );
  });

  it("keeps a running turn's entry when an earlier turn with the same request id ends", async () => {
    // A turn run inside a queue slot the host already holds reuses the
    // slot's request id.
    let releaseFirst!: () => void;
    let nonces = 0;
    host.generateId = () => `nonce-${++nonces}`;
    const first = fibers.run(
      { requestId: "r1", continuation: false, snapshot: snapshot("r1") },
      () => new Promise<void>((resolve) => (releaseFirst = resolve))
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    let contextAfterFirstEnded: unknown;
    const second = fibers.run(
      { requestId: "r1", continuation: false, snapshot: snapshot("r1") },
      async () => {
        releaseFirst();
        await first;
        contextAfterFirstEnded = fibers.requestContext("r1");
      }
    );
    await second;
    // The second turn is still running when the first ends: its entry stays.
    expect(contextAfterFirstEnded).toBeDefined();
    expect(fibers.liveTurns.size).toBe(0);
  });

  it("rejects cleanly when the Task start fails after the turn already rejected", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      host.runTask = async (_input, closure) => {
        closure.settle.reject(new Error("turn failed"));
        throw new Error("task failed");
      };
      await expect(
        fibers.run(
          { requestId: "r1", continuation: false, snapshot: snapshot("r1") },
          async () => "never runs"
        )
      ).rejects.toThrow("task failed");
      // Give an unhandled rejection a tick to surface.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    // The turn's own rejection was never awaited. It must not leak as an
    // unhandled rejection.
    expect(unhandled).toEqual([]);
  });

  it("gives the caller what a stopped turn threw, and does not fail the Task with it", async () => {
    const controller = new AbortController();
    turnSignal = controller.signal;
    await expect(
      fibers.run(
        { requestId: "r1", continuation: false, snapshot: snapshot("r1") },
        async () => {
          // The stop, then what the model call throws because of it.
          controller.abort("stop reason");
          throw controller.signal.reason;
        }
      )
    ).rejects.toBe("stop reason");
    expect(log).not.toContain("engine:failed");
  });

  it("fails the Task with the error of a turn nothing stopped", async () => {
    turnSignal = new AbortController().signal;
    await expect(
      fibers.run(
        { requestId: "r1", continuation: false, snapshot: snapshot("r1") },
        async () => {
          throw new Error("boom");
        }
      )
    ).rejects.toThrow("boom");
    expect(log).toContain("engine:failed");
  });

  it("gives a recovery attempt's turn its error, and does not fail the Task with it", async () => {
    host.inRecoveryAttempt = () => true;
    await expect(
      fibers.run(
        { requestId: "r1", continuation: true, snapshot: snapshot("r1") },
        async () => {
          throw new Error("Network connection lost.");
        }
      )
    ).rejects.toThrow("Network connection lost.");
    expect(log).not.toContain("engine:failed");
  });

  it("fails the Task of a recovery attempt's turn the isolate's memory reset ended", async () => {
    host.inRecoveryAttempt = () => true;
    await expect(
      fibers.run(
        { requestId: "r1", continuation: true, snapshot: snapshot("r1") },
        async () => {
          throw new Error(
            "Durable Object's isolate exceeded its memory limit and was reset."
          );
        }
      )
    ).rejects.toThrow("memory limit");
    expect(log).toContain("engine:failed");
  });

  it("rejects with the turn's error and leaves nothing behind", async () => {
    await expect(
      fibers.run(
        { requestId: "r1", continuation: false, snapshot: snapshot("r1") },
        async () => {
          throw new Error("boom");
        }
      )
    ).rejects.toThrow("boom");
    expect(fibers.liveTurns.size).toBe(0);
  });
});
