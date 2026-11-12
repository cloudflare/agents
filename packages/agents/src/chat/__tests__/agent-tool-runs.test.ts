import { describe, it, expect } from "vitest";
import {
  AgentToolRuns,
  agentToolRunOutcome,
  type AgentToolRunRecord,
  type AgentToolRunStore,
  type AgentToolRunTerminal,
  type AgentToolTurnResult
} from "../agent-tool-runs";
import { TurnQueue } from "../turn-queue";

type Row = AgentToolRunRecord & {
  startedAt: number;
  terminal?: AgentToolRunTerminal;
  writes: number;
};

/** A run table in memory. It has no guards of its own: the core decides. */
class FakeStore implements AgentToolRunStore {
  rows = new Map<string, Row>();
  private open(row: Row) {
    return row.status === "running";
  }
  read(runId: string) {
    return this.rows.get(runId) ?? null;
  }
  newestOpen() {
    return (
      [...this.rows.values()]
        .filter((row) => this.open(row))
        .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
    );
  }
  openForRequest(requestId: string) {
    return (
      [...this.rows.values()].find(
        (row) => this.open(row) && row.requestId === requestId
      ) ?? null
    );
  }
  forRequest(requestId: string) {
    return (
      [...this.rows.values()].find(
        (row) => row.requestId === requestId || row.rootRequestId === requestId
      ) ?? null
    );
  }
  listOpen() {
    return [...this.rows.values()]
      .filter((row) => this.open(row))
      .map((row) => row.runId);
  }
  insert(runId: string, run: { startedAt: number; terminalOnly: boolean }) {
    this.rows.set(runId, {
      runId,
      requestId: null,
      rootRequestId: null,
      status: "running",
      error: null,
      terminalOnly: run.terminalOnly,
      startedAt: run.startedAt,
      writes: 0
    });
  }
  bindRequest(runId: string, requestId: string) {
    const row = this.rows.get(runId);
    if (!row) return;
    row.requestId = requestId;
    row.rootRequestId ??= requestId;
  }
  recordStreamError(runId: string, error: string) {
    const row = this.rows.get(runId);
    if (row) row.error = error;
  }
  writeTerminal(runId: string, terminal: AgentToolRunTerminal) {
    const row = this.rows.get(runId);
    if (!row) return;
    row.status = terminal.status;
    row.terminal = terminal;
    row.writes++;
  }
}

