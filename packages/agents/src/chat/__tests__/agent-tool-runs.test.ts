import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import {
  createAgentToolRunStore,
  type AgentToolRunTerminal
} from "../agent-tool-run-store";
import {
  AgentToolRuns,
  agentToolRunOutcome,
  type AgentToolStreams,
  type AgentToolTurnResult
} from "../agent-tool-runs";
import { TurnQueue } from "../turn-queue";

type SqlValue = string | number | null;

/**
 * The real run store on an in-memory SQLite database, plus what the tests
 * read back: the terminal a row holds and how often one was written.
 */
function makeStore() {
  const db = new DatabaseSync(":memory:");
  const store = createAgentToolRunStore(
    () => ({
      exec: (query: string, ...bindings: unknown[]) => {
        const rows = db.prepare(query).all(...(bindings as SqlValue[]));
        return { toArray: () => rows as Record<string, unknown>[] };
      }
    }),
    { runs: "runs", milestones: "milestones", requestIndex: "runs_request" }
  );
  const writes = new Map<string, number>();
  const writeTerminal = store.writeTerminal;
  store.writeTerminal = (runId, terminal, turn) => {
    writes.set(runId, (writes.get(runId) ?? 0) + 1);
    writeTerminal(runId, terminal, turn);
  };
  return Object.assign(store, {
    /** Insert an open row, as an earlier isolate would have left it. */
    seed: (runId: string, terminalOnly = false) =>
      store.insert(runId, { input: "go", startedAt: 1, terminalOnly }),
    writes: (runId: string) => writes.get(runId) ?? 0,
    terminal: (runId: string): AgentToolRunTerminal | undefined => {
      const run = store.read(runId);
      if (!run) return undefined;
      if (run.status === "completed") {
        return {
          status: "completed",
          output: run.output,
          summary: run.summary
        };
      }
      if (run.status === "error") {
        return { status: "error", error: run.error ?? "" };
      }
      if (run.status === "aborted") {
        return { status: "aborted", error: run.error };
      }
      return undefined;
    }
  });
}

type Incident = { status: string };

function setup() {
  const store = makeStore();
  const queue = new TurnQueue();
  const recovered: Array<{ requestId: string; reason: unknown }> = [];
  const broadcasts: Array<{ requestId: string; body: string }> = [];
  const incidents = new Map<string, Incident>();
  const stored = new Map<string, string[]>();
  const streamOf = new Map<string, string>();
  let reply = false;
  let activeRequestId: string | null = null;
  let activeStream = false;
  let holdList: Promise<void> | undefined;
  const lifecycles: Promise<unknown>[] = [];
  const streams: AgentToolStreams = {
    flushBuffer: () => {},
    latestStreamInfoForRequest: (requestId) => {
      const id = streamOf.get(requestId);
      return id ? { id } : null;
    },
    getStreamChunks: (streamId) =>
      (stored.get(streamId) ?? []).map((body, chunk_index) => ({
        body,
        chunk_index
      })),
    hasActiveStream: () => activeStream
  };
  const collected: unknown[] = [];
  const runs = new AgentToolRuns({
    store,
    queue,
    streams: () => streams,
    storage: () => ({
      list: (async () => {
        await holdList;
        return incidents;
      }) as unknown as DurableObjectStorage["list"]
    }),
    responseType: "response",
    resetError: "cleared",
    keepAliveWhile: (fn) => {
      const running = fn();
      lifecycles.push(running);
      return running;
    },
    activeRequestId: () => activeRequestId,
    broadcastChunk: (requestId, body) =>
      void broadcasts.push({ requestId, body }),
    collectResult: (_runId, input) => {
      collected.push(input);
      return { output: { ok: true }, summary: "done" };
    },
    messages: () => (reply ? [{ id: "reply", role: "assistant" }] : []),
    cancelRequest: (requestId, reason) =>
      void recovered.push({ requestId, reason })
  });
  return {
    store,
    queue,
    runs,
    recovered,
    broadcasts,
    collected,
    settled: () => Promise.all(lifecycles),
    setRecovery: (state: "in-progress" | "failed" | "none") => {
      incidents.clear();
      if (state === "in-progress") incidents.set("i", { status: "scheduled" });
      if (state === "failed") incidents.set("i", { status: "exhausted" });
    },
    setReply: (value: boolean) => {
      reply = value;
    },
    setActiveRequest: (requestId: string | null) => {
      activeRequestId = requestId;
    },
    setActiveStream: (value: boolean) => {
      activeStream = value;
    },
    /** Give `requestId` a stream holding `bodies`. */
    storeChunks: (requestId: string, bodies: string[]) => {
      const streamId = `stream-${requestId}`;
      streamOf.set(requestId, streamId);
      stored.set(streamId, bodies);
    },
    /** Make the next reconcile wait until the returned function is called. */
    holdRecoveryRead: () => {
      let release!: () => void;
      holdList = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        holdList = undefined;
        release();
      };
    }
  };
}

