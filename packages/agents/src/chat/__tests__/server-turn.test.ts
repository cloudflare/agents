import { describe, it, expect, beforeEach } from "vitest";
import { AbortRegistry } from "../abort-registry";
import {
  mapServerTurnOutcome,
  runServerTurn,
  type ServerChatTurn,
  type ServerTurnParts
} from "../server-turn";
import { TurnQueue } from "../turn-queue";

/** Let queued microtasks and the queue's own awaits run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("runServerTurn", () => {
  let parts: ServerTurnParts;
  let log: string[];

  beforeEach(() => {
    parts = { queue: new TurnQueue(), aborts: new AbortRegistry() };
    log = [];
  });

  /** A turn whose steps record themselves; override any of them. */
  function turn(
    id: string,
    overrides: Partial<ServerChatTurn<string>> = {}
  ): ServerChatTurn<string> {
    return {
      requestId: id,
      enqueue: async (run, generation) =>
        (await parts.queue.enqueue(id, run, { generation })).status,
      prepare: async () => {
        log.push(`${id}:prepare`);
        return { input: "messages" };
      },
      persist: async (input) => void log.push(`${id}:persist:${input}`),
      run: async (signal, input) => {
        log.push(`${id}:run:${input}:${signal.aborted}`);
        return { status: "completed" };
      },
      onAborted: () => void log.push(`${id}:onAborted`),
      ...overrides
    };
  }

  /** Hold the queue with a turn that ends when the returned function runs. */
  function holdQueue(): () => void {
    let release!: () => void;
    void parts.queue.enqueue(
      "earlier",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    return () => release();
  }

  it("prepares, persists and runs a turn, then drops its controller", async () => {
    let registeredDuringRun = false;
    const result = await runServerTurn(
      parts,
      turn("s1", {
        run: async () => {
          registeredDuringRun = parts.aborts.has("s1");
          log.push("s1:run");
          return { status: "completed" };
        }
      })
    );
    expect(result).toEqual({ status: "completed" });
    expect(log).toEqual(["s1:prepare", "s1:persist:messages", "s1:run"]);
    expect(registeredDuringRun).toBe(true);
    expect(parts.aborts.size).toBe(0);
  });

  it("hands the turn's status to the host's queue wrapper", async () => {
    let seen: string | undefined;
    await runServerTurn(
      parts,
      turn("s1", {
        enqueue: async (run) => {
          seen = await run();
          return "completed";
        },
        run: async () => ({ status: "error", error: "boom" })
      })
    );
    expect(seen).toBe("error");
  });

  it("returns the error a run reports", async () => {
    const result = await runServerTurn(
      parts,
      turn("s1", { run: async () => ({ status: "error", error: "boom" }) })
    );
    expect(result).toEqual({ status: "error", error: "boom" });
  });

  // ── Stops ───────────────────────────────────────────────────────────

  it("creates the controller at admission, so a stop while queued is not lost", async () => {
    const release = holdQueue();
    const pending = runServerTurn(parts, turn("s1"));
    await settle();
    expect(parts.aborts.has("s1")).toBe(true);

    // abortAllRequests(): the turn has not started, and still hears it.
    parts.aborts.destroyAll();
    release();

    expect(await pending).toEqual({ status: "aborted" });
    // Its messages are stored; the model is never called.
    expect(log).toEqual(["s1:prepare", "s1:persist:messages", "s1:onAborted"]);
    expect(parts.aborts.size).toBe(0);
  });

  it("never calls the model for a caller signal aborted before the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runServerTurn(
      parts,
      turn("s1", { signal: controller.signal })
    );
    expect(result).toEqual({ status: "aborted" });
    expect(log).toEqual(["s1:prepare", "s1:persist:messages", "s1:onAborted"]);
    expect(parts.aborts.size).toBe(0);
  });

  it("never calls the model for a caller signal aborted while the turn is queued", async () => {
    const release = holdQueue();
    const controller = new AbortController();
    const pending = runServerTurn(
      parts,
      turn("s1", { signal: controller.signal })
    );
    await settle();
    controller.abort();
    release();
    expect(await pending).toEqual({ status: "aborted" });
    expect(log).not.toContain("s1:run:messages:true");
    expect(log).toContain("s1:onAborted");
  });

  it("aborts the running turn's signal when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const result = await runServerTurn(
      parts,
      turn("s1", {
        signal: controller.signal,
        run: async (signal) => {
          controller.abort();
          log.push(`s1:aborted:${signal.aborted}`);
          // The host's reply path saw the abort and reported it.
          return { status: "aborted" };
        }
      })
    );
    expect(result).toEqual({ status: "aborted" });
    expect(log).toContain("s1:aborted:true");
    // The host already handled an aborted reply.
    expect(log).not.toContain("s1:onAborted");
  });

  it("reports aborted, and tells the host, when a stopped run ends without a reply", async () => {
    const result = await runServerTurn(
      parts,
      turn("s1", {
        run: async () => {
          parts.aborts.cancel("s1");
        }
      })
    );
    expect(result).toEqual({ status: "aborted" });
    expect(log).toContain("s1:onAborted");
  });

  it("keeps the turn's signal aborted after the registry is emptied mid-run", async () => {
    let aborted = false;
    const result = await runServerTurn(
      parts,
      turn("s1", {
        run: async (signal) => {
          parts.aborts.destroyAll();
          aborted = signal.aborted;
          return { status: "completed" };
        }
      })
    );
    expect(aborted).toBe(true);
    expect(result).toEqual({ status: "aborted" });
  });

  it("detaches from the caller's signal when the turn ends", async () => {
    const controller = new AbortController();
    await runServerTurn(parts, turn("s1", { signal: controller.signal }));
    // A later abort finds no listener and no controller to cancel.
    controller.abort();
    expect(parts.aborts.size).toBe(0);
  });

  it("drops the controller and the listener when the run throws", async () => {
    const controller = new AbortController();
    await expect(
      runServerTurn(
        parts,
        turn("s1", {
          signal: controller.signal,
          run: async () => {
            throw new Error("fiber failed");
          }
        })
      )
    ).rejects.toThrow("fiber failed");
    expect(parts.aborts.size).toBe(0);
    controller.abort();
    expect(parts.aborts.size).toBe(0);
  });

  it("drops the controller and the listener when the queue wrapper throws", async () => {
    const controller = new AbortController();
    await expect(
      runServerTurn(
        parts,
        turn("s1", {
          signal: controller.signal,
          enqueue: async () => {
            throw new Error("nested turn");
          }
        })
      )
    ).rejects.toThrow("nested turn");
    expect(parts.aborts.size).toBe(0);
  });

  it("ends a turn its prepare declines, without storing or running it", async () => {
    const result = await runServerTurn(
      parts,
      turn("s1", { prepare: async () => ({ declined: "aborted" }) })
    );
    expect(result).toEqual({ status: "aborted" });
    expect(log).toEqual([]);
  });

  // ── Resets ──────────────────────────────────────────────────────────

  it("skips a turn the chat was reset under while it waited in the queue", async () => {
    const release = holdQueue();
    const controller = new AbortController();
    const pending = runServerTurn(
      parts,
      turn("s1", { signal: controller.signal })
    );
    await settle();
    parts.queue.reset();
    parts.aborts.destroyAll();
    release();

    expect(await pending).toEqual({ status: "skipped" });
    expect(log).toEqual([]);
    expect(parts.aborts.size).toBe(0);
    // The listener is gone too, though the turn's body never ran.
    controller.abort();
    expect(parts.aborts.size).toBe(0);
  });

  it("stores nothing when the chat is reset while prepare waits", async () => {
    const result = await runServerTurn(
      parts,
      turn("s1", {
        prepare: async () => {
          parts.queue.reset();
          parts.aborts.destroyAll();
          return { input: "messages" };
        }
      })
    );
    expect(result).toEqual({ status: "skipped" });
    expect(log).toEqual([]);
  });

  it("does not run a turn the chat was reset under while it persisted", async () => {
    const result = await runServerTurn(
      parts,
      turn("s1", {
        persist: async () => {
          parts.queue.reset();
          parts.aborts.destroyAll();
        }
      })
    );
    expect(result).toEqual({ status: "skipped" });
    expect(log).toEqual(["s1:prepare"]);
  });

  it("reports skipped, not aborted, for a completed turn the chat was reset under", async () => {
    const result = await runServerTurn(
      parts,
      turn("s1", {
        run: async () => {
          parts.queue.reset();
          parts.aborts.destroyAll();
          return { status: "completed" };
        }
      })
    );
    expect(result).toEqual({ status: "skipped" });
    expect(log).not.toContain("s1:onAborted");
  });

  it("runs a turn inside a queue slot the host already holds", async () => {
    const result = await parts.queue.enqueue("outer", () =>
      runServerTurn(
        parts,
        turn("outer", {
          enqueue: async (run) => {
            await run();
            return "completed";
          }
        })
      )
    );
    expect(result).toEqual({
      status: "completed",
      value: { status: "completed" }
    });
    expect(log).toContain("outer:run:messages:false");
  });
});

describe("mapServerTurnOutcome", () => {
  it("maps only a completed turn", () => {
    const error = { status: "error" as const, error: "boom" };
    expect(mapServerTurnOutcome(error, { reset: true, aborted: true })).toBe(
      error
    );
    expect(
      mapServerTurnOutcome(
        { status: "aborted" },
        { reset: true, aborted: false }
      )
    ).toEqual({ status: "aborted" });
  });

  it("lets a reset win over a stop", () => {
    expect(
      mapServerTurnOutcome(
        { status: "completed" },
        { reset: true, aborted: true }
      )
    ).toEqual({ status: "skipped" });
    expect(
      mapServerTurnOutcome(
        { status: "completed" },
        { reset: false, aborted: true }
      )
    ).toEqual({ status: "aborted" });
  });
});
