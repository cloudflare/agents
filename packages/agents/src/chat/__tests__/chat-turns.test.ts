import { ChatRecoverySupersededError } from "../turn-stop";
import { ChatStreamStalledError } from "../stall-watchdog";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UIMessage } from "ai";
import { AutoContinuationController } from "../auto-continuation-controller";
import {
  ChatTurns,
  type ChatTurnMessage,
  type ChatTurnsHost
} from "../chat-turns";
import type { ContinuationConnection } from "../continuation-state";

const COALESCE = AutoContinuationController.COALESCE_MS;

function makeConnection(id: string): ContinuationConnection & {
  sent: string[];
} {
  const sent: string[] = [];
  return { id, sent, send: (message: string) => void sent.push(message) };
}

/** A host reduced to a transcript and a counter of fired continuations. */
class FakeHost implements ChatTurnsHost {
  transcript: ChatTurnMessage[] = [];
  replyStreaming = false;
  activeStream = false;
  fired = 0;
  stops: Array<{ requestId: string | null; reason: unknown }> = [];
  private ids = 0;

  stopped(requestId: string | null, reason: unknown) {
    this.stops.push({ requestId, reason });
  }

  messages() {
    return this.transcript;
  }
  isReplyStreaming() {
    return this.replyStreaming;
  }
  streaming: ChatTurnMessage | null = null;
  clientTools = new Set<string>();
  streamingReply() {
    return this.streaming;
  }
  clientToolNames() {
    return this.clientTools;
  }
  hasActiveStream() {
    return this.activeStream;
  }
  generateRequestId() {
    return `cont-${++this.ids}`;
  }
  keepAliveWhile<T>(fn: () => Promise<T>) {
    return fn();
  }
  fireContinuation() {
    this.fired++;
  }
}

const user = (id: string): ChatTurnMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }]
});
const toolReply = (id: string, state: string): ChatTurnMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "tool-x", toolCallId: `call-${id}`, state }]
});