/** A turn the test ends by hand. */
function heldTurn() {
  let end!: (result: AgentToolTurnResult) => void;
  let fail!: (error: unknown) => void;
  let signal: AbortSignal | undefined;
  const run = (runSignal: AbortSignal) => {
    signal = runSignal;
    return new Promise<AgentToolTurnResult>((resolve, reject) => {
      end = resolve;
      fail = reject;
    });
  };
  return {
    run,
    end: (result: AgentToolTurnResult) => end(result),
    fail: (error: unknown) => fail(error),
    signal: () => signal
  };
}

const START = { input: "go", terminalOnly: false };

describe("agentToolRunOutcome", () => {
  const base = { resetSinceStart: false, resetError: "cleared" };

  it("records a completed turn as completed", () => {
    expect(
      agentToolRunOutcome({ ...base, turn: { status: "completed" } })
    ).toEqual({ status: "completed" });
  });

  it("records a turn the queue skipped after a reset as an error", () => {
    expect(
      agentToolRunOutcome({ ...base, turn: { status: "skipped" } })
    ).toEqual({ status: "error", error: "cleared" });
  });

  it("records a running turn a reset aborted as an error, like a queued one", () => {
    expect(
      agentToolRunOutcome({
        ...base,
        resetSinceStart: true,
        turn: { status: "aborted" }
      })
    ).toEqual({ status: "error", error: "cleared" });
  });

  it("records an aborted turn as aborted, with the reason", () => {
    expect(
      agentToolRunOutcome({
        ...base,
        turn: { status: "aborted" },
        abortReason: new Error("parent stopped")
      })
    ).toEqual({ status: "aborted", error: "parent stopped" });
  });

  it("records a captured stream error as an error, even for an aborted turn", () => {
    expect(
      agentToolRunOutcome({
        ...base,
        turn: { status: "aborted" },
        streamError: "provider failed"
      })
    ).toEqual({ status: "error", error: "provider failed" });
    expect(
      agentToolRunOutcome({
        ...base,
        turn: { status: "completed" },
        streamError: "provider failed"
      })
    ).toEqual({ status: "error", error: "provider failed" });
  });
});