function setup() {
  const store = new FakeStore();
  const queue = new TurnQueue();
  const recovered: Array<{ requestId: string; reason: unknown }> = [];
  let recovery: "in-progress" | "failed" | "none" = "none";
  let reply = false;
  let resolveRecovery: (() => void) | undefined;
  const lifecycles: Promise<unknown>[] = [];
  const runs = new AgentToolRuns({
    store,
    queue,
    responseType: "response",
    resetError: "cleared",
    keepAliveWhile: (fn) => {
      const running = fn();
      lifecycles.push(running);
      return running;
    },
    collectResult: () => ({ output: { ok: true }, summary: "done" }),
    hasAssistantReply: () => reply,
    cancelRequest: (requestId, reason) =>
      void recovered.push({ requestId, reason }),
    classifyRecovery: () =>
      resolveRecovery
        ? new Promise((resolve) => {
            const release = resolveRecovery;
            resolveRecovery = () => {
              release?.();
              resolve(recovery);
            };
          })
        : Promise.resolve(recovery),
    hasActiveStream: () => false
  });
  return {
    store,
    queue,
    runs,
    recovered,
    settled: () => Promise.all(lifecycles),
    setRecovery: (state: typeof recovery) => {
      recovery = state;
    },
    setReply: (value: boolean) => {
      reply = value;
    },
    /** Make the next reconcile wait until the returned function is called. */
    holdRecoveryRead: () => {
      resolveRecovery = () => {};
      return () => resolveRecovery?.();
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

const START = {
  input: "go",
  terminalOnly: false,
  assistantIds: new Set<string>()
};

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
    runs.start("run-1", START, turn.run);
    await Promise.resolve();
    expect(runs.isLive("run-1")).toBe(true);
    expect(store.read("run-1")?.status).toBe("running");

    turn.end({ requestId: "req-1", status: "completed" });
    await settled();
    expect(store.rows.get("run-1")?.terminal).toEqual({
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
    runs.start("run-1", START, turn.run);
    await Promise.resolve();

    runs.cancel("run-1", "stop");
    expect(turn.signal()?.aborted).toBe(true);
    expect(runs.isCancelled("run-1")).toBe(true);
    expect(store.rows.get("run-1")?.terminal).toEqual({
      status: "aborted",
      error: "stop"
    });
    // A live run is stopped through its own controller only.
    expect(recovered).toEqual([]);

    // The turn ends as an error, or completes anyway: the row is not rewritten.
    turn.end({ requestId: "req-1", status: "error", error: "late failure" });
    await settled();
    expect(store.read("run-1")?.status).toBe("aborted");
    expect(store.rows.get("run-1")?.writes).toBe(1);
  });

  it("a cancel of a run that is unknown or has ended does nothing", async () => {
    const { runs, store, settled, recovered } = setup();
    runs.cancel("no-such-run", "stop");

    const turn = heldTurn();
    runs.start("run-1", START, turn.run);
    await Promise.resolve();
    turn.end({ requestId: "req-1", status: "completed" });
    await settled();

    runs.cancel("run-1", "stop");
    expect(store.read("run-1")?.status).toBe("completed");
    expect(recovered).toEqual([]);
  });

  it("a cancel of a run with no controller here cancels the request ids on its row, and only those", () => {
    const { runs, store, recovered } = setup();
    // A row an earlier isolate left open, recovered once already.
    store.insert("run-1", { startedAt: 1, terminalOnly: false });
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
    store.insert("run-1", { startedAt: 1, terminalOnly: false });
    runs.cancel("run-1", "parent gave up");
    expect(recovered).toEqual([]);
    expect(store.read("run-1")?.status).toBe("aborted");
  });

  it("records a stream error only on an open row, and never throws", () => {
    const { runs, store } = setup();
    store.insert("run-1", { startedAt: 1, terminalOnly: false });
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
    expect(store.read("run-1")?.error).toBe("first failure");

    store.read = () => {
      throw new Error("sql failed");
    };
    expect(() => runs.intercept(frame("unrecorded"))).not.toThrow();
  });

  it("records a reset as an error whether the turn was queued or running", async () => {
    for (const status of ["skipped", "aborted"] as const) {
      const { runs, store, queue, settled } = setup();
      const turn = heldTurn();
      runs.start("run-1", START, turn.run);
      await Promise.resolve();
      queue.reset();
      turn.end({ requestId: "req-1", status });
      await settled();
      expect(store.rows.get("run-1")?.terminal).toEqual({
        status: "error",
        error: "cleared"
      });
    }
  });

  it("records a turn that threw as an error, or as aborted when the run was aborted", async () => {
    const failed = setup();
    const turn = heldTurn();
    failed.runs.start("run-1", START, turn.run);
    await Promise.resolve();
    turn.fail(new Error("boom"));
    await failed.settled();
    expect(failed.store.rows.get("run-1")?.terminal).toEqual({
      status: "error",
      error: "boom"
    });

    const aborted = setup();
    const parent = new AbortController();
    const abortedTurn = heldTurn();
    aborted.runs.start(
      "run-1",
      { ...START, signal: parent.signal },
      abortedTurn.run
    );
    await Promise.resolve();
    parent.abort(new Error("parent stopped"));
    expect(abortedTurn.signal()?.aborted).toBe(true);
    abortedTurn.fail(new Error("aborted"));
    await aborted.settled();
    expect(aborted.store.rows.get("run-1")?.terminal).toEqual({
      status: "aborted",
      error: "parent stopped"
    });
  });

  it("binds the turn's request id and rebinds a recovered turn's", async () => {
    const { runs, store } = setup();
    const turn = heldTurn();
    runs.start("run-1", START, turn.run);
    await Promise.resolve();
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
    store.insert("run-1", { startedAt: 1, terminalOnly: true });
    store.bindRequest("run-1", "req-1");
    expect(runs.runForRequest("req-1")).toBe("run-1");
    expect(runs.terminalOnlyRuns.has("run-1")).toBe(true);
  });

  it("reports a recovered turn whose run was cancelled, and leaves unrelated turns alone", () => {
    const { runs, store } = setup();
    expect(runs.isRecoveredRunCancelled("req-8")).toBe(false);

    store.insert("run-1", { startedAt: 1, terminalOnly: false });
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
    store.insert("run-1", { startedAt: 1, terminalOnly: false });
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
    store.insert("run-1", { startedAt: 1, terminalOnly: false });
    store.bindRequest("run-1", "req-1");
    setReply(true);
    await runs.reconcileStale("run-1");
    expect(store.read("run-1")?.status).toBe("completed");
    expect(runs.isRecoveredRunCancelled("req-1")).toBe(false);
  });

  it("settles a stale run from recovery: completed with a reply, error without", async () => {
    const withReply = setup();
    withReply.store.insert("run-1", { startedAt: 1, terminalOnly: false });
    withReply.setReply(true);
    await withReply.runs.reconcileStale("run-1");
    expect(withReply.store.read("run-1")?.status).toBe("completed");

    const without = setup();
    without.store.insert("run-1", { startedAt: 1, terminalOnly: false });
    await without.runs.reconcileStale("run-1");
    expect(without.store.rows.get("run-1")?.terminal).toEqual({
      status: "error",
      error: "Agent tool run was interrupted before the child could finish."
    });

    const errored = setup();
    errored.store.insert("run-1", { startedAt: 1, terminalOnly: false });
    errored.store.recordStreamError("run-1", "provider failed");
    errored.setReply(true);
    await errored.runs.reconcileStale("run-1");
    expect(errored.store.rows.get("run-1")?.terminal).toEqual({
      status: "error",
      error: "provider failed"
    });
  });

  it("leaves a stale run open while recovery is still working", async () => {
    const { runs, store, setRecovery } = setup();
    store.insert("run-1", { startedAt: 1, terminalOnly: false });
    setRecovery("in-progress");
    await runs.reconcileOwn();
    expect(store.read("run-1")?.status).toBe("running");
  });

  it("a reconcile does not replace a cancel that landed while it read recovery state", async () => {
    const { runs, store, holdRecoveryRead } = setup();
    store.insert("run-1", { startedAt: 1, terminalOnly: false });
    const release = holdRecoveryRead();
    const reconciling = runs.reconcileStale("run-1");
    runs.cancel("run-1", "stop");
    release();
    await reconciling;
    expect(store.rows.get("run-1")?.terminal).toEqual({
      status: "aborted",
      error: "stop"
    });
    expect(store.rows.get("run-1")?.writes).toBe(1);
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
});
