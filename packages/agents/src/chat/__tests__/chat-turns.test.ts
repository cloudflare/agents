import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  private ids = 0;

  messages() {
    return this.transcript;
  }
  isReplyStreaming() {
    return this.replyStreaming;
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

  // ── Continuation turn start ─────────────────────────────────────────

  it("takes a continuation while its message is the latest", async () => {
    host.transcript = [user("u1"), toolReply("a1", "output-available")];
    await turns.applyInteraction(
      async () => ({ status: "changed", messageId: "a1" }),
      true,
      spec
    );
    const taken = turns.takeContinuation();
    expect(taken?.requestId).toBe("cont-1");
    expect(taken?.pastCoalesce).toBe(true);
  });

  it("takes no continuation once a newer message follows its target", async () => {
    host.transcript = [user("u1"), toolReply("a1", "output-available")];
    await turns.applyInteraction(
      async () => ({ status: "changed", messageId: "a1" }),
      true,
      spec
    );
    host.transcript = [...host.transcript, user("u2")];
    expect(turns.takeContinuation()).toBeNull();
    expect(turns.continuation.pending?.pastCoalesce).toBe(false);
  });

  it("takes no continuation when none is pending", () => {
    expect(turns.takeContinuation()).toBeNull();
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
});