describe("AgentToolRuns", () => {
  it("runs the turn and writes its outcome once, then forgets the run", async () => {
    const { runs, store, settled } = setup();
    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    expect(runs.isLive("run-1")).toBe(true);
    expect(store.read("run-1")?.status).toBe("running");

    turn.end({ requestId: "req-1", status: "completed" });
    await settled();
    expect(store.terminal("run-1")).toEqual({
      status: "completed",
      output: { ok: true },
      summary: "done"
    });
    expect(runs.isLive("run-1")).toBe(false);
    expect(runs.liveSequences.size).toBe(0);
    expect(runs.preTurnAssistantIds.size).toBe(0);
  });

  it("a cancel aborts the run's signal and its aborted status stands when the turn ends", async () => {
    const { runs, store, settled, recovered } = setup();
    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);

    runs.cancel("run-1", "stop");
    expect(turn.signal()?.aborted).toBe(true);
    expect(runs.isCancelled("run-1")).toBe(true);
    expect(store.terminal("run-1")).toEqual({
      status: "aborted",
      error: "stop"
    });
    // A live run is stopped through its own controller only.
    expect(recovered).toEqual([]);

    // The turn ends as an error, or completes anyway: the row is not rewritten.
    turn.end({ requestId: "req-1", status: "error", error: "late failure" });
    await settled();
    expect(store.read("run-1")?.status).toBe("aborted");
    expect(store.writes("run-1")).toBe(1);
  });

  it("a cancel of a run that is unknown or has ended does nothing", async () => {
    const { runs, store, settled, recovered } = setup();
    runs.cancel("no-such-run", "stop");

    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    turn.end({ requestId: "req-1", status: "completed" });
    await settled();

    runs.cancel("run-1", "stop");
    expect(store.read("run-1")?.status).toBe("completed");
    expect(recovered).toEqual([]);
  });

  it("a cancel of a run with no controller here cancels the request ids on its row, and only those", () => {
    const { runs, store, recovered } = setup();
    // A row an earlier isolate left open, recovered once already.
    store.seed("run-1");
    store.bindRequest("run-1", "req-1");
    runs.rebind("req-2");

    runs.cancel("run-1", "parent gave up");
    expect(recovered).toEqual([
      { requestId: "req-2", reason: "parent gave up" },
      { requestId: "req-1", reason: "parent gave up" }
    ]);
    expect(store.read("run-1")?.status).toBe("aborted");
  });

  it("a cancel of a run that never bound a request cancels no request", () => {
    const { runs, store, recovered } = setup();
    store.seed("run-1");
    runs.cancel("run-1", "parent gave up");
    expect(recovered).toEqual([]);
    expect(store.read("run-1")?.status).toBe("aborted");
  });

  it("records a stream error only on an open row, and never throws", () => {
    const { runs, store } = setup();
    store.seed("run-1");
    store.bindRequest("run-1", "req-1");
    runs.liveSequences.set("run-1", 0);
    const frame = (body: string) =>
      JSON.stringify({ type: "response", id: "req-1", body, error: true });
    runs.intercept(frame("first failure"));
    expect(store.read("run-1")?.error).toBe("first failure");

    runs.cancel("run-1", "stop");
    runs.runsByRequestId.set("req-1", "run-1");
    runs.liveSequences.set("run-1", 0);
    runs.intercept(frame("late failure"));
    // The row holds the cancel's reason, not an error that came after it.
    expect(store.read("run-1")?.error).toBe("stop");

    store.read = () => {
      throw new Error("sql failed");
    };
    expect(() => runs.intercept(frame("unrecorded"))).not.toThrow();
  });

  it("records a reset as an error whether the turn was queued or running", async () => {
    for (const status of ["skipped", "aborted"] as const) {
      const { runs, store, queue, settled } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      queue.reset();
      turn.end({ requestId: "req-1", status });
      await settled();
      expect(store.terminal("run-1")).toEqual({
        status: "error",
        error: "cleared"
      });
    }
  });

  it("records a turn that threw as an error, or as aborted when the run was aborted", async () => {
    const failed = setup();
    const turn = heldTurn();
    await failed.runs.start("run-1", START, turn.run);
    turn.fail(new Error("boom"));
    await failed.settled();
    expect(failed.store.terminal("run-1")).toEqual({
      status: "error",
      error: "boom"
    });

    const aborted = setup();
    const parent = new AbortController();
    const abortedTurn = heldTurn();
    await aborted.runs.start(
      "run-1",
      { ...START, signal: parent.signal },
      abortedTurn.run
    );
    parent.abort(new Error("parent stopped"));
    expect(abortedTurn.signal()?.aborted).toBe(true);
    abortedTurn.fail(new Error("aborted"));
    await aborted.settled();
    expect(aborted.store.terminal("run-1")).toEqual({
      status: "aborted",
      error: "parent stopped"
    });
  });

  it("binds the turn's request id and rebinds a recovered turn's", async () => {
    const { runs, store } = setup();
    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    runs.bindTurn("run-1", "req-1");
    expect(runs.runForRequest("req-1")).toBe("run-1");
    expect(runs.runForRequest("other")).toBe(null);

    runs.rebind("req-2");
    expect(store.read("run-1")?.requestId).toBe("req-2");
    expect(store.read("run-1")?.rootRequestId).toBe("req-1");
    expect(runs.runForRequest("req-2")).toBe("run-1");
  });

  it("resolves a request id from the row after a restart", () => {
    const { runs, store } = setup();
    store.seed("run-1", true);
    store.bindRequest("run-1", "req-1");
    expect(runs.runForRequest("req-1")).toBe("run-1");
    expect(runs.terminalOnlyRuns.has("run-1")).toBe(true);
  });

  it("reports a recovered turn whose run was cancelled, and leaves unrelated turns alone", () => {
    const { runs, store } = setup();
    expect(runs.isRecoveredRunCancelled("req-8")).toBe(false);

    store.seed("run-1");
    store.bindRequest("run-1", "req-1");
    // An open run's turn is recovered.
    expect(runs.isRecoveredRunCancelled("req-1")).toBe(false);
    runs.cancel("run-1", "stop");

    expect(runs.isRecoveredRunCancelled("req-1")).toBe(true);
    // A recovered turn of some other request is not this run's.
    expect(runs.isRecoveredRunCancelled("req-7")).toBe(false);
    // Nor is a turn that is not a recovery.
    expect(runs.isRecoveredRunCancelled(undefined)).toBe(false);
  });

  it("reports a cancelled run to a second recovery, which still names the first request id", () => {
    const { runs, store } = setup();
    store.seed("run-1");
    store.bindRequest("run-1", "req-1");
    // The first recovery re-runs the turn under a new request id.
    runs.rebind("req-2");
    expect(store.read("run-1")?.requestId).toBe("req-2");
    runs.cancel("run-1", "stop");
    // The isolate dies again; recovery wakes for the turn it knows as req-1.
    expect(runs.isRecoveredRunCancelled("req-1")).toBe(true);
  });

  it("a run that completed or failed does not stop the recovery of its turn", async () => {
    const { runs, store, setReply } = setup();
    store.seed("run-1");
    store.bindRequest("run-1", "req-1");
    setReply(true);
    await runs.reconcileStale("run-1");
    expect(store.read("run-1")?.status).toBe("completed");
    expect(runs.isRecoveredRunCancelled("req-1")).toBe(false);
  });

  it("settles a stale run from recovery: completed with a reply, error without", async () => {
    const withReply = setup();
    withReply.store.seed("run-1");
    withReply.setReply(true);
    await withReply.runs.reconcileStale("run-1");
    expect(withReply.store.read("run-1")?.status).toBe("completed");

    const without = setup();
    without.store.seed("run-1");
    await without.runs.reconcileStale("run-1");
    expect(without.store.terminal("run-1")).toEqual({
      status: "error",
      error: "Agent tool run was interrupted before the child could finish."
    });

    const errored = setup();
    errored.store.seed("run-1");
    errored.store.recordStreamError("run-1", "provider failed");
    errored.setReply(true);
    await errored.runs.reconcileStale("run-1");
    expect(errored.store.terminal("run-1")).toEqual({
      status: "error",
      error: "provider failed"
    });
  });

  it("leaves a stale run open while recovery is still working", async () => {
    const { runs, store, setRecovery } = setup();
    store.seed("run-1");
    setRecovery("in-progress");
    await runs.reconcileOwn();
    expect(store.read("run-1")?.status).toBe("running");
  });

  it("a reconcile does not replace a cancel that landed while it read recovery state", async () => {
    const { runs, store, holdRecoveryRead } = setup();
    store.seed("run-1");
    const release = holdRecoveryRead();
    const reconciling = runs.reconcileStale("run-1");
    runs.cancel("run-1", "stop");
    release();
    await reconciling;
    expect(store.terminal("run-1")).toEqual({
      status: "aborted",
      error: "stop"
    });
    expect(store.writes("run-1")).toBe(1);
  });

  it("closing the tails of a run with no controller here drops its streaming state", () => {
    const { runs } = setup();
    let closed = 0;
    runs.closers.set("run-1", new Set([() => void closed++]));
    runs.forwarders.set("run-1", new Set());
    runs.liveSequences.set("run-1", 3);
    runs.terminalOnlyRuns.add("run-1");
    runs.closeTailers("run-1");
    expect(closed).toBe(1);
    expect(runs.forwarders.size).toBe(0);
    expect(runs.liveSequences.size).toBe(0);
    expect(runs.terminalOnlyRuns.size).toBe(0);
  });

  it("starting a run id that already has a row starts nothing and reports that run", async () => {
    const { runs, store, settled } = setup();
    const first = heldTurn();
    await runs.start("run-1", START, first.run);
    first.end({ requestId: "req-1", status: "completed" });
    await settled();

    let started = false;
    const again = await runs.start("run-1", START, async () => {
      started = true;
      return { requestId: "req-2", status: "completed" };
    });
    expect(started).toBe(false);
    expect(again).toMatchObject({ status: "completed", summary: "done" });
    expect(store.writes("run-1")).toBe(1);
  });

  it("two starts of one run id sent together start one run", async () => {
    const { runs, settled } = setup();
    let turns = 0;
    const turn = heldTurn();
    const runTurn = (signal: AbortSignal) => {
      turns++;
      return turn.run(signal);
    };
    const [first, second] = await Promise.all([
      runs.start("run-1", START, runTurn),
      runs.start("run-1", START, runTurn)
    ]);
    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    turn.end({ requestId: "req-1", status: "completed" });
    await settled();
    expect(turns).toBe(1);
  });

  it("starting over a stale run reconciles it first", async () => {
    const { runs, store } = setup();
    store.seed("run-1");
    const inspection = await runs.start("run-1", START, async () => {
      throw new Error("must not start");
    });
    expect(inspection).toMatchObject({
      status: "error",
      error: "Agent tool run was interrupted before the child could finish."
    });
  });

  it("hands the output hook a live run's input as it was passed, a stored copy otherwise", async () => {
    const { runs, store, collected, settled, setReply } = setup();
    const input = { when: new Date(0) };
    const turn = heldTurn();
    await runs.start("run-1", { ...START, input }, turn.run);
    turn.end({ requestId: "req-1", status: "completed" });
    await settled();
    expect(collected[0]).toBe(input);

    store.seed("run-2");
    setReply(true);
    await runs.reconcileStale("run-2");
    expect(collected[1]).toBe("go");
  });

  it("reports a run as the parent reads it", async () => {
    const { runs, store, settled, storeChunks } = setup();
    expect(await runs.inspect("run-1")).toBe(null);

    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    runs.bindTurn("run-1", "req-1");
    storeChunks("req-1", ["a"]);
    expect(await runs.inspect("run-1")).toMatchObject({
      runId: "run-1",
      status: "running",
      requestId: "req-1",
      streamId: "stream-req-1",
      output: undefined,
      summary: undefined,
      error: undefined
    });

    turn.end({ requestId: "req-1", status: "completed" });
    await settled();
    const done = await runs.inspect("run-1");
    expect(done).toMatchObject({
      status: "completed",
      output: { ok: true },
      summary: "done",
      streamId: "stream-req-1"
    });
    expect(done?.completedAt).toBeTypeOf("number");

    store.seed("run-2");
    runs.cancel("run-2", "stop");
    expect(await runs.inspect("run-2")).toMatchObject({
      status: "aborted",
      error: "stop",
      output: undefined
    });
  });

  it("inspects a stale run without reconciling it when asked not to", async () => {
    const { runs, store } = setup();
    store.seed("run-1");
    expect(await runs.inspect("run-1", { reconcile: false })).toMatchObject({
      status: "running"
    });
    expect(store.read("run-1")?.status).toBe("running");
  });

  it("stores output JSON cannot hold as its string, and keeps the run completed", async () => {
    const { runs, store, setReply } = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    store.seed("run-1");
    store.writeTerminal("run-1", {
      status: "completed",
      output: circular,
      summary: "done"
    });
    setReply(true);
    expect(await runs.inspect("run-1")).toMatchObject({
      status: "completed",
      output: "[object Object]"
    });
  });

  it("reads a running run's stored chunks by its turn's request id", async () => {
    const { runs, storeChunks } = setup();
    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    expect(runs.chunks("run-1")).toEqual([]);
    runs.bindTurn("run-1", "req-1");
    storeChunks("req-1", ["a", "b", "c"]);
    expect(runs.chunks("run-1")).toEqual([
      { sequence: 0, body: "a" },
      { sequence: 1, body: "b" },
      { sequence: 2, body: "c" }
    ]);
    expect(runs.chunks("run-1", { afterSequence: 1 })).toEqual([
      { sequence: 2, body: "c" }
    ]);
  });

  describe("tail", () => {
    const decoder = new TextDecoder();
    async function readAll(stream: ReadableStream<Uint8Array>) {
      const reader = stream.getReader();
      let text = "";
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      return text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { sequence: number; body: string });
    }
    const frame = (requestId: string, body: string) =>
      JSON.stringify({ type: "response", id: requestId, body });

    it("replays the stored chunks, forwards the live ones once and in order, and closes when the run ends", async () => {
      const { runs, settled, storeChunks } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      storeChunks("req-1", ["a", "b"]);
      runs.liveSequences.set("run-1", 2);

      const reading = readAll(runs.tail("run-1", { afterSequence: -1 }));
      // Let the tail drain its backlog and attach.
      await new Promise((resolve) => setTimeout(resolve, 10));
      runs.intercept(frame("req-1", "c"));
      runs.intercept(frame("another-request", "not this run"));
      turn.end({ requestId: "req-1", status: "completed" });
      await settled();

      expect(await reading).toEqual([
        { sequence: 0, body: "a" },
        { sequence: 1, body: "b" },
        { sequence: 2, body: "c" }
      ]);
      expect(runs.forwarders.size).toBe(0);
    });

    it("emits a chunk that is both in the backlog and broadcast during the drain once", async () => {
      const { runs, settled, storeChunks } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      storeChunks("req-1", ["a"]);
      runs.liveSequences.set("run-1", 1);

      const reading = readAll(
        runs.tail("run-1", undefined, {
          chunks: async (runId, options) => {
            // Stored and broadcast while the backlog is being read.
            storeChunks("req-1", ["a", "b"]);
            runs.intercept(frame("req-1", "b"));
            return runs.chunks(runId, options);
          }
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      turn.end({ requestId: "req-1", status: "completed" });
      await settled();
      expect(await reading).toEqual([
        { sequence: 0, body: "a" },
        { sequence: 1, body: "b" }
      ]);
    });

    it("seeds a cold live counter from the stored backlog, so a recovered turn's chunks continue the numbering", async () => {
      const { runs, store, storeChunks, setRecovery } = setup();
      // A run an earlier isolate started; its turn is being recovered, so
      // the tail's inspect leaves the row open.
      store.seed("run-1");
      store.bindRequest("run-1", "req-1");
      storeChunks("req-1", ["a", "b", "c"]);
      setRecovery("in-progress");

      const abort = new AbortController();
      const stream = runs.tail("run-1", {
        afterSequence: 2,
        signal: abort.signal
      });
      const reader = stream.getReader();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(runs.liveSequences.get("run-1")).toBe(3);
      abort.abort();
      expect((await reader.read()).done).toBe(true);
    });

    it("closes at once for a run that has ended, and leaves no state behind", async () => {
      const { runs, store } = setup();
      store.seed("run-1");
      runs.cancel("run-1", "stop");
      expect(await readAll(runs.tail("run-1"))).toEqual([]);
      expect(runs.forwarders.size).toBe(0);
      expect(runs.liveSequences.size).toBe(0);
    });

    it("reconciles a stale run it is asked to follow, and closes", async () => {
      const { runs, store } = setup();
      store.seed("run-1");
      expect(await readAll(runs.tail("run-1"))).toEqual([]);
      expect(store.read("run-1")?.status).toBe("error");
    });

    it("a consumer that cancels the stream detaches and does not cancel the run", async () => {
      const { runs, store } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      const reader = runs.tail("run-1").getReader();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(runs.forwarders.get("run-1")?.size).toBe(1);
      await reader.cancel();
      expect(runs.forwarders.size).toBe(0);
      expect(store.read("run-1")?.status).toBe("running");
      expect(turn.signal()?.aborted).toBe(false);
    });
  });

  describe("progress", () => {
    it("is inactive outside a run's turn", () => {
      const { runs } = setup();
      expect(runs.reportProgress({ fraction: 0.5 })).toBe("inactive");
    });

    it("broadcasts progress for the run whose turn is active and stores the latest snapshot", async () => {
      const { runs, broadcasts, setActiveRequest } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      setActiveRequest("req-1");

      expect(runs.reportProgress({ fraction: 0.5, phase: "reading" })).toBe(
        "emitted"
      );
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]?.requestId).toBe("req-1");
      expect((await runs.inspect("run-1"))?.progress).toMatchObject({
        fraction: 0.5,
        phase: "reading"
      });
    });

    it("stores milestones in order and reports them with the run", async () => {
      const { runs, setActiveRequest } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      setActiveRequest("req-1");
      runs.reportProgress({ milestone: "sources", data: { count: 3 } });
      runs.reportProgress({ milestone: "draft" });
      expect((await runs.inspect("run-1"))?.milestones).toMatchObject([
        { name: "sources", sequence: 0, data: { count: 3 } },
        { name: "draft", sequence: 1 }
      ]);
    });
  });

  it("counts only the replies a run added as its own", async () => {
    const { runs, setReply } = setup();
    // A reply that was there before the run started.
    setReply(true);
    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    const transcript = [
      { id: "reply", role: "assistant" },
      { id: "question", role: "user" },
      { id: "answer", role: "assistant" }
    ];
    expect(
      runs.messagesSinceStart("run-1", transcript).map((m) => m.id)
    ).toEqual(["question", "answer"]);
    // With no record of the start, every reply counts.
    expect(
      runs.messagesSinceStart("unknown", transcript).map((m) => m.id)
    ).toEqual(["reply", "question", "answer"]);
  });

  it("admits a recovery unless its run was cancelled, and records why it did not", async () => {
    const { runs, store } = setup();
    const writes: unknown[] = [];
    const update = async (...args: unknown[]) => void writes.push(args);
    store.seed("run-1");
    store.bindRequest("run-1", "req-1");
    const attempt = { incidentId: "incident", originalRequestId: "req-1" };
    expect(await runs.admitRecoveredTurn(attempt, update)).toBe(true);
    expect(await runs.admitRecoveredTurn(undefined, update)).toBe(true);
    runs.cancel("run-1", "stop");
    expect(await runs.admitRecoveredTurn(attempt, update)).toBe(false);
    expect(writes).toEqual([["incident", "skipped", "user_cancelled"]]);
  });

  describe("the run table", () => {
    it("is not created by the lookups every recovered turn makes", () => {
      const { runs, store } = setup();
      let created = false;
      const ensure = store.ensure;
      store.ensure = () => {
        created = true;
        ensure();
      };
      runs.rebind("req-1");
      expect(runs.isRecoveredRunCancelled("req-1")).toBe(false);
      expect(store.listOpen()).toEqual([]);
      expect(created).toBe(false);
    });

    it("adds the columns a table from an older version lacks", () => {
      const db = new DatabaseSync(":memory:");
      db.exec(
        "create table runs (run_id text primary key, request_id text, status text not null, started_at integer not null)"
      );
      db.exec(
        "insert into runs (run_id, request_id, status, started_at) values ('old', 'req-1', 'running', 1)"
      );
      const store = createAgentToolRunStore(
        () => ({
          exec: (query: string, ...bindings: unknown[]) => {
            const rows = db.prepare(query).all(...(bindings as SqlValue[]));
            return { toArray: () => rows as Record<string, unknown>[] };
          }
        }),
        { runs: "runs", milestones: "milestones", requestIndex: "runs_request" }
      );
      expect(store.newestOpen()).toMatchObject({
        runId: "old",
        requestId: "req-1",
        rootRequestId: null,
        streamId: null
      });
      store.bindRequest("old", "req-2");
      // A row from before the column existed takes its next bind as root.
      expect(store.read("old")?.rootRequestId).toBe("req-2");
    });
  });
});
