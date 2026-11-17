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
      async () => {
        liveDuringRun =
          fibers.liveTurns.has("r1") && fibers.liveClosures.has("nonce-1");
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
      "takeReply:true",
      "run"
    ]);
    expect(fibers.liveTurns.size).toBe(0);
    expect(fibers.liveClosures.size).toBe(0);
  });

  it("wraps the snapshot and the app's stash data into one envelope", async () => {
    let envelope: unknown;
    await fibers.run(
      { requestId: "r1", continuation: false, snapshot: snapshot("r1") },
      async () => {
        envelope = fibers.liveClosures.get("nonce-1")!.wrap({ step: 2 });
        expect(fibers.liveTurns.get("r1")?.recoveryData).toEqual({ step: 2 });
      }
    );
    expect(envelope).toEqual({ __snapshot: snapshot("r1"), user: { step: 2 } });
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
