import { describe, it, expect, beforeEach } from "vitest";
import { createChatFiberSnapshot } from "../recovery";
import { ChatTurnFibers, type ChatTurnFiberHost } from "../turn-fiber";

const snapshot = (requestId: string) =>
  createChatFiberSnapshot({
    kind: "test-turn",
    requestId,
    continuation: false,
    messages: []
  });

describe("ChatTurnFibers", () => {
  let log: string[];
  let facet: boolean;
  let fibers: ChatTurnFibers;
  let host: ChatTurnFiberHost;

  beforeEach(() => {
    log = [];
    facet = false;
    host = {
      fiberName: "chat",
      snapshotKey: "__snapshot",
      generateId: () => "nonce-1",
      isFacet: () => facet,
      runLegacyFiber: async (name, fn, options) => {
        log.push(`legacy:${name}:${JSON.stringify(options.initialSnapshot)}`);
        return fn();
      },
      // The Task runs the registered closure and settles the caller.
      runTask: async ({ requestId, continuation, nonce }) => {
        log.push(`task:${requestId}:${continuation}:${nonce}`);
        const closure = fibers.liveClosures.get(nonce)!;
        try {
          closure.settle.resolve(await closure.run());
        } catch (error) {
          closure.settle.reject(error);
        }
      },
      captureContext: () => {
        log.push("context:captured");
        return (fn) => {
          log.push("context:entered");
          return fn();
        };
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
        liveDuringRun =
          fibers.liveTurns.has("r1") && fibers.liveClosures.has("nonce-1");
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
      "context:captured",
      "task:r1:true:nonce-1",
      "context:entered",
      "model",
      "takeReply:true",
      "run"
    ]);
    expect(fibers.liveTurns.size).toBe(0);
    expect(fibers.liveClosures.size).toBe(0);
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
    await fibers.run(
      { requestId: "r1", continuation: false, snapshot: turnSnapshot },
      async () => {
        envelope = fibers.liveClosures.get("nonce-1")!.wrap({ step: 2 });
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

  it("runs a facet's turn on the legacy fiber engine", async () => {
    facet = true;
    const value = await fibers.run(
      {
        requestId: "r1",
        continuation: false,
        snapshot: snapshot("r1"),
        onAccepted: () => void log.push("accepted")
      },
      async () => "reply"
    );
    expect(value).toBe("reply");
    expect(log[0]).toContain("legacy:chat:r1:");
    expect(log).toContain("accepted");
    expect(log.some((entry) => entry.startsWith("task:"))).toBe(false);
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
      host.runTask = async ({ nonce }) => {
        fibers.liveClosures.get(nonce)!.settle.reject(new Error("turn failed"));
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
    expect(fibers.liveClosures.size).toBe(0);
  });
});
