import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import {
  createAgentToolRunStore,
  type AgentToolRunTerminal
} from "../agent-tool-run-store";
import {
  AgentToolRuns,
  abortReasonText,
  agentToolRunOutcome,
  type AgentToolStreams,
  type AgentToolTurnResult
} from "../agent-tool-runs";
import { CHAT_RECOVERY_INCIDENT_KEY_PREFIX } from "../recovery-incident";

type SqlValue = string | number | null;

/**
 * The real run store on an in-memory SQLite database, plus what the tests
 * read back: the terminal a row holds and how often one was written.
 */
const TABLES = {
  runs: "runs",
  milestones: "milestones",
  requestIndex: "runs_request"
};

/** A store over `db`, counting the statements it runs. */
function storeOn(db: DatabaseSync, failOn?: (query: string) => string | null) {
  let statements = 0;
  const store = createAgentToolRunStore(
    () => ({
      exec: (query: string, ...bindings: unknown[]) => {
        statements++;
        const failure = failOn?.(query);
        if (failure) throw new Error(failure);
        const rows = db.prepare(query).all(...(bindings as SqlValue[]));
        return { toArray: () => rows as Record<string, unknown>[] };
      }
    }),
    TABLES
  );
  return Object.assign(store, { statements: () => statements });
}

/** The names of the tables and indexes in `db`. */
function schemaOf(db: DatabaseSync): string[] {
  return (
    db.prepare("select name from sqlite_master order by name").all() as Array<{
      name: string;
    }>
  )
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

function makeStore() {
  const db = new DatabaseSync(":memory:");
  const store = storeOn(db);
  const writes = new Map<string, number>();
  const writeTerminal = store.writeTerminal;
  store.writeTerminal = (runId, terminal, turn) => {
    writes.set(runId, (writes.get(runId) ?? 0) + 1);
    writeTerminal(runId, terminal, turn);
  };
  return Object.assign(store, {
    /** Insert an open row, as an earlier isolate would have left it. */
    /**
     * Insert an open row, as an earlier isolate would have left it, with
     * its turn started after `startMessageId`.
     */
    seed: (
      runId: string,
      terminalOnly = false,
      startMessageId: string | null = null
    ) => {
      store.insert(runId, { input: "go", startedAt: 1, terminalOnly });
      store.markTurnStarted(runId, 2, startMessageId);
    },
    /** An open row whose turn was still waiting in the queue. */
    seedQueued: (runId: string, requestId: string) => {
      store.insert(runId, { input: "go", startedAt: 1, terminalOnly: false });
      store.bindRequest(runId, requestId);
    },
    writes: (runId: string) => writes.get(runId) ?? 0,
    /** Run SQL against the database directly, past the store. */
    raw: (query: string) => void db.exec(query),
    schema: () => schemaOf(db),
    /** Make the row look like one the previous release wrote: no root. */
    clearRoot: (runId: string) =>
      void db
        .prepare("update runs set root_request_id = null where run_id = ?")
        .run(runId),
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

type Incident = {
  status: string;
  requestId: string;
  recoveryRootRequestId?: string;
  reason?: string;
};

function setup() {
  const store = makeStore();
  const recovered: Array<{ requestId: string; reason: unknown }> = [];
  const broadcasts: Array<{ requestId: string; body: string }> = [];
  const incidents = new Map<string, Incident>();
  const stored = new Map<string, string[]>();
  const streamOf = new Map<string, string>();
  let reply = false;
  let activeRequestId: string | null = null;
  let activeStream: string | null = null;
  let transcript:
    | Array<{ id: string; role: string; parts?: unknown[] }>
    | undefined;
  let holdList: Promise<void> | undefined;
  const lifecycles: Promise<unknown>[] = [];
  let requestIds = 0;
  let flushes = 0;
  // Strict about what it is asked: the real stream store is not asked for
  // a request or a stream that does not exist.
  const streams: AgentToolStreams = {
    flushBuffer: () => void flushes++,
    latestStreamInfoForRequest: (requestId) => {
      if (typeof requestId !== "string") throw new Error("no request id");
      const id = streamOf.get(requestId);
      return id ? { id } : null;
    },
    getStreamChunks: (streamId) => {
      if (typeof streamId !== "string") throw new Error("no stream id");
      return (stored.get(streamId) ?? []).map((body, chunk_index) => ({
        body,
        chunk_index
      }));
    },
    get activeRequestId() {
      return activeStream;
    }
  };
  const collected: unknown[] = [];
  const runs = new AgentToolRuns({
    store,
    streams: () => streams,
    storage: () => ({
      list: (async (options?: { prefix?: string }) => {
        // Only incidents are asked for, never the whole storage.
        if (options?.prefix !== CHAT_RECOVERY_INCIDENT_KEY_PREFIX) {
          throw new Error("listed storage without the incident prefix");
        }
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
    // The first run's turn is "req-1", the next "req-2".
    generateRequestId: () => `req-${++requestIds}`,
    activeRequestId: () => activeRequestId,
    broadcastChunk: (requestId, body) =>
      void broadcasts.push({ requestId, body }),
    collectResult: (_runId, input) => {
      collected.push(input);
      return { output: { ok: true }, summary: "done" };
    },
    messages: () =>
      transcript ?? (reply ? [{ id: "reply", role: "assistant" }] : []),
    cancelRequest: (requestId, reason) =>
      void recovered.push({ requestId, reason })
  });
  return {
    store,
    runs,
    recovered,
    broadcasts,
    collected,
    settled: () => Promise.all(lifecycles),
    /** The state of chat recovery for the turn `requestId` names. */
    setRecovery: (
      state: "in-progress" | "failed" | "cancelled" | "none",
      requestId = "req-1"
    ) => {
      incidents.delete(requestId);
      if (state === "none") return;
      incidents.set(requestId, {
        status:
          state === "in-progress"
            ? "scheduled"
            : state === "cancelled"
              ? "skipped"
              : "exhausted",
        requestId,
        recoveryRootRequestId: requestId,
        ...(state === "cancelled" && { reason: "user_cancelled" })
      });
    },
    /** Put one incident in storage as it is, or remove it. */
    setIncident: (key: string, incident: Incident | undefined) => {
      if (incident) incidents.set(key, incident);
      else incidents.delete(key);
    },
    flushes: () => flushes,
    setTranscript: (
      messages: Array<{ id: string; role: string; parts?: unknown[] }>
    ) => {
      transcript = messages;
    },
    setReply: (value: boolean) => {
      reply = value;
    },
    setActiveRequest: (requestId: string | null) => {
      activeRequestId = requestId;
    },
    setActiveStream: (requestId: string | null) => {
      activeStream = requestId;
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
  let requestId = "";
  let shouldStart: () => boolean = () => true;
  const run = (turn: {
    requestId: string;
    signal: AbortSignal;
    shouldStart?: () => boolean;
  }) => {
    signal = turn.signal;
    requestId = turn.requestId;
    if (turn.shouldStart) shouldStart = turn.shouldStart;
    return new Promise<AgentToolTurnResult>((resolve, reject) => {
      end = resolve;
      fail = reject;
    });
  };
  return {
    run,
    end: (result: AgentToolTurnResult) => end(result),
    fail: (error: unknown) => fail(error),
    signal: () => signal,
    /** The request id the core bound the run's turn to. */
    requestId: () => requestId,
    /** What the turn asks when it reaches the front of the queue. */
    shouldStart: () => shouldStart()
  };
}

const START = { input: "go", terminalOnly: false };

describe("agentToolRunOutcome", () => {
  const base = { resetError: "cleared" };

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

  it("records a turn something else aborted as aborted", () => {
    expect(
      agentToolRunOutcome({ ...base, turn: { status: "aborted" } })
    ).toEqual({ status: "aborted", error: null });
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
    runs.rebind("req-2", "req-1");

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

  it("records a turn the chat was reset under as an error", async () => {
    const { runs, store, settled } = setup();
    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    // What the turn core reports for a reset, queued or running.
    turn.end({ requestId: "req-1", status: "skipped" });
    await settled();
    expect(store.terminal("run-1")).toEqual({
      status: "error",
      error: "cleared"
    });
  });

  it("records a turn that threw as an error", async () => {
    const failed = setup();
    const turn = heldTurn();
    await failed.runs.start("run-1", START, turn.run);
    turn.fail(new Error("boom"));
    await failed.settled();
    expect(failed.store.terminal("run-1")).toEqual({
      status: "error",
      error: "boom"
    });
  });

  it("binds the turn's request id and rebinds a recovered turn's", async () => {
    const { runs, store } = setup();
    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    runs.bindTurn("run-1", "req-1");
    expect(runs.runForRequest("req-1")).toBe("run-1");
    expect(runs.runForRequest("other")).toBe(null);

    runs.rebind("req-2", "req-1");
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
    runs.rebind("req-2", "req-1");
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
    store.bindRequest("run-1", "req-1");
    setRecovery("in-progress");
    await runs.reconcileOwn();
    expect(store.read("run-1")?.status).toBe("running");
  });

  it("a reconcile does not replace a cancel that landed while it read recovery state", async () => {
    const { runs, store, holdRecoveryRead } = setup();
    store.seed("run-1");
    store.bindRequest("run-1", "req-1");
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
    const runTurn = (admitted: { requestId: string; signal: AbortSignal }) => {
      turns++;
      return turn.run(admitted);
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

    it("delivers the backlog when the run ends while the backlog is read", async () => {
      const { runs, settled, storeChunks } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      storeChunks("req-1", ["a", "b"]);
      runs.liveSequences.set("run-1", 2);

      const stream = runs.tail("run-1", undefined, {
        chunks: async (runId, options) => {
          // The run's last chunk is broadcast and the run ends, all while
          // the tail waits for its backlog.
          runs.intercept(frame("req-1", "c"));
          turn.end({ requestId: "req-1", status: "completed" });
          await settled();
          return runs.chunks(runId, options);
        }
      });
      expect(await readAll(stream)).toEqual([
        { sequence: 0, body: "a" },
        { sequence: 1, body: "b" },
        { sequence: 2, body: "c" }
      ]);
      expect(runs.forwarders.size).toBe(0);
    });

    it("stops at once, backlog included, when the consumer's signal aborts", async () => {
      const { runs, storeChunks } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      storeChunks("req-1", ["a", "b"]);
      const abort = new AbortController();
      const stream = runs.tail(
        "run-1",
        { signal: abort.signal },
        {
          chunks: async (runId, options) => {
            abort.abort();
            return runs.chunks(runId, options);
          }
        }
      );
      expect(await readAll(stream)).toEqual([]);
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

    it("a tail of a run that has ended leaves no closer behind", async () => {
      const { runs, store } = setup();
      store.seed("run-1");
      runs.cancel("run-1", "stop");
      for (let i = 0; i < 3; i++) await readAll(runs.tail("run-1"));
      expect(runs.closers.size).toBe(0);
    });

    it("a consumer that cancels the stream detaches and does not cancel the run", async () => {
      const { runs, store } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      const reader = runs.tail("run-1").getReader();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(runs.forwarders.get("run-1")?.size).toBe(1);
      await reader.cancel();
      expect(runs.closers.size).toBe(0);
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

  describe("a cancel is recorded as a cancel", () => {
    it("the parent's signal cancels the run at once, with its reason, whatever the stream said", async () => {
      const { runs, store, settled } = setup();
      const parent = new AbortController();
      const turn = heldTurn();
      await runs.start("run-1", { ...START, signal: parent.signal }, turn.run);
      runs.bindTurn("run-1", "req-1");
      // The run's stream reports an error, then the parent stops the run.
      runs.intercept(
        JSON.stringify({
          type: "response",
          id: "req-1",
          body: "provider failed",
          error: true
        })
      );
      parent.abort(new Error("parent stopped"));

      expect(turn.signal()?.aborted).toBe(true);
      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: "parent stopped"
      });
      expect(store.read("run-1")?.cancelledAt).toBeTypeOf("number");

      turn.end({
        requestId: "req-1",
        status: "error",
        error: "provider failed"
      });
      await settled();
      expect(store.read("run-1")?.status).toBe("aborted");
      expect(store.writes("run-1")).toBe(1);
    });

    it("a signal that is already aborted cancels the run without queueing its turn", async () => {
      const { runs, store, settled } = setup();
      const parent = new AbortController();
      parent.abort("too late");
      let queued = false;
      const inspection = await runs.start(
        "run-1",
        { ...START, signal: parent.signal },
        async () => {
          queued = true;
          return { requestId: "req-1", status: "completed" };
        }
      );
      await settled();
      expect(inspection.status).toBe("running");
      expect(queued).toBe(false);
      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: "too late"
      });
      expect(runs.isLive("run-1")).toBe(false);
      expect(runs.liveSequences.size).toBe(0);
    });

    it("a run aborted by something else is not a cancelled run", async () => {
      const { runs, store, settled } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      // A stop of the request, not of the run: no recovery is working.
      turn.end({ requestId: "req-1", status: "aborted" });
      await settled();
      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: null
      });
      expect(store.read("run-1")?.cancelledAt).toBe(null);
      expect(runs.isRecoveredRunCancelled("req-1")).toBe(false);
    });
  });

  describe("a run whose stream is cut off in this isolate", () => {
    it("ends with the reset's error when the chat is cleared while recovery has it", async () => {
      const { runs, store, settled, setRecovery } = setup();
      let closed = 0;
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      runs.closers.set("run-1", new Set([() => void closed++]));
      setRecovery("in-progress");
      turn.end({
        requestId: "req-1",
        status: "aborted",
        reason: "interrupted"
      });
      await settled();
      expect(store.read("run-1")?.status).toBe("running");

      runs.chatReset();

      expect(store.terminal("run-1")).toEqual({
        status: "error",
        error: "cleared"
      });
      expect(closed).toBe(1);
    });

    it("stays open while recovery works on its turn, and is settled when recovery ends", async () => {
      const { runs, store, settled, setRecovery, setTranscript } = setup();
      let closed = 0;
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      runs.closers.set("run-1", new Set([() => void closed++]));
      // The reply path scheduled recovery and handed back `aborted`.
      setRecovery("in-progress");
      turn.end({
        requestId: "req-1",
        status: "aborted",
        reason: "interrupted"
      });
      await settled();

      expect(store.read("run-1")?.status).toBe("running");
      expect(store.writes("run-1")).toBe(0);
      // Its controller is gone; its tail and counters are kept.
      expect(runs.isLive("run-1")).toBe(false);
      expect(closed).toBe(0);
      expect(runs.liveSequences.has("run-1")).toBe(true);

      // The recovered turn runs under a new request id.
      runs.rebind("req-2", "req-1");
      expect(runs.runForRequest("req-2")).toBe("run-1");
      expect(
        await runs.admitRecoveredTurn(
          { originalRequestId: "req-1" },
          async () => {}
        )
      ).toBe(true);

      // Recovery ends: the incident is gone and a reply is stored.
      setRecovery("none");
      setTranscript([{ id: "answer", role: "assistant" }]);
      await runs.reconcileOwn();
      expect(store.terminal("run-1")).toEqual({
        status: "completed",
        output: { ok: true },
        summary: "done"
      });
      expect(closed).toBe(1);
      expect(runs.liveSequences.size).toBe(0);
      expect(runs.runsByRequestId.size).toBe(0);
    });

    it("can still be cancelled, by the request ids on its row", async () => {
      const { runs, store, settled, setRecovery, recovered } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.bindTurn("run-1", "req-1");
      setRecovery("in-progress");
      turn.end({
        requestId: "req-1",
        status: "aborted",
        reason: "interrupted"
      });
      await settled();

      runs.cancel("run-1", "stop");
      expect(recovered).toEqual([{ requestId: "req-1", reason: "stop" }]);
      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: "stop"
      });
      expect(runs.isRecoveredRunCancelled("req-1")).toBe(true);
    });
  });

  // A run left open for recovery has no controller and no turn in flight.
  // What ends it is the recovered turn, or a stop.
  describe("a stop on the agent, for a run left open for recovery", () => {
    async function leftOpen() {
      const context = setup();
      const turn = heldTurn();
      await context.runs.start("run-1", START, turn.run);
      context.setRecovery("in-progress");
      turn.end({
        requestId: "req-1",
        status: "aborted",
        reason: "interrupted"
      });
      await context.settled();
      expect(context.store.read("run-1")?.status).toBe("running");
      return context;
    }

    it("a stop of the run's request settles the run aborted, with the reason, and closes its tails", async () => {
      const { runs, store, recovered } = await leftOpen();
      let closed = 0;
      runs.closers.set("run-1", new Set([() => void closed++]));

      runs.stopped("req-1", "user pressed stop");

      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: "user pressed stop"
      });
      expect(closed).toBe(1);
      expect(runs.liveSequences.size).toBe(0);
      expect(runs.runsByRequestId.size).toBe(0);
      // The run's request is stopped through the host, once.
      expect(recovered).toEqual([
        { requestId: "req-1", reason: "user pressed stop" }
      ]);
      // A recovery that still fires for the turn is not run.
      expect(runs.isRecoveredRunCancelled("req-1")).toBe(true);
    });

    it("a stop of the recovered turn's request does the same", async () => {
      const { runs, store } = await leftOpen();
      runs.rebind("req-2", "req-1");
      runs.stopped("req-2");
      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: null
      });
    });

    it("a stop of every request settles every open run", async () => {
      const { runs, store } = await leftOpen();
      store.seed("run-2");
      runs.stopped(null, "stop all");
      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: "stop all"
      });
      expect(store.terminal("run-2")).toEqual({
        status: "aborted",
        error: "stop all"
      });
    });

    it("a stop of another request leaves the run alone", async () => {
      const { runs, store, recovered } = await leftOpen();
      runs.stopped("someone-else");
      expect(store.read("run-1")?.status).toBe("running");
      expect(recovered).toEqual([]);
    });

    it("a stop that comes back through the host's stop path does not loop", async () => {
      const { runs, store, recovered } = await leftOpen();
      // The host's cancelRequest stops the request, which reports the stop.
      const push = recovered.push.bind(recovered);
      recovered.push = (entry) => {
        runs.stopped(entry.requestId, entry.reason);
        return push(entry);
      };
      runs.cancel("run-1", "stop");
      expect(recovered).toHaveLength(1);
      expect(store.writes("run-1")).toBe(1);
    });

    it("is aborted, not completed, when its recovery was cancelled and nothing told the run", async () => {
      const { runs, store, setRecovery, setReply } = await leftOpen();
      // The cut-off partial is in the transcript.
      setReply(true);
      setRecovery("cancelled");
      await runs.reconcileOwn();
      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: null
      });
    });
  });

  it("ends a run whose turn is handed to recovery after a cancel already settled it", async () => {
    const { runs, store, settled } = setup();
    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    runs.cancel("run-1", "stop");
    turn.end({ requestId: "req-1", status: "aborted", reason: "interrupted" });
    await settled();
    expect(store.terminal("run-1")).toEqual({
      status: "aborted",
      error: "stop"
    });
    expect(runs.liveSequences.size).toBe(0);
    expect(runs.preTurnAssistantIds.size).toBe(0);
    expect(runs.runsByRequestId.size).toBe(0);
  });

  it("ends a run whose turn was stopped by something else, with no recovery behind it", async () => {
    const { runs, store, settled, setRecovery } = setup();
    const turn = heldTurn();
    await runs.start("run-1", START, turn.run);
    // An incident for the request does not make a stopped turn recoverable.
    setRecovery("in-progress");
    turn.end({ requestId: "req-1", status: "aborted", reason: "stopped" });
    await settled();
    expect(store.terminal("run-1")).toEqual({ status: "aborted", error: null });
  });

  describe("the parent's signal", () => {
    it("still cancels a run that was left open for recovery", async () => {
      const { runs, store, settled, setRecovery, recovered } = setup();
      const parent = new AbortController();
      const turn = heldTurn();
      await runs.start("run-1", { ...START, signal: parent.signal }, turn.run);
      runs.bindTurn("run-1", "req-1");
      setRecovery("in-progress");
      turn.end({
        requestId: "req-1",
        status: "aborted",
        reason: "interrupted"
      });
      await settled();
      expect(store.read("run-1")?.status).toBe("running");

      parent.abort("stop");
      expect(recovered).toEqual([{ requestId: "req-1", reason: "stop" }]);
      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: "stop"
      });
    });

    it("is let go once the run has ended", async () => {
      const { runs, store, settled } = setup();
      const parent = new AbortController();
      let removed = 0;
      const remove = parent.signal.removeEventListener.bind(parent.signal);
      parent.signal.removeEventListener = ((
        ...args: Parameters<typeof remove>
      ) => {
        removed++;
        remove(...args);
      }) as typeof remove;
      const turn = heldTurn();
      await runs.start("run-1", { ...START, signal: parent.signal }, turn.run);
      turn.end({ requestId: "req-1", status: "completed" });
      await settled();
      expect(removed).toBe(1);
      parent.abort("late");
      expect(store.read("run-1")?.status).toBe("completed");
    });
  });

  describe("an agent that also serves its own users", () => {
    it("does not bind a run to the recovery of another turn", () => {
      const { runs, store } = setup();
      store.seed("run-1");
      store.bindRequest("run-1", "req-1");
      // A user's turn is recovered. Its root id is not on the run's row.
      runs.rebind("users-new-request", "users-request");
      expect(store.read("run-1")?.requestId).toBe("req-1");
      expect(runs.runForRequest("users-new-request")).toBe(null);
      // Nor is a turn that is not a recovery at all.
      runs.rebind("another-request", undefined);
      expect(store.read("run-1")?.requestId).toBe("req-1");
    });

    it("does not hold a stale run open for another turn's recovery or stream", async () => {
      const { runs, store, setRecovery, setActiveStream } = setup();
      store.seed("run-1");
      store.bindRequest("run-1", "req-1");
      setRecovery("in-progress", "users-request");
      setActiveStream("users-request");
      await runs.reconcileStale("run-1");
      expect(store.read("run-1")?.status).toBe("error");
    });

    it("holds it open while its own turn's stream is active", async () => {
      const { runs, store, setActiveStream } = setup();
      store.seed("run-1");
      store.bindRequest("run-1", "req-1");
      setActiveStream("req-1");
      await runs.reconcileStale("run-1");
      expect(store.read("run-1")?.status).toBe("running");
    });

    it("does not count a reply that was there before the run as the run's, after a restart", async () => {
      const { runs, store, setTranscript } = setup();
      // The run started after the user's last reply, in an earlier isolate.
      store.seed("run-1", false, "users-answer");
      store.bindRequest("run-1", "req-1");
      const before = [
        { id: "users-question", role: "user" },
        { id: "users-answer", role: "assistant" }
      ];
      setTranscript(before);
      expect(runs.messagesSinceStart("run-1", before)).toEqual([]);
      await runs.reconcileStale("run-1");
      expect(store.terminal("run-1")).toEqual({
        status: "error",
        error: "Agent tool run was interrupted before the child could finish."
      });
    });

    it("does not anchor a run on an empty reply, which its own turn removes", async () => {
      const { runs, store, setTranscript } = setup();
      setTranscript([
        { id: "users-question", role: "user", parts: [{}] },
        { id: "users-answer", role: "assistant", parts: [{}] },
        { id: "empty", role: "assistant", parts: [] }
      ]);
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      turn.shouldStart();
      expect(store.read("run-1")?.startMessageId).toBe("users-answer");

      // The isolate goes away. The run's turn had removed the empty reply
      // and stored nothing of its own.
      runs.controllers.delete("run-1");
      runs.closeTailers("run-1");
      const after = [
        { id: "users-question", role: "user" },
        { id: "users-answer", role: "assistant" }
      ];
      setTranscript(after);
      expect(runs.messagesSinceStart("run-1", after)).toEqual([]);
      await runs.reconcileStale("run-1");
      // Not completed with the user's earlier answer as its output.
      expect(store.terminal("run-1")).toEqual({
        status: "error",
        error: "Agent tool run was interrupted before the child could finish."
      });
    });

    for (const [label, parts] of [
      ["only step-start", [{ type: "step-start" }]],
      [
        "reasoning with nothing after it",
        [{ type: "step-start" }, { type: "reasoning", text: "thinking" }]
      ],
      ["only an empty text part", [{ type: "text", text: "" }]]
    ] as Array<[string, unknown[]]>) {
      it(`does not anchor a run on a reply of ${label}, which its own turn removes`, async () => {
        const { runs, store, setTranscript } = setup();
        setTranscript([
          { id: "users-question", role: "user", parts: [{}] },
          { id: "users-answer", role: "assistant", parts: [{}] },
          { id: "empty", role: "assistant", parts }
        ]);
        const turn = heldTurn();
        await runs.start("run-1", START, turn.run);
        turn.shouldStart();
        expect(store.read("run-1")?.startMessageId).toBe("users-answer");
      });
    }

    it("counts what follows the run's start as the run's, after a restart", async () => {
      const { runs, store, setTranscript } = setup();
      store.seed("run-1", false, "users-answer");
      setTranscript([
        { id: "users-answer", role: "assistant" },
        { id: "run-input", role: "user" },
        { id: "run-answer", role: "assistant" }
      ]);
      await runs.reconcileStale("run-1");
      expect(store.read("run-1")?.status).toBe("completed");
    });
  });

  describe("the run table", () => {
    it("is not created by the lookups every recovered turn makes", () => {
      const { runs, store } = setup();
      runs.rebind("req-2", "req-1");
      expect(runs.isRecoveredRunCancelled("req-1")).toBe(false);
      expect(store.listOpen()).toEqual([]);
      runs.stopped("req-1");
      expect(store.schema()).toEqual([]);
    });

    it("does not hide a failing query as an unknown run", () => {
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
      store.ensure();
      db.exec("drop table runs");
      expect(() => store.read("any-run")).toThrow();
      expect(() => store.openForRequest("any-request")).toThrow();
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
      expect(store.forRequest("req-1")).toMatchObject({
        runId: "old",
        requestId: "req-1",
        rootRequestId: null,
        streamId: null,
        cancelledAt: null,
        startMessageId: null
      });
      // A row from before the column existed takes the root its next bind
      // names: the id the turn first ran under, not the recovered turn's.
      store.bindRequest("old", "req-2", "req-1");
      expect(store.read("old")).toMatchObject({
        requestId: "req-2",
        rootRequestId: "req-1"
      });
      // A later bind leaves it alone.
      store.bindRequest("old", "req-3", "req-9");
      expect(store.read("old")?.rootRequestId).toBe("req-1");
    });

    it("a run started before rows had a root is still found by its first request id after a recovery", () => {
      const { runs, store, recovered } = setup();
      store.seed("old");
      // What the previous release wrote: the request id, and no root.
      store.bindRequest("old", "X");
      store.clearRoot("old");

      // First recovery after the upgrade. Recovery names the turn "X".
      runs.rebind("Y", "X");
      expect(store.read("old")).toMatchObject({
        requestId: "Y",
        rootRequestId: "X"
      });
      // A second recovered turn is bound too, so its frames reach the parent.
      runs.rebind("Z", "X");
      expect(store.read("old")?.requestId).toBe("Z");
      // A cancel reaches the recovery, which is registered under "X"...
      runs.cancel("old", "stop");
      expect(recovered.map((entry) => entry.requestId).sort()).toEqual([
        "X",
        "Z"
      ]);
      // ...and a recovery that still fires for "X" is not run.
      expect(runs.isRecoveredRunCancelled("X")).toBe(true);
    });
  });
});

// Each test here pins one rule that nothing else did (found by mutation
// testing): a wrong answer would settle a run early, report it wrongly, or
// leave a parent waiting.
describe("AgentToolRuns, rule by rule", () => {
  const decoder = new TextDecoder();
  const frame = (requestId: string, body: string) =>
    JSON.stringify({ type: "response", id: requestId, body });
  /** Read what a tail has delivered so far, without waiting for its end. */
  function collect(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const bodies: string[] = [];
    let ended = false;
    let failure: unknown;
    const done = (async () => {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          for (const line of decoder.decode(next.value).split("\n")) {
            if (line) bodies.push((JSON.parse(line) as { body: string }).body);
          }
        }
      } catch (error) {
        failure = error;
      }
      ended = true;
    })();
    return {
      bodies,
      ended: () => ended,
      failure: () => failure,
      done,
      cancel: () => reader.cancel()
    };
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  describe("the outcome of a turn", () => {
    it("is an error for a turn that failed without saying why", () => {
      expect(
        agentToolRunOutcome({
          turn: { status: "error" },
          resetError: "cleared"
        })
      ).toEqual({
        status: "error",
        error: "Agent tool run failed during streaming."
      });
    });

    it("gives an abort reason as text, and none as null", () => {
      expect(abortReasonText(undefined)).toBeNull();
      expect(abortReasonText(null)).toBeNull();
      expect(abortReasonText("stop")).toBe("stop");
      expect(abortReasonText(new Error("gave up"))).toBe("gave up");
    });
  });

  describe("starting a run", () => {
    it("anchors on the only message, and on a user message with no parts", async () => {
      const one = setup();
      one.setTranscript([{ id: "only", role: "assistant", parts: [{}] }]);
      const first = heldTurn();
      await one.runs.start("run-1", START, first.run);
      first.shouldStart();
      expect(one.store.read("run-1")?.startMessageId).toBe("only");

      const user = setup();
      user.setTranscript([
        { id: "answer", role: "assistant", parts: [{}] },
        { id: "empty-question", role: "user", parts: [] }
      ]);
      const second = heldTurn();
      await user.runs.start("run-1", START, second.run);
      second.shouldStart();
      expect(user.store.read("run-1")?.startMessageId).toBe("empty-question");

      // A host whose messages carry no parts list.
      const bare = setup();
      bare.setTranscript([{ id: "answer", role: "assistant" }]);
      const third = heldTurn();
      await bare.runs.start("run-1", START, third.run);
      third.shouldStart();
      expect(bare.store.read("run-1")?.startMessageId).toBe("answer");
    });

    it("takes what is in the transcript when its turn starts, not when it was queued, as there before it", async () => {
      const { runs, store, setTranscript } = setup();
      setTranscript([{ id: "q1", role: "user", parts: [{}] }]);
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      expect(store.read("run-1")).toMatchObject({
        turnStartedAt: null,
        startMessageId: null
      });
      // Another turn replies while the run's turn waits in the queue.
      const whileQueued = [
        { id: "q1", role: "user", parts: [{}] },
        { id: "other-turns-answer", role: "assistant", parts: [{}] }
      ];
      setTranscript(whileQueued);
      expect(turn.shouldStart()).toBe(true);
      expect(store.read("run-1")?.startMessageId).toBe("other-turns-answer");
      expect(store.read("run-1")?.turnStartedAt).toEqual(expect.any(Number));
      expect(runs.messagesSinceStart("run-1", whileQueued)).toEqual([
        whileQueued[0]
      ]);
      // Asked again (the host asks before and after it works the messages
      // out): the first answer stands.
      setTranscript([
        ...whileQueued,
        { id: "later", role: "user", parts: [{}] }
      ]);
      const startedAt = store.read("run-1")?.turnStartedAt;
      store.markTurnStarted("run-1", 999_999_999_999_999, "later");
      expect(store.read("run-1")).toMatchObject({
        startMessageId: "other-turns-answer",
        turnStartedAt: startedAt
      });
    });

    it("does not mark the turn of a cancelled run as started", async () => {
      const { runs, store } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      runs.cancel("run-1");
      expect(turn.shouldStart()).toBe(false);
      expect(store.read("run-1")?.turnStartedAt).toBeNull();
    });

    it("tells the turn whether it may still start", async () => {
      const { runs } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      expect(turn.shouldStart()).toBe(true);
      runs.cancel("run-1");
      expect(turn.shouldStart()).toBe(false);
    });

    it("lets the parent's signal go when the run ends", async () => {
      const { runs, settled } = setup();
      const parent = new AbortController();
      const removed: unknown[][] = [];
      const remove = parent.signal.removeEventListener.bind(parent.signal);
      parent.signal.removeEventListener = ((...args: unknown[]) => {
        removed.push(args);
        return (remove as (...a: unknown[]) => void)(...args);
      }) as typeof parent.signal.removeEventListener;
      const turn = heldTurn();
      await runs.start("run-1", { ...START, signal: parent.signal }, turn.run);
      turn.end({ requestId: "req-1", status: "completed" });
      await settled();
      expect(removed).toHaveLength(1);
      expect(removed[0][0]).toBe("abort");
      expect(runs.parentSignals.size).toBe(0);
    });

    it("settles a completed turn as completed, whatever recovery state its request has", async () => {
      const { runs, store, settled, setRecovery } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      setRecovery("in-progress");
      turn.end({ requestId: "req-1", status: "completed" });
      await settled();
      expect(store.read("run-1")?.status).toBe("completed");
    });

    it("counts a row an older version left as `starting` as open", () => {
      const { runs, store } = setup();
      store.seed("run-1");
      store.raw("update runs set status = 'starting' where run_id = 'run-1'");
      runs.cancel("run-1", "stop");
      expect(store.terminal("run-1")).toEqual({
        status: "aborted",
        error: "stop"
      });
    });

    it("exposes the run table", () => {
      const { runs, store } = setup();
      expect(runs.store).toBe(store);
    });
  });

  describe("frames", () => {
    it("keeps a terminal-only run's chunks from being broadcast, and no other frame", async () => {
      const { runs } = setup();
      await runs.start(
        "quiet",
        { ...START, terminalOnly: true },
        heldTurn().run
      );
      await runs.start("loud", START, heldTurn().run);
      expect(runs.intercept(frame("req-1", "a"))).toBe(true);
      expect(runs.intercept(frame("req-2", "a"))).toBe(false);
      expect(runs.intercept(frame("someone-else", "a"))).toBe(false);
      expect(runs.intercept(new Uint8Array([1]))).toBe(false);
    });

    it("knows a terminal-only run from its row after a restart", async () => {
      const { runs, store } = setup();
      store.seed("quiet", true);
      store.bindRequest("quiet", "req-q");
      // Another run is in flight, so frames are looked at.
      await runs.start("loud", START, heldTurn().run);
      expect(runs.intercept(frame("req-q", "a"))).toBe(true);

      const recovered = setup();
      recovered.store.seed("quiet", true);
      recovered.store.bindRequest("quiet", "req-q");
      recovered.runs.rebind("req-9", "req-q");
      expect(recovered.runs.intercept(frame("req-9", "a"))).toBe(true);

      const plain = setup();
      plain.store.seed("loud");
      plain.store.bindRequest("loud", "req-q");
      plain.runs.rebind("req-9", "req-q");
      plain.runs.liveSequences.set("loud", 0);
      expect(plain.runs.intercept(frame("req-9", "a"))).toBe(false);
    });

    it("asks the row for a request once, and remembers either answer", () => {
      const { runs, store } = setup();
      store.seed("run-1");
      store.bindRequest("run-1", "req-1");
      let asked = 0;
      const openForRequest = store.openForRequest;
      store.openForRequest = (requestId) => {
        asked++;
        return openForRequest(requestId);
      };
      expect(runs.runForRequest("req-1")).toBe("run-1");
      expect(runs.runForRequest("req-1")).toBe("run-1");
      expect(runs.runForRequest("nobody")).toBeNull();
      expect(runs.runForRequest("nobody")).toBeNull();
      expect(asked).toBe(2);
    });
  });

  describe("recovery admission", () => {
    it("admits an attempt that carries no schedule payload", async () => {
      const { runs } = setup();
      await expect(
        runs.admitRecoveredTurn(undefined, async () => {
          throw new Error("no incident to update");
        })
      ).resolves.toBe(true);
    });
  });

  describe("what is kept in memory", () => {
    it("keeps the request mapping of a run left open for recovery when another run's state is dropped", async () => {
      const { runs, store, settled, setRecovery } = setup();
      const turn = heldTurn();
      await runs.start("left-open", START, turn.run);
      setRecovery("in-progress");
      turn.end({
        requestId: "req-1",
        status: "aborted",
        reason: "interrupted"
      });
      await settled();
      expect(runs.isLive("left-open")).toBe(false);

      store.seed("stale");
      runs.closeTailers("stale");
      expect(runs.runForRequest("req-1")).toBe("left-open");
      expect([...runs.runsByRequestId.keys()]).toEqual(["req-1"]);
    });

    it("forgets a live run's input when the run ends: a later read uses the stored copy", async () => {
      const { runs, store, collected, settled } = setup();
      const input = { when: new Date(0) };
      const turn = heldTurn();
      await runs.start("run-1", { ...START, input }, turn.run);
      turn.end({ requestId: "req-1", status: "completed" });
      await settled();
      expect(collected.at(-1)).toBe(input);
      // A completed row an older version wrote holds no output: it is
      // collected again when the parent reads it.
      store.raw("update runs set output_json = null where run_id = 'run-1'");
      await runs.inspect("run-1");
      expect(collected.at(-1)).toEqual({ when: "1970-01-01T00:00:00.000Z" });
    });

    it("closing the tails of a live run keeps its counters", async () => {
      const { runs } = setup();
      await runs.start("run-1", START, heldTurn().run);
      runs.intercept(frame("req-1", "a"));
      runs.closeTailers("run-1");
      expect(runs.liveSequences.get("run-1")).toBe(1);
      expect(runs.runForRequest("req-1")).toBe("run-1");
    });

    it("a run that ends takes its own request mapping with it and leaves another run's", async () => {
      const { runs } = setup();
      const first = heldTurn();
      await runs.start("run-1", START, first.run);
      const second = heldTurn();
      await runs.start("run-2", START, second.run);
      // A turn that is no run's, resolved while both runs are in flight.
      expect(runs.runForRequest("someone-else")).toBeNull();
      runs.intercept(
        JSON.stringify({
          type: "response",
          id: "req-1",
          body: "x",
          error: true
        })
      );
      expect(runs.lastErrors.size).toBe(1);

      first.end({ requestId: "req-1", status: "completed" });
      await tick();
      expect([...runs.runsByRequestId]).toEqual([
        ["req-2", "run-2"],
        ["someone-else", null]
      ]);
      expect(runs.lastErrors.size).toBe(0);

      runs.cancel("run-2");
      second.end({ requestId: "req-2", status: "aborted" });
      await tick();
      // No run is left: the answers cached for other turns go too.
      expect(runs.runsByRequestId.size).toBe(0);
    });
  });

  describe("the run's own part of the transcript", () => {
    const transcript = [
      { id: "q1", role: "user" },
      { id: "a1", role: "assistant" },
      { id: "q2", role: "user" },
      { id: "a2", role: "assistant" }
    ];

    it("for a live run, drops the replies that were there before it and keeps the rest", async () => {
      const { runs, setTranscript } = setup();
      setTranscript(transcript.slice(0, 2));
      await runs.start("run-1", START, heldTurn().run);
      expect(
        runs.messagesSinceStart("run-1", transcript).map((m) => m.id)
      ).toEqual(["q1", "q2", "a2"]);
    });

    it("after a restart, is what follows the anchor", () => {
      const { runs, store } = setup();
      store.seed("first", false, "q1");
      store.seed("middle", false, "a1");
      store.seed("gone", false, "deleted-since");
      store.seed("none");
      const ids = (runId: string) =>
        runs.messagesSinceStart(runId, transcript).map((m) => m.id);
      expect(ids("first")).toEqual(["a1", "q2", "a2"]);
      expect(ids("middle")).toEqual(["q2", "a2"]);
      expect(ids("gone")).toEqual(["q1", "a1", "q2", "a2"]);
      expect(ids("none")).toEqual(["q1", "a1", "q2", "a2"]);
    });
  });

  describe("reconciling a stale run", () => {
    it("does nothing for a run that does not exist", async () => {
      const { runs, store } = setup();
      await expect(runs.reconcileStale("nobody")).resolves.toBeUndefined();
      expect(store.schema()).not.toEqual(["nothing"]);
      expect(store.read("nobody")).toBeNull();
    });

    it("leaves a run that is live here alone", async () => {
      const { runs, store } = setup();
      await runs.start("run-1", START, heldTurn().run);
      await runs.reconcileStale("run-1");
      await runs.reconcileOwn();
      expect(store.read("run-1")?.status).toBe("running");
      expect(store.writes("run-1")).toBe(0);
    });

    it("sees a recovered turn that was bound while it read recovery state", async () => {
      const { runs, store, holdRecoveryRead, setActiveStream } = setup();
      store.seed("run-1");
      store.bindRequest("run-1", "req-1");
      const release = holdRecoveryRead();
      const reconciling = runs.reconcileStale("run-1");
      // The recovered turn starts streaming under a new request id.
      runs.rebind("req-2", "req-1");
      setActiveStream("req-2");
      release();
      await reconciling;
      expect(store.read("run-1")?.status).toBe("running");
    });

    it("is an error that says so for a run whose turn was still queued, whatever another turn stored since", async () => {
      const { runs, store, setTranscript } = setup();
      store.seedQueued("run-1", "req-1");
      // The other turn on the agent was recovered and replied.
      setTranscript([
        { id: "q", role: "user" },
        { id: "other-turns-answer", role: "assistant" }
      ]);
      await runs.reconcileStale("run-1");
      expect(store.terminal("run-1")).toEqual({
        status: "error",
        error:
          "Agent tool run was interrupted while its turn was still waiting to start. Nothing of it was stored, so there was nothing to recover. Run it again."
      });
    });

    it("takes a row from before turns were marked as started as started", async () => {
      // No root request id: the previous release wrote it.
      const legacy = setup();
      legacy.store.insert("run-1", {
        input: "go",
        startedAt: 1,
        terminalOnly: false
      });
      legacy.store.raw(
        "update runs set request_id = 'X' where run_id = 'run-1'"
      );
      legacy.setReply(true);
      await legacy.runs.reconcileStale("run-1");
      expect(legacy.store.read("run-1")?.status).toBe("completed");

      // The same row, recovered once after the upgrade: it has a root now,
      // and a recovered turn did start.
      const recovered = setup();
      recovered.store.insert("run-1", {
        input: "go",
        startedAt: 1,
        terminalOnly: false
      });
      recovered.store.raw(
        "update runs set request_id = 'X' where run_id = 'run-1'"
      );
      recovered.runs.rebind("Y", "X");
      expect(recovered.store.read("run-1")?.turnStartedAt).toEqual(
        expect.any(Number)
      );
      recovered.setReply(true);
      await recovered.runs.reconcileStale("run-1");
      expect(recovered.store.read("run-1")?.status).toBe("completed");
    });

    it("needs an assistant reply since the start to call the run completed", async () => {
      const { runs, store, setTranscript } = setup();
      store.seed("run-1");
      setTranscript([{ id: "the-input", role: "user" }]);
      await runs.reconcileStale("run-1");
      expect(store.read("run-1")?.status).toBe("error");
    });

    // The state of chat recovery for the run's turn decides whether the run
    // is still being worked on, was given up, or was stopped.
    describe("by the state of its turn's recovery", () => {
      async function reconciled(
        incident: {
          status: string;
          requestId: string;
          recoveryRootRequestId?: string;
          reason?: string;
        },
        bind: (context: ReturnType<typeof setup>) => void = () => {}
      ) {
        const context = setup();
        context.store.seed("run-1");
        context.store.bindRequest("run-1", "req-1");
        bind(context);
        // The cut-off partial is in the transcript.
        context.setReply(true);
        context.setIncident("incident", incident);
        await context.runs.reconcileStale("run-1");
        return context.store.read("run-1")?.status;
      }

      for (const status of ["detected", "scheduled", "attempting"]) {
        it(`stays open while an incident is ${status}`, async () => {
          expect(await reconciled({ status, requestId: "req-1" })).toBe(
            "running"
          );
        });
      }

      for (const status of ["exhausted", "failed"]) {
        it(`is an error, not completed with the partial, once recovery ${status === "failed" ? "failed" : "is exhausted"}`, async () => {
          expect(await reconciled({ status, requestId: "req-1" })).toBe(
            "error"
          );
        });
      }

      it("is completed when the incident of its turn is over for another reason", async () => {
        expect(
          await reconciled({
            status: "skipped",
            requestId: "req-1",
            reason: "continued_by_interaction"
          })
        ).toBe("completed");
        expect(
          await reconciled({ status: "completed", requestId: "req-1" })
        ).toBe("completed");
      });

      it("finds an incident that names the turn only by its root request id", async () => {
        // After a second eviction: the incident's own request id is the
        // first recovered turn's, which the row no longer names.
        expect(
          await reconciled(
            {
              status: "scheduled",
              requestId: "req-2",
              recoveryRootRequestId: "req-1"
            },
            ({ runs }) => runs.rebind("req-3", "req-1")
          )
        ).toBe("running");
      });

      it("finds an incident that names the recovered turn's own request id", async () => {
        expect(
          await reconciled(
            {
              status: "scheduled",
              requestId: "req-2",
              recoveryRootRequestId: "some-other-root"
            },
            ({ runs }) => runs.rebind("req-2", "req-1")
          )
        ).toBe("running");
      });

      it("is not held, failed or stopped by another turn's incident", async () => {
        for (const incident of [
          {
            status: "attempting",
            requestId: "other",
            recoveryRootRequestId: "other"
          },
          { status: "exhausted", requestId: "other" },
          { status: "skipped", requestId: "other", reason: "user_cancelled" }
        ]) {
          expect(await reconciled(incident)).toBe("completed");
        }
      });

      it("ignores every incident for a run that never bound a request", async () => {
        const { runs, store, setReply, setIncident } = setup();
        store.seed("run-1");
        setReply(true);
        // An incident with no request id of its own must not match the
        // row's missing one.
        setIncident("incident", {
          status: "scheduled",
          requestId: null as unknown as string
        });
        await runs.reconcileStale("run-1");
        expect(store.read("run-1")?.status).toBe("completed");
      });
    });
  });

  describe("what the parent reads", () => {
    it("reports no error for a running run whose stream recorded one, and no empty milestone list", async () => {
      const { runs, store } = setup();
      await runs.start("run-1", START, heldTurn().run);
      store.recordStreamError("run-1", "provider failed");
      const inspection = await runs.inspect("run-1");
      expect(inspection?.status).toBe("running");
      expect(inspection?.error).toBeUndefined();
      expect(inspection && "milestones" in inspection).toBe(false);
    });

    it("reports an empty summary for a completed row that holds none", async () => {
      const { runs, store } = setup();
      store.seed("run-1");
      store.writeTerminal("run-1", {
        status: "completed",
        output: 1,
        summary: null
      });
      expect((await runs.inspect("run-1"))?.summary).toBe("");
    });

    it("flushes buffered chunks before it reads them, and reads none for a run with no request", async () => {
      const { runs, store, flushes, storeChunks } = setup();
      store.seed("unbound");
      expect(runs.chunks("unbound")).toEqual([]);
      expect(flushes()).toBe(1);

      store.seed("bound");
      store.bindRequest("bound", "req-1");
      storeChunks("req-1", ["a"]);
      expect(runs.chunks("bound")).toEqual([{ sequence: 0, body: "a" }]);
      expect(flushes()).toBe(2);
    });

    it("reads the stream recorded on the row, not a newer one of the same request", () => {
      const { runs, store, storeChunks } = setup();
      store.seed("run-1");
      storeChunks("req-1", ["newer"]);
      store.writeTerminal(
        "run-1",
        { status: "aborted", error: null },
        { requestId: "req-1", streamId: "stream-recorded" }
      );
      expect(store.read("run-1")).toMatchObject({
        requestId: "req-1",
        streamId: "stream-recorded"
      });
      expect(runs.chunks("run-1")).toEqual([]);
    });
  });

  describe("tails", () => {
    it("one tail leaving does not cut off another tail of the same run", async () => {
      const { runs, settled } = setup();
      const turn = heldTurn();
      await runs.start("run-1", START, turn.run);
      const leaving = collect(runs.tail("run-1"));
      const staying = collect(runs.tail("run-1"));
      await tick();
      await leaving.cancel();
      runs.intercept(frame("req-1", "after"));
      await tick();
      expect(staying.bodies).toEqual(["after"]);
      // ...and the run's end still closes it.
      turn.end({ requestId: "req-1", status: "completed" });
      await settled();
      await staying.done;
      expect(staying.ended()).toBe(true);
      expect(runs.closers.size).toBe(0);
      expect(runs.forwarders.size).toBe(0);
    });

    it("closes at once, with nothing, for a consumer whose signal is already aborted", async () => {
      const { runs, storeChunks } = setup();
      await runs.start("run-1", START, heldTurn().run);
      storeChunks("req-1", ["backlog"]);
      const gaveUp = new AbortController();
      gaveUp.abort();
      const tail = collect(runs.tail("run-1", { signal: gaveUp.signal }));
      await tail.done;
      expect(tail.failure()).toBeUndefined();
      expect(tail.bodies).toEqual([]);
      expect(runs.forwarders.size).toBe(0);
      expect(runs.closers.size).toBe(0);
    });

    it("closes cleanly for a run that does not exist", async () => {
      const { runs } = setup();
      const tail = collect(runs.tail("nobody"));
      await tail.done;
      expect(tail.failure()).toBeUndefined();
      expect(tail.bodies).toEqual([]);
      expect(runs.liveSequences.size).toBe(0);
    });

    it("does not repeat a live chunk at or before the position the consumer asked from", async () => {
      const { runs, storeChunks } = setup();
      await runs.start("run-1", START, heldTurn().run);
      storeChunks("req-1", ["zero", "one"]);
      const tail = collect(runs.tail("run-1", { afterSequence: 1 }));
      await tick();
      // The live counter is cold in this test, so these arrive as 0, 1, 2.
      for (const body of ["zero", "one", "two"]) {
        runs.intercept(frame("req-1", body));
      }
      await tick();
      expect(tail.bodies).toEqual(["two"]);
    });

    it("delivers a progress frame whatever position it carries", async () => {
      const { runs, storeChunks } = setup();
      await runs.start("run-1", START, heldTurn().run);
      storeChunks("req-1", ["zero", "one", "two"]);
      const tail = collect(runs.tail("run-1", { afterSequence: 2 }));
      await tick();
      const progress = JSON.stringify({
        type: "data-agent-progress",
        id: "p1",
        data: { message: "halfway" }
      });
      runs.intercept(frame("req-1", progress));
      await tick();
      expect(tail.bodies).toEqual([progress]);
    });

    it("a tail whose stream no longer takes chunks is dropped, and the broadcast goes on", async () => {
      const { runs } = setup();
      await runs.start("run-1", START, heldTurn().run);
      const broken = collect(runs.tail("run-1"));
      const healthy = collect(runs.tail("run-1"));
      await tick();
      const enqueue = ReadableStreamDefaultController.prototype.enqueue;
      let thrown = 0;
      ReadableStreamDefaultController.prototype.enqueue = function (
        this: ReadableStreamDefaultController,
        chunk
      ) {
        if (thrown++ === 0) throw new TypeError("stream is closed");
        return enqueue.call(this, chunk);
      };
      try {
        expect(() => runs.intercept(frame("req-1", "a"))).not.toThrow();
      } finally {
        ReadableStreamDefaultController.prototype.enqueue = enqueue;
      }
      runs.intercept(frame("req-1", "b"));
      await tick();
      expect(broken.bodies).toEqual([]);
      expect(healthy.bodies).toEqual(["a", "b"]);
      expect(runs.forwarders.get("run-1")?.size).toBe(1);
      expect(runs.closers.get("run-1")?.size).toBe(1);
    });

    it("fails the stream, and keeps nothing, when the backlog cannot be read", async () => {
      const { runs } = setup();
      await runs.start("run-1", START, heldTurn().run);
      const tail = collect(
        runs.tail("run-1", undefined, {
          chunks: async () => {
            throw new Error("chunk read failed");
          }
        })
      );
      await tail.done;
      expect(String(tail.failure())).toContain("chunk read failed");
      expect(runs.forwarders.size).toBe(0);
      expect(runs.closers.size).toBe(0);
    });

    it("seeds the live counter only for an open run with a bound turn, and leaves a warm one", async () => {
      const { runs, store, storeChunks, setRecovery } = setup();
      // Open, no request bound yet.
      store.seed("unbound");
      setRecovery("in-progress", "nothing");
      runs.tail("unbound", undefined, { inspect: async () => null });
      await tick();
      expect(runs.liveSequences.has("unbound")).toBe(false);

      // Open and bound, counter already warm at a different number.
      store.seed("warm");
      store.bindRequest("warm", "req-w");
      storeChunks("req-w", ["a", "b"]);
      runs.liveSequences.set("warm", 7);
      runs.tail("warm", undefined, {
        inspect: async () => ({
          runId: "warm",
          status: "running",
          startedAt: 1
        })
      });
      await tick();
      expect(runs.liveSequences.get("warm")).toBe(7);

      // Ended.
      store.seed("ended");
      store.bindRequest("ended", "req-e");
      storeChunks("req-e", ["a"]);
      runs.cancel("ended");
      runs.tail("ended");
      await tick();
      expect(runs.liveSequences.has("ended")).toBe(false);
    });
  });

  describe("the run table, method by method", () => {
    it("reads what was never stored as undefined, and JSON it cannot parse too", () => {
      const { store } = setup();
      store.insert("run-1", {
        input: undefined,
        startedAt: 1,
        terminalOnly: false
      });
      const run = store.read("run-1");
      expect(run?.input).toBeUndefined();
      expect(run?.output).toBeUndefined();
      expect(run?.terminalOnly).toBe(false);
      store.raw(
        "update runs set output_json = '{not json' where run_id = 'run-1'"
      );
      expect(store.read("run-1")?.output).toBeUndefined();
    });

    it("reports progress only for a row that holds a snapshot and its time", () => {
      const { store } = setup();
      store.seed("run-1");
      expect(store.read("run-1") && "progress" in store.read("run-1")!).toBe(
        false
      );
      // A milestone moves the no-progress clock without a snapshot.
      expect(store.addMilestone("run-1", "first", undefined, 5)).toBe(0);
      expect(store.addMilestone("run-1", "second", { n: 1 }, 6)).toBe(1);
      expect("progress" in store.read("run-1")!).toBe(false);

      store.writeProgress("run-1", { message: "halfway" }, 10);
      expect(store.read("run-1")?.progress).toEqual({
        message: "halfway",
        at: 10
      });
      store.addMilestone("run-1", "third", undefined, 20);
      expect(store.read("run-1")?.progress?.at).toBe(20);

      // A snapshot without its time is not reported.
      store.raw("update runs set last_signal_at = null where run_id = 'run-1'");
      expect("progress" in store.read("run-1")!).toBe(false);

      const milestones = store.milestones("run-1");
      expect("data" in milestones[0]).toBe(false);
      expect(milestones[1]).toEqual({
        name: "second",
        sequence: 1,
        at: 6,
        data: { n: 1 }
      });
    });

    it("creates the request index with the tables", () => {
      const { store } = setup();
      store.ensure();
      expect(store.schema()).toEqual(["milestones", "runs", "runs_request"]);
    });

    it("does not swallow a failure to add a column", () => {
      const store = storeOn(new DatabaseSync(":memory:"), (query) =>
        query.startsWith("alter table") ? "disk I/O error" : null
      );
      expect(() => store.ensure()).toThrow("disk I/O error");
    });

    it("pays for the table check once", () => {
      const db = new DatabaseSync(":memory:");
      storeOn(db).ensure();
      const store = storeOn(db);
      store.forRequest("req-1");
      const afterFirst = store.statements();
      store.forRequest("req-1");
      store.listOpen();
      // One select each, and no second look at the schema.
      expect(store.statements() - afterFirst).toBe(2);
    });

    // A store may be asked anything first: after a restart, on a table the
    // previous release created.
    const OLD_SCHEMA =
      "create table runs (run_id text primary key, request_id text, status text not null, started_at integer not null)";
    const firstCalls: Array<
      [string, (store: ReturnType<typeof storeOn>) => unknown]
    > = [
      ["openForRequest", (store) => store.openForRequest("req-1")],
      ["bindRequest", (store) => store.bindRequest("old", "req-2", "req-1")],
      ["recordStreamError", (store) => store.recordStreamError("old", "x")],
      ["markCancelled", (store) => store.markCancelled("old", 1)],
      ["markTurnStarted", (store) => store.markTurnStarted("old", 1, "m")],
      [
        "writeTerminal",
        (store) => store.writeTerminal("old", { status: "error", error: "x" })
      ],
      ["writeProgress", (store) => store.writeProgress("old", {}, 1)],
      ["addMilestone", (store) => store.addMilestone("old", "m", undefined, 1)],
      ["milestones", (store) => store.milestones("old")]
    ];
    for (const [method, call] of firstCalls) {
      it(`${method} works as the first call on a table from an older version`, () => {
        const db = new DatabaseSync(":memory:");
        db.exec(OLD_SCHEMA);
        db.exec(
          "insert into runs (run_id, request_id, status, started_at) values ('old', 'req-1', 'running', 1)"
        );
        expect(() => call(storeOn(db))).not.toThrow();
      });
    }

    it("openForRequest works as the first call on an agent with no table yet", () => {
      const store = storeOn(new DatabaseSync(":memory:"));
      expect(store.openForRequest("req-1")).toBeNull();
    });
  });
});