describe("ChatTurns", () => {
  let host: FakeHost;
  let turns: ChatTurns;
  const connection = makeConnection("c1");
  const spec = () => ({
    connection,
    clientTools: undefined,
    body: undefined,
    errorPrefix: "[test]"
  });

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    turns = new ChatTurns(host, { defaultDebounceMs: 750 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Tool results ────────────────────────────────────────────────────

  it("applies interactions one at a time, in arrival order", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = turns.enqueueInteraction(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first");
      return true;
    });
    const second = turns.enqueueInteraction(async () => {
      order.push("second");
      return true;
    });
    expect(turns.pendingInteraction).toBe(second);

    await Promise.resolve();
    expect(order).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(turns.pendingInteraction).toBeNull();
  });

  it("runs the next apply after one that rejects", async () => {
    const failed = turns.enqueueInteraction(async () => {
      throw new Error("apply failed");
    });
    const next = turns.enqueueInteraction(async () => true);
    await expect(failed).rejects.toThrow("apply failed");
    await expect(next).resolves.toBe(true);
  });

  it("continues only for a result that settled its call", async () => {
    host.transcript = [user("u1"), toolReply("a1", "output-available")];

    await turns.applyInteraction(
      async () => ({ status: "unchanged" }),
      true,
      spec
    );
    await turns.applyInteraction(
      async () => ({ status: "missing" }),
      true,
      spec
    );
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fired).toBe(0);

    const found = await turns.applyInteraction(
      async () => ({ status: "changed", messageId: "a1" }),
      true,
      spec
    );
    expect(found).toBe(true);
    expect(turns.continuation.pending?.targetMessageIds).toEqual(["a1"]);
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fired).toBe(1);
  });

  it("reports a missing tool call", async () => {
    await expect(
      turns.applyInteraction(async () => ({ status: "missing" }), false, spec)
    ).resolves.toBe(false);
  });

  it("holds a continuation while the reply streams or the batch is incomplete", async () => {
    host.transcript = [user("u1"), toolReply("a1", "output-available")];
    host.replyStreaming = true;
    await turns.applyInteraction(
      async () => ({ status: "changed", messageId: "a1" }),
      true,
      spec
    );
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fired).toBe(0);

    host.replyStreaming = false;
    host.transcript = [
      user("u1"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "tool-x", toolCallId: "c1", state: "output-available" },
          { type: "tool-x", toolCallId: "c2", state: "input-available" }
        ]
      }
    ];
    turns.autoContinuation.rearmForBatch();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fired).toBe(0);

    host.transcript = [user("u1"), toolReply("a1", "output-available")];
    turns.autoContinuation.rearmForBatch();
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fired).toBe(1);
  });

  // ── Reset guard ─────────────────────────────────────────────────────

  it("reports a reset to the turn that was running when it happened", async () => {
    let duringTurn!: () => boolean;
    let afterReset = false;
    await turns.queue.enqueue("r1", async () => {
      duringTurn = turns.turnResetGuard();
      expect(duringTurn()).toBe(false);
      turns.reset();
      afterReset = duringTurn();
    });
    expect(afterReset).toBe(true);

    // A turn admitted after the reset is current.
    await turns.queue.enqueue("r2", async () => {
      expect(turns.turnResetGuard()()).toBe(false);
    });
  });

  // ── Cancel ──────────────────────────────────────────────────────────

  it("cancels a request's turn and a recovery attempt running for it", () => {
    const signal = turns.aborts.getSignal("req-1");
    const attempt = turns.beginRecoveryAttempt("req-1");
    const other = turns.beginRecoveryAttempt("req-2");

    turns.cancel("req-1", "stop");

    expect(signal?.aborted).toBe(true);
    expect(attempt.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  it("forgets a recovery attempt once it ends", () => {
    const attempt = turns.beginRecoveryAttempt("req-1");
    attempt.end();
    turns.cancel("req-1");
    expect(attempt.signal.aborted).toBe(false);
  });

  it("a newer attempt for the same request is not forgotten by the older one ending", () => {
    const older = turns.beginRecoveryAttempt("req-1");
    const newer = turns.beginRecoveryAttempt("req-1");
    older.end();
    turns.cancel("req-1");
    expect(newer.signal.aborted).toBe(true);
  });

  // ── Reset ───────────────────────────────────────────────────────────

  it("reset tears down turns, aborts, interactions and continuations together", async () => {
    host.transcript = [user("u1"), toolReply("a1", "output-available")];
    const signal = turns.aborts.getSignal("req-1");
    const parked = makeConnection("parked");
    turns.preStream.begin("req-1");
    turns.preStream.park(parked);
    await turns.applyInteraction(
      async () => ({ status: "changed", messageId: "a1" }),
      true,
      spec
    );
    void turns.enqueueInteraction(() => new Promise<boolean>(() => {}));
    const generation = turns.queue.generation;

    turns.reset();

    expect(turns.queue.generation).toBe(generation + 1);
    expect(signal?.aborted).toBe(true);
    expect(turns.aborts.size).toBe(0);
    expect(turns.pendingInteraction).toBeNull();
    expect(turns.continuation.pending).toBeNull();
    expect(turns.autoContinuation.isArmed()).toBe(false);
    expect(turns.preStream.hasInFlight()).toBe(false);
    expect(parked.sent.at(-1)).toContain("cf_agent_stream_resume_none");

    // A hung apply from before the reset does not block a new one.
    await expect(turns.enqueueInteraction(async () => true)).resolves.toBe(
      true
    );
    await vi.advanceTimersByTimeAsync(COALESCE);
    expect(host.fired).toBe(0);
  });

  // ── Submits ─────────────────────────────────────────────────────────

  it("skips a submit superseded while it waited in the queue", async () => {
    let release!: () => void;
    const active = turns.queue.enqueue(
      "r1",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const older = turns.decideSubmit("latest", true);
    const newer = turns.decideSubmit("latest", true);
    await vi.advanceTimersByTimeAsync(0);
    release();
    await active;

    await expect(
      turns.awaitSubmitTurn(older, turns.queue.generation)
    ).resolves.toBe(false);
    await expect(
      turns.awaitSubmitTurn(newer, turns.queue.generation)
    ).resolves.toBe(true);
  });

  it("skips a debounced submit when the chat is reset during its quiet period", async () => {
    let release!: () => void;
    const active = turns.queue.enqueue(
      "r1",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const decision = turns.decideSubmit(
      { strategy: "debounce", debounceMs: 200 },
      true
    );
    const generation = turns.queue.generation;
    await vi.advanceTimersByTimeAsync(0);
    release();
    await active;

    const admitted = turns.awaitSubmitTurn(decision, generation);
    turns.reset();
    await vi.advanceTimersByTimeAsync(200);
    await expect(admitted).resolves.toBe(false);
  });

  it("releases parked connections when the last accepted turn settles without a stream", () => {
    const parked = makeConnection("parked");
    turns.preStream.begin("r1");
    turns.preStream.begin("r2");
    turns.preStream.park(parked);
    const before = parked.sent.length;

    turns.settlePreStreamTurn("r1");
    turns.settlePreStreamTurn("r2", { releaseParked: false });
    expect(parked.sent.length).toBe(before);

    turns.preStream.begin("r3");
    host.activeStream = true;
    turns.settlePreStreamTurn("r3");
    expect(parked.sent.length).toBe(before);

    turns.preStream.begin("r4");
    host.activeStream = false;
    turns.settlePreStreamTurn("r4");
    expect(parked.sent.at(-1)).toContain("cf_agent_stream_resume_none");
  });

  // ── Waiting on a client ─────────────────────────────────────────────

  it("counts every unanswered call in the stored transcript as waiting on a client", () => {
    host.transcript = [user("u1"), toolReply("a1", "input-available")];
    // No client sent a schema for the tool: it still counts, because a reply
    // is only stored unanswered when its stream finished on that call.
    expect(turns.hasPendingInteraction()).toBe(true);

    host.transcript = [user("u1"), toolReply("a1", "approval-requested")];
    expect(turns.hasPendingInteraction()).toBe(true);

    host.transcript = [user("u1"), toolReply("a1", "output-error")];
    expect(turns.hasPendingInteraction()).toBe(false);
  });

  it("counts only a known client tool in the reply that is streaming", () => {
    host.transcript = [user("u1")];
    host.streaming = toolReply("a1", "input-available");
    // A server tool sits at input-available while it runs.
    expect(turns.hasPendingInteraction()).toBe(false);

    host.clientTools = new Set(["x"]);
    expect(turns.hasPendingInteraction()).toBe(true);

    // A stored snapshot of the streaming reply defers to the live copy.
    host.clientTools = new Set();
    host.transcript = [user("u1"), toolReply("a1", "input-available")];
    expect(turns.hasPendingInteraction()).toBe(false);
  });

  it("in a reply the conversation moved past, counts only a known client's call or an approval", () => {
    // A dead call an older version stored looks exactly like this one.
    host.transcript = [
      user("u1"),
      toolReply("a1", "input-available"),
      user("u2")
    ];
    expect(turns.hasPendingInteraction()).toBe(false);

    host.clientTools = new Set(["x"]);
    expect(turns.hasPendingInteraction()).toBe(true);

    host.clientTools = new Set();
    host.transcript = [
      user("u1"),
      toolReply("a1", "approval-requested"),
      user("u2")
    ];
    expect(turns.hasPendingInteraction()).toBe(true);
  });

  // ── Idle and stable ─────────────────────────────────────────────────

  it("is not idle while a turn runs, a result is applied, or a continuation is armed", async () => {
    host.transcript = [user("u1"), toolReply("a1", "output-available")];
    let idle = false;
    let release!: () => void;
    const turn = turns.queue.enqueue(
      "r1",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    void turns.waitForIdle().then(() => {
      idle = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(idle).toBe(false);

    void turns.applyInteraction(
      async () => ({ status: "changed", messageId: "a1" }),
      true,
      spec
    );
    release();
    await turn;
    await vi.advanceTimersByTimeAsync(10);
    // The continuation is armed but has not fired yet.
    expect(idle).toBe(false);

    await vi.advanceTimersByTimeAsync(COALESCE * 2);
    expect(host.fired).toBe(1);
    // The host's fire would enqueue a turn; here nothing is queued, and the
    // continuation is no longer armed.
    turns.continuation.clearPending();
    await vi.advanceTimersByTimeAsync(COALESCE * 2);
    expect(idle).toBe(true);
  });

  it("waitUntilStable waits for a pending client interaction and honors its timeout", async () => {
    let pending = true;
    const stable = turns.waitUntilStable({
      hasPendingInteraction: () => pending
    });
    let settled: boolean | undefined;
    void stable.then((value) => {
      settled = value;
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).toBeUndefined();
    pending = false;
    await vi.advanceTimersByTimeAsync(150);
    expect(settled).toBe(true);

    const timedOut = turns.waitUntilStable({
      timeout: 300,
      hasPendingInteraction: () => true
    });
    await vi.advanceTimersByTimeAsync(400);
    await expect(timedOut).resolves.toBe(false);
  });

  describe("waitUntilStable with a tool result being applied", () => {
    const gate = () => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return { opened, open };
    };

    it("reports stable as soon as the apply settles the call", async () => {
      host.transcript = [user("u1"), toolReply("a1", "input-available")];
      const apply = gate();
      void turns.enqueueInteraction(async () => {
        await apply.opened;
        host.transcript = [user("u1"), toolReply("a1", "output-available")];
        return true;
      });
      let settled: boolean | undefined;
      void turns.waitUntilStable({ timeout: 1000 }).then((value) => {
        settled = value;
      });

      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBeUndefined();
      apply.open();
      // Woken by the apply, not by the next 100ms poll.
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
    });

    it("reports not stable at the timeout while the apply is still running", async () => {
      host.transcript = [user("u1"), toolReply("a1", "input-available")];
      const apply = gate();
      void turns.enqueueInteraction(async () => {
        await apply.opened;
        return true;
      });
      let settled: boolean | undefined;
      void turns.waitUntilStable({ timeout: 300 }).then((value) => {
        settled = value;
      });

      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(false);
      apply.open();
    });

    it("keeps waiting after an apply that throws and leaves the call open", async () => {
      host.transcript = [user("u1"), toolReply("a1", "input-available")];
      void turns
        .enqueueInteraction(async () => {
          throw new Error("apply failed");
        })
        .catch(() => {});
      let settled: boolean | undefined;
      void turns.waitUntilStable({ timeout: 300 }).then((value) => {
        settled = value;
      });

      await vi.advanceTimersByTimeAsync(250);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
    });
  });

  // ── Client requests ─────────────────────────────────────────────────

  describe("a stop is reported to the host", () => {
    it("cancel reports the request and its reason, whether or not a turn runs under it", async () => {
      await turns.cancel("nothing-runs-here", "why");
      turns.aborts.getSignal("r1");
      await turns.cancel("r1");
      expect(host.stops).toEqual([
        { requestId: "nothing-runs-here", reason: "why" },
        { requestId: "r1", reason: undefined }
      ]);
    });

    it("a stop of everything reports no request id", async () => {
      await turns.stopAll("all");
      expect(host.stops).toEqual([{ requestId: null, reason: "all" }]);
    });

    it("a caller's linked signal is a stop like any other", () => {
      const caller = new AbortController();
      turns.aborts.getSignal("r1");
      turns.linkExternal("r1", caller.signal);
      caller.abort("gave up");
      expect(host.stops).toEqual([{ requestId: "r1", reason: "gave up" }]);
    });

    it("a recovery attempt superseded by another turn is not a stop", () => {
      const attempt = new AbortController();
      const signal = turns.aborts.getSignal("r1");
      turns.linkExternal("r1", attempt.signal);
      attempt.abort(new ChatRecoverySupersededError());
      // The turn ends, and nothing a user's stop does follows.
      expect(signal?.aborted).toBe(true);
      expect(host.stops).toEqual([]);
    });

    it("the runtime's own abort is not a stop", () => {
      const signal = turns.aborts.getSignal("r1");
      turns.runtimeAbort(
        () => void turns.cancel("r1", new ChatStreamStalledError("stalled"))
      );
      expect(signal?.aborted).toBe(true);
      expect(host.stops).toEqual([]);
      expect(turns.isStopped(signal)).toBe(false);
    });

    it("a stop that lands after the runtime's abort still counts as a stop", () => {
      const signal = turns.aborts.getSignal("r1");
      turns.runtimeAbort(
        () => void turns.cancel("r1", new ChatStreamStalledError("stalled"))
      );
      expect(turns.isStopped(signal)).toBe(false);
      // The signal is already aborted, and keeps the stall as its reason.
      void turns.cancel("r1", "user pressed stop");
      expect(signal?.reason).toBeInstanceOf(ChatStreamStalledError);
      expect(turns.isStopped(signal)).toBe(true);
    });

    it("a host whose stop bookkeeping fails still stopped the turn", async () => {
      const signal = turns.aborts.getSignal("r1");
      host.stopped = () => {
        throw new Error("storage is down");
      };
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      await expect(turns.cancel("r1")).resolves.toBeUndefined();
      expect(signal?.aborted).toBe(true);
      logged.mockRestore();
    });
  });

  describe("runClientRequest", () => {
    type Log = string[];

    /** A request whose steps record themselves; override any of them. */
    function request(
      id: string,
      log: Log,
      overrides: Partial<
        Parameters<typeof turns.runClientRequest<string>>[0]
      > = {}
    ) {
      return turns.runClientRequest<string>({
        requestId: id,
        isSubmitMessage: true,
        concurrency: "queue",
        onDropped: () => void log.push(`${id}:dropped`),
        onAccepted: () => void log.push(`${id}:accepted`),
        persist: async () => {
          log.push(`${id}:persist`);
          return "prepared";
        },
        enqueue: async (turn, generation, onQueued) => {
          const result = turns.queue.enqueue(id, turn, { generation });
          onQueued();
          return (await result).status;
        },
        run: async (prepared, signal) => {
          log.push(`${id}:run:${prepared}:${signal.aborted}`);
        },
        onSkipped: () => void log.push(`${id}:skipped`),
        onCancelledBeforeStart: () => void log.push(`${id}:aborted`),
        ...overrides
      });
    }

    it("accepts, persists, queues and runs a request, then settles it", async () => {
      const log: Log = [];
      let registeredDuringRun = false;
      let preStreamDuringRun = false;
      await request("r1", log, {
        run: async () => {
          registeredDuringRun = turns.aborts.has("r1");
          preStreamDuringRun = turns.preStream.hasInFlight();
          log.push("r1:run");
        }
      });
      expect(log).toEqual(["r1:accepted", "r1:persist", "r1:run"]);
      expect(registeredDuringRun).toBe(true);
      expect(preStreamDuringRun).toBe(true);
      expect(turns.aborts.has("r1")).toBe(false);
      expect(turns.preStream.hasInFlight()).toBe(false);
      expect(turns.submits.pendingEnqueueCount).toBe(0);
    });

    it("ends a request aborted when its run throws after a stop, without reporting an error", async () => {
      const log: Log = [];
      await request("r1", log, {
        run: async (_prepared, signal) => {
          turns.cancel("r1", "stop reason");
          throw signal.reason;
        },
        onError: (error) => void log.push(`r1:error:${String(error)}`)
      });
      expect(log).toEqual(["r1:accepted", "r1:persist", "r1:aborted"]);
    });

    it("reports what a run throws when nothing stopped the request", async () => {
      const log: Log = [];
      await request("r1", log, {
        run: async () => {
          throw new Error("boom");
        },
        onError: (error) => void log.push(`r1:error:${String(error)}`)
      });
      expect(log).toEqual([
        "r1:accepted",
        "r1:persist",
        "r1:error:Error: boom"
      ]);
    });

    it("rejects a request id the registry cannot key a controller by", async () => {
      const log: Log = [];
      await expect(
        request(undefined as unknown as string, log)
      ).rejects.toThrow("runClientRequest: requestId must be a string");
      // Nothing was accepted: no pre-stream mark, no persist, no queue.
      expect(log).toEqual([]);
      expect(turns.preStream.hasInFlight()).toBe(false);
      expect(turns.submits.pendingEnqueueCount).toBe(0);
    });

    it("drops an overlapping submit before accepting it", async () => {
      const log: Log = [];
      let release!: () => void;
      const first = request("r1", log, {
        run: () => new Promise<void>((resolve) => (release = resolve))
      });
      await vi.advanceTimersByTimeAsync(0);
      await request("r2", log, { concurrency: "drop" });
      expect(log).toEqual(["r1:accepted", "r1:persist", "r2:dropped"]);
      expect(turns.aborts.has("r2")).toBe(false);
      release();
      await first;
    });

    it("ends a request cancelled while it waited in the queue without running it", async () => {
      const log: Log = [];
      let release!: () => void;
      const first = request("r1", log, {
        run: () => new Promise<void>((resolve) => (release = resolve))
      });
      await vi.advanceTimersByTimeAsync(0);
      const second = request("r2", log);
      await vi.advanceTimersByTimeAsync(0);

      // The controller exists from acceptance, so this cancel is not lost.
      turns.cancel("r2");
      release();
      await Promise.all([first, second]);

      expect(log).toEqual([
        "r1:accepted",
        "r1:persist",
        "r2:accepted",
        "r2:persist",
        "r2:aborted"
      ]);
    });

    it("skips a queued request when the chat is reset", async () => {
      const log: Log = [];
      let release!: () => void;
      const first = request("r1", log, {
        run: () => new Promise<void>((resolve) => (release = resolve))
      });
      await vi.advanceTimersByTimeAsync(0);
      const second = request("r2", log);
      await vi.advanceTimersByTimeAsync(0);

      turns.reset();
      release();
      await Promise.all([first, second]);

      expect(log.filter((entry) => entry.startsWith("r2"))).toEqual([
        "r2:accepted",
        "r2:persist",
        "r2:skipped"
      ]);
    });

    it("skips a request superseded by a newer one under latest", async () => {
      const log: Log = [];
      let release!: () => void;
      const first = request("r1", log, {
        run: () => new Promise<void>((resolve) => (release = resolve))
      });
      await vi.advanceTimersByTimeAsync(0);
      const second = request("r2", log, { concurrency: "latest" });
      const third = request("r3", log, { concurrency: "latest" });
      await vi.advanceTimersByTimeAsync(0);
      release();
      await Promise.all([first, second, third]);

      expect(log).toContain("r2:skipped");
      expect(log).toContain("r3:run:prepared:false");
      expect(log).not.toContain("r2:run:prepared:false");
    });

    it("skips a request its persist declines or its host check rejects", async () => {
      const log: Log = [];
      await request("r1", log, { persist: async () => null });
      await request("r2", log, { beforeStart: async () => false });
      expect(log).toEqual([
        "r1:accepted",
        "r1:skipped",
        "r2:accepted",
        "r2:persist",
        "r2:skipped"
      ]);
      expect(turns.preStream.hasInFlight()).toBe(false);
    });

    it("reports a failing step with its stage and still settles the request", async () => {
      const errors: string[] = [];
      const onError = (error: unknown, stage: string) =>
        void errors.push(`${stage}:${(error as Error).message}`);
      await request("r1", [], {
        persist: async () => {
          throw new Error("store down");
        },
        onError
      });
      await request("r2", [], {
        run: async () => {
          throw new Error("model down");
        },
        onError
      });
      await request("r0", [], {
        onAccepted: async () => {
          throw new Error("accept failed");
        },
        onError
      });
      expect(errors).toEqual([
        "persist:store down",
        "turn:model down",
        "persist:accept failed"
      ]);
      expect(turns.aborts.size).toBe(0);
      expect(turns.preStream.hasInFlight()).toBe(false);
      expect(turns.submits.pendingEnqueueCount).toBe(0);

      await expect(
        request("r3", [], {
          run: async () => {
            throw new Error("unreported");
          }
        })
      ).rejects.toThrow("unreported");
      expect(turns.aborts.size).toBe(0);
    });
  });

  describe("settleBeforeTurn", () => {
    const flip = (part: UIMessage["parts"][number]) =>
      ({ ...part, state: "output-error" }) as UIMessage["parts"][number];
    const stateOf = (message: UIMessage) =>
      (message.parts[0] as { state?: string }).state;
    const noSink = {
      persist: async () => {},
      remove: async () => {},
      emitRepaired: () => {}
    };
    const repair = (messages: UIMessage[], continuation: boolean) =>
      turns.settleBeforeTurn(
        messages,
        { continuation, repairPart: flip },
        noSink
      );

    it("settles a known client's call in a reply the conversation moved past", async () => {
      host.clientTools = new Set(["x"]);
      const messages = [
        user("u1"),
        toolReply("a1", "input-available"),
        user("u2")
      ] as UIMessage[];

      const result = await repair(messages, false);

      expect(stateOf(result.messages[1])).toBe("output-error");
      expect(result.toolCallIds).toEqual(["call-a1"]);
    });

    it("a continuation turn keeps the host's known client call in the message it continues", async () => {
      host.clientTools = new Set(["x"]);
      const messages = [
        user("u1"),
        toolReply("a1", "input-available")
      ] as UIMessage[];

      expect(stateOf((await repair(messages, true)).messages[1])).toBe(
        "input-available"
      );
      // The same call for a tool no client sent a schema for is dead.
      host.clientTools = new Set();
      expect(stateOf((await repair(messages, true)).messages[1])).toBe(
        "output-error"
      );
    });

    it("reports the calls a continuation turn kept for a client, and says so before the turn", async () => {
      host.clientTools = new Set(["x"]);
      const messages = [
        user("u1"),
        toolReply("a1", "input-available")
      ] as UIMessage[];

      expect((await repair(messages, true)).keptToolCallIds).toEqual([
        "call-a1"
      ]);
      expect((await repair(messages, false)).keptToolCallIds).toEqual([]);

      // The same answer without repairing anything, from the host's
      // transcript or a given one.
      expect(turns.continuationWaitsOnClient(messages)).toBe(true);
      host.transcript = messages;
      expect(turns.continuationWaitsOnClient()).toBe(true);
      host.transcript = [...messages, user("u2")];
      expect(turns.continuationWaitsOnClient()).toBe(false);
      host.clientTools = new Set();
      expect(turns.continuationWaitsOnClient(messages)).toBe(false);
    });

    it("settleBeforeTurn stores what the repair changed and reports it", async () => {
      host.clientTools = new Set(["x"]);
      const messages = [
        user("u1"),
        toolReply("a1", "input-available"),
        user("u2")
      ] as UIMessage[];
      const stored: string[][] = [];
      const events: unknown[] = [];
      const sink = {
        persist: async (changed: UIMessage[]) => {
          stored.push(changed.map((message) => message.id));
        },
        remove: async () => {},
        emitRepaired: (event: unknown) => void events.push(event)
      };

      const result = await turns.settleBeforeTurn(
        messages,
        { continuation: false, repairPart: flip },
        sink
      );

      expect(stateOf(result.messages[1])).toBe("output-error");
      expect(stored).toEqual([["a1"]]);
      expect(events).toMatchObject([
        { removedToolCalls: 1, toolCallIds: ["call-a1"] }
      ]);

      // Nothing to repair: no write and no event.
      await turns.settleBeforeTurn(
        result.messages,
        { continuation: false, repairPart: flip },
        sink
      );
      expect(stored).toHaveLength(1);
      expect(events).toHaveLength(1);
    });

    it("settleInterruptedReply keeps the host's known client call", () => {
      const reply = toolReply("a1", "input-available") as UIMessage;
      expect(stateOf(turns.settleInterruptedReply(reply, flip))).toBe(
        "output-error"
      );
      host.clientTools = new Set(["x"]);
      expect(turns.settleInterruptedReply(reply, flip)).toBe(reply);
    });

    it("settleInterruptedReply goes by a turn's pinned client tools when given them", () => {
      const reply = toolReply("a1", "input-available") as UIMessage;
      // The stored tools name no client tool; the turn ran with one pinned.
      expect(turns.settleInterruptedReply(reply, flip, new Set(["x"]))).toBe(
        reply
      );
      // And the reverse: a call the stored tools name, which the pinned
      // ones do not, is settled.
      host.clientTools = new Set(["x"]);
      expect(
        stateOf(turns.settleInterruptedReply(reply, flip, new Set()))
      ).toBe("output-error");
    });

    it("settleBeforeRecovery settles only the latest reply it is given", async () => {
      const messages = [
        user("u1"),
        toolReply("a1", "input-available")
      ] as UIMessage[];
      const stored: string[][] = [];
      const sink = {
        persist: async (changed: UIMessage[]) => {
          stored.push(changed.map((message) => message.id));
        },
        remove: async () => {},
        emitRepaired: () => {}
      };

      await turns.settleBeforeRecovery(() => messages, "other", flip, sink);
      expect(stored).toEqual([]);
      await turns.settleBeforeRecovery(() => messages, "a1", flip, sink);
      expect(stored).toEqual([["a1"]]);
    });

    it("settleBeforeRecovery waits for an apply in flight and reads the transcript after it", async () => {
      let messages = [
        user("u1"),
        toolReply("a1", "input-available")
      ] as UIMessage[];
      const seen: string[] = [];
      const sink = {
        persist: async (changed: UIMessage[]) => {
          seen.push(stateOf(changed[0]) ?? "");
        },
        remove: async () => {},
        emitRepaired: () => {}
      };
      let finish!: () => void;
      // A client's result is being applied.
      const applying = turns.enqueueInteraction(
        () =>
          new Promise<boolean>((resolve) => {
            finish = () => {
              messages = [
                user("u1"),
                toolReply("a1", "output-available")
              ] as UIMessage[];
              resolve(true);
            };
          })
      );
      const settling = turns.settleBeforeRecovery(
        () => messages,
        "a1",
        flip,
        sink
      );
      await Promise.resolve();
      finish();
      await applying;
      await settling;
      // The applied result stands: the settle never writes the call back
      // as interrupted.
      expect(seen).not.toContain("output-error");
    });

    it("removes a reply the repair left empty and returns the list without it", async () => {
      const removed: string[][] = [];
      const messages: UIMessage[] = [
        { id: "u1", role: "user", parts: [{ type: "text", text: "q" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "step-start" }, { type: "reasoning", text: "hm" }]
        },
        { id: "u2", role: "user", parts: [{ type: "text", text: "next" }] }
      ];

      const result = await turns.settleBeforeTurn(
        messages,
        { continuation: false, repairPart: flip },
        {
          persist: async () => {
            throw new Error("an empty reply is removed, not stored");
          },
          remove: async (ids) => void removed.push(ids),
          emitRepaired: () => {}
        }
      );

      expect(removed).toEqual([["a1"]]);
      expect(result.messages.map((message) => message.id)).toEqual([
        "u1",
        "u2"
      ]);
    });

    it("says a reply that is only reasoning has nothing to continue", () => {
      const reasoningOnly: UIMessage = {
        id: "a1",
        role: "assistant",
        parts: [{ type: "step-start" }, { type: "reasoning", text: "hm" }]
      };
      const answered: UIMessage = {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "answer" }]
      };
      expect(turns.replyToContinueIsEmpty([reasoningOnly])).toBe(true);
      expect(turns.replyToContinueIsEmpty([answered])).toBe(false);
      expect(turns.replyToContinueIsEmpty([])).toBe(false);
    });
  });
});
