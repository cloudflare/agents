import { describe, it, expect } from "vitest";
import { AbortRegistry } from "../abort-registry";
import { runRpcRequest, type RpcChatRequest } from "../rpc-request";
import { TurnQueue } from "../turn-queue";

/** A core reduced to a queue and a registry, with a clear. */
function makeCore() {
  const core = { queue: new TurnQueue(), aborts: new AbortRegistry() };
  const reset = () => {
    core.queue.reset();
    core.aborts.destroyAll();
  };
  return { core, reset };
}

/** Occupy the queue until `release` is called. */
function holdQueue(queue: TurnQueue) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void queue.enqueue("held", () => held);
  return release;
}

function makeRequest(
  core: { queue: TurnQueue },
  overrides: Partial<RpcChatRequest> = {}
) {
  const log: string[] = [];
  const request: RpcChatRequest = {
    requestId: "rpc-1",
    onStart: () => void log.push("start"),
    enqueue: async (turn, generation) =>
      (await core.queue.enqueue("rpc-1", turn, { generation })).status,
    run: async () => void log.push("run"),
    onReset: () => void log.push("reset"),
    onCancelledBeforeStart: () => void log.push("cancelled"),
    ...overrides
  };
  return { request, log };
}

describe("runRpcRequest", () => {
  it("tells the caller the request id, then runs the turn", async () => {
    const { core } = makeCore();
    const { request, log } = makeRequest(core);
    await runRpcRequest(core, request);
    expect(log).toEqual(["start", "run"]);
    expect(core.aborts.has("rpc-1")).toBe(false);
  });

  it("never runs a request cancelled by id while it waited in the queue", async () => {
    const { core } = makeCore();
    const release = holdQueue(core.queue);
    const { request, log } = makeRequest(core);
    const done = runRpcRequest(core, request);
    await Promise.resolve();
    core.aborts.cancel("rpc-1");
    release();
    await done;
    expect(log).toEqual(["start", "cancelled"]);
  });

  it("never runs a request whose caller's signal aborted while it waited", async () => {
    const { core } = makeCore();
    const release = holdQueue(core.queue);
    const caller = new AbortController();
    const { request, log } = makeRequest(core, { signal: caller.signal });
    const done = runRpcRequest(core, request);
    await Promise.resolve();
    caller.abort();
    release();
    await done;
    expect(log).toEqual(["start", "cancelled"]);
  });

  it("reports a reset that lands while the request waits in the queue", async () => {
    const { core, reset } = makeCore();
    const release = holdQueue(core.queue);
    const { request, log } = makeRequest(core);
    const done = runRpcRequest(core, request);
    await Promise.resolve();
    reset();
    release();
    await done;
    expect(log).toEqual(["start", "reset"]);
  });

  it("queues under the generation it was accepted with, so a reset during onStart is not lost", async () => {
    const { core, reset } = makeCore();
    const { request, log } = makeRequest(core, {
      onStart: async () => {
        log.push("start");
        reset();
      }
    });
    await runRpcRequest(core, request);
    expect(log).toEqual(["start", "reset"]);
  });

  it("reports a reset that lands while the turn runs, and aborts its signal", async () => {
    const { core, reset } = makeCore();
    let aborted = false;
    let current = true;
    const { request, log } = makeRequest(core, {
      run: async (signal, { isCurrent }) => {
        reset();
        aborted = signal.aborted;
        current = isCurrent();
      }
    });
    await runRpcRequest(core, request);
    expect(aborted).toBe(true);
    expect(current).toBe(false);
    expect(log).toEqual(["start", "reset"]);
  });

  it("drops the controller and unlinks the caller's signal when the turn throws", async () => {
    const { core } = makeCore();
    const caller = new AbortController();
    const { request } = makeRequest(core, {
      signal: caller.signal,
      run: async () => {
        throw new Error("boom");
      }
    });
    await expect(runRpcRequest(core, request)).rejects.toThrow("boom");
    expect(core.aborts.has("rpc-1")).toBe(false);
    caller.abort();
    expect(core.aborts.has("rpc-1")).toBe(false);
  });
});
