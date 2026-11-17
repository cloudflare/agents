import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  onTestFinished
} from "vitest";
import { AutoContinuationController } from "../auto-continuation-controller";
import {
  ChatTurns,
  type ChatTurnMessage,
  type ChatTurnsHost
} from "../chat-turns";
import type {
  ContinuationConnection,
  ContinuationPending
} from "../continuation-state";
import { ContinuationState } from "../continuation-state";
import {
  continuationStreamStarted,
  runContinuationTurn,
  transcriptEndsInAnswer,
  type ContinuationTurn
} from "../continuation-turn";
import { CHAT_MESSAGE_TYPES } from "../protocol";
import { ChatStreamStalledError } from "../stall-watchdog";

const COALESCE = AutoContinuationController.COALESCE_MS;
const RESUME_NONE = JSON.stringify({
  type: CHAT_MESSAGE_TYPES.STREAM_RESUME_NONE
});

type TestConnection = ContinuationConnection & { sent: string[] };

function makeConnection(id: string): TestConnection {
  const sent: string[] = [];
  return { id, sent, send: (message: string) => void sent.push(message) };
}

const user = (id: string): ChatTurnMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: id }]
});
const toolReply = (id: string, ...states: string[]): ChatTurnMessage => ({
  id,
  role: "assistant",
  parts: states.map((state, index) => ({
    type: "tool-x",
    toolCallId: `call-${id}-${index}`,
    state
  }))
});

/** The latest reply, with a further step that holds the model's answer. */
function withAnswer(transcript: ChatTurnMessage[]): ChatTurnMessage[] {
  const last = transcript[transcript.length - 1];
  return [
    ...transcript.slice(0, -1),
    {
      ...last,
      parts: [
        ...last.parts,
        { type: "step-start" },
        { type: "text", text: "The answer." }
      ]
    }
  ];
}

/**
 * A host that runs continuation turns on the core's queue. `model` is what
 * the turn does once it has a continuation, the stand-in for "run the model
 * and stream".
 */
class FakeHost implements ChatTurnsHost {
  turns!: ChatTurns<TestConnection>;
  transcript: ChatTurnMessage[] = [];
  replyStreaming = false;
  /** Request ids of the continuation turns that reached the model. */
  ran: string[] = [];
  errors: Array<{
    error: unknown;
    errorPrefix: string | null;
    reported: boolean;
  }> = [];
  resumed: string[] = [];
  model: (
    continuation: ContinuationPending<TestConnection>,
    signal: AbortSignal
  ) => Promise<void> = async () => {};
  private ids = 0;

  messages() {
    return this.transcript;
  }
  isReplyStreaming() {
    return this.replyStreaming;
  }
  streamingReply() {
    return null;
  }
  clientToolNames() {
    return new Set<string>();
  }
  hasActiveStream() {
    return this.replyStreaming;
  }
  generateRequestId() {
    return `cont-${++this.ids}`;
  }
  /** The last reply a turn stored, as a host that records it reports it. */
  lastReply: string | null = null;
  lastTurnReplyId() {
    return this.lastReply;
  }
  keepAliveWhile<T>(fn: () => Promise<T>) {
    return fn();
  }
  /** The continuation turn the last fire started. */
  fired: Promise<void> = Promise.resolve();
  fireContinuation() {
    this.fired = this.turns.runContinuationTurn(this.turn());
    // A test that cares awaits `fired`. Nothing else may see a rejection.
    this.fired.catch(() => {});
  }

  /** Continuations the core dropped, with the reason. */
  droppedEvents: string[] = [];
  continuationDropped(event: { requestId: string; reason: string }) {
    this.droppedEvents.push(`${event.requestId}:${event.reason}`);
  }
  describeThrows = false;
  respondThrows = false;

  /** What the reply pipeline reported, in order. */
  reports: string[] = [];
  /** Set to make the turn body fail before the model is called. */
  recoveryFails = false;

  /**
   * The turn a host supplies. `model` stands for the host's turn body: the
   * model call and the stream.
   */
  turn(): ContinuationTurn<TestConnection, ChatTurnMessage> {
    return {
      enqueue: (requestId, turn) => this.turns.queue.enqueue(requestId, turn),
      run: async (continuation, signal) => {
        if (this.recoveryFails) throw new Error("recovery scope failed");
        this.ran.push(continuation.requestId);
        await this.model(
          continuation as ContinuationPending<TestConnection>,
          signal
        );
      },
      failure: {
        describe: ({ error, continuation }) => {
          if (this.describeThrows) throw new Error("the error hook threw");
          const message = error instanceof Error ? error.message : "failed";
          this.reports.push(
            `describe:${message}${continuation ? "" : ":request"}`
          );
          return message;
        },
        recordTerminal: async (requestId) => {
          this.reports.push(`terminal:${requestId}`);
        },
        broadcast: (frame) => {
          this.reports.push(
            `frame:${frame.id}:${frame.body}${frame.continuation ? "" : ":request"}`
          );
        },
        respond: (result) => {
          // The hook runs once the turn has left the queue.
          this.reports.push(
            `respond:${result.message.id}:${result.status}:${
              this.turns.queue.isActive ? "in-turn" : "after-turn"
            }`
          );
          if (this.respondThrows) throw new Error("onChatResponse threw");
        }
      },
      onError: (error, context) => void this.errors.push({ error, ...context })
    };
  }

  /**
   * What a host does when its reply stream starts and ends. `answer` appends
   * a step of text to the latest reply: the model went on to its answer.
   */
  async stream(requestId: string, answer = false) {
    this.replyStreaming = true;
    this.turns.streamStarted(requestId, (connection) =>
      this.resumed.push(connection.id)
    );
    await Promise.resolve();
    if (answer) this.transcript = withAnswer(this.transcript);
    this.replyStreaming = false;
    this.turns.replyFinalized();
  }
}

describe("the continuation turn", () => {
  let host: FakeHost;
  let turns: ChatTurns<TestConnection>;
  let connection: TestConnection;

  const spec = (target: TestConnection = connection) => ({
    connection: target,
    clientTools: undefined,
    body: undefined,
    errorPrefix: "[test]"
  });
  /** A tool result that settled a call in the message `messageId`. */
  const result = (messageId: string, target?: TestConnection) =>
    turns.applyInteraction(
      async () => ({ status: "changed", messageId }),
      true,
      () => spec(target)
    );
  const fire = () => vi.advanceTimersByTimeAsync(COALESCE);
  /** Let the queued turn and its settle run. */
  const drain = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    turns = new ChatTurns<TestConnection>(host, { defaultDebounceMs: 750 });
    host.turns = turns;
    connection = makeConnection("c1");
    host.transcript = [user("u1"), toolReply("a1", "output-available")];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the model with the pending continuation and an abort signal, then settles", async () => {
    let seen: AbortSignal | undefined;
    let busyInTurn: boolean | undefined;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => logged.mockRestore());
    host.model = async (continuation, signal) => {
      seen = signal;
      // Counted as firing only until the turn starts: from here the queue
      // says the chat is busy.
      busyInTurn = turns.hasPendingDecision();
      expect(continuation.pastCoalesce).toBe(true);
      expect(turns.aborts.has(continuation.requestId)).toBe(true);
      await host.stream(continuation.requestId, true);
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.ran).toEqual(["cont-1"]);
    expect(busyInTurn).toBe(false);
    // A turn that did not fail has no failure to hand `onChatResponse`.
    expect(host.reports).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
    expect(seen?.aborted).toBe(false);
    expect(host.resumed).toEqual(["c1"]);
    expect(turns.continuation.pending).toBeNull();
    expect(turns.aborts.has("cont-1")).toBe(false);
    expect(connection.sent).toEqual([]);
  });

  it("creates the abort signal when the continuation fires, so a cancel reaches it in the queue", async () => {
    let release!: () => void;
    const blocker = turns.queue.enqueue(
      "other",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    await result("a1");
    await fire();
    expect(turns.aborts.has("cont-1")).toBe(true);

    turns.cancel("cont-1");
    release();
    await blocker;
    await drain();

    // The model is never called, and the waiting connection is released.
    expect(host.ran).toEqual([]);
    expect(host.droppedEvents).toEqual(["cont-1:stopped"]);
    expect(connection.sent).toEqual([RESUME_NONE]);
    expect(turns.continuation.pending).toBeNull();
    expect(turns.aborts.has("cont-1")).toBe(false);
  });

  it("claims only the continuation the turn was fired for", async () => {
    let release!: () => void;
    const blocker = turns.queue.enqueue(
      "other",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    await result("a1");
    await fire();
    // The continuation the queued turn was fired for is gone, and a newer
    // one is pending by the time the turn starts.
    turns.continuation.clearPending();
    await result("a1");
    expect(turns.continuation.pending?.requestId).toBe("cont-2");
    release();
    await blocker;
    await drain();

    expect(host.ran).toEqual([]);
    expect(host.droppedEvents).toEqual([]);
    expect(turns.continuation.pending?.requestId).toBe("cont-2");
    expect(turns.continuation.pending?.pastCoalesce).toBe(false);

    await fire();
    await drain();
    expect(host.ran).toEqual(["cont-2"]);
  });

  it("runs nothing once the conversation moved on, and releases the waiting connection", async () => {
    await result("a1");
    host.transcript = [...host.transcript, user("u2")];
    await fire();
    await drain();

    expect(host.ran).toEqual([]);
    expect(host.droppedEvents).toEqual(["cont-1:moved_on"]);
    expect(connection.sent).toEqual([RESUME_NONE]);
    expect(turns.continuation.pending).toBeNull();
    // A dropped continuation is not a failure: the turn body never ran.
    expect(host.errors).toEqual([]);
  });

  it("drops a continuation for a host that does not listen for drops", async () => {
    const quiet = new FakeHost();
    Object.assign(quiet, { continuationDropped: undefined });
    const quietTurns = new ChatTurns<TestConnection>(quiet, {
      defaultDebounceMs: 750
    });
    quiet.turns = quietTurns;
    quiet.transcript = [user("u1"), toolReply("a1", "output-available")];
    await quietTurns.applyInteraction(
      async () => ({ status: "changed", messageId: "a1" }),
      true,
      spec
    );
    quiet.transcript = [...quiet.transcript, user("u2")];
    await fire();
    await drain();

    expect(quiet.ran).toEqual([]);
    expect(quiet.errors).toEqual([]);
    expect(quietTurns.continuation.pending).toBeNull();
  });

  it("continues a reply that only a message appended without a turn follows", async () => {
    // A detached run's note, stored with no turn. It is text, and it is not
    // the model's answer to the tool result.
    host.lastReply = "a1";
    await result("a1");
    host.transcript = [
      ...host.transcript,
      { id: "note", role: "assistant", parts: [{ type: "text", text: "FYI" }] }
    ];
    await fire();
    await drain();

    expect(host.ran).toEqual(["cont-1"]);
    expect(host.droppedEvents).toEqual([]);
  });

  it("does not continue a reply that went on to its answer before a message was appended", async () => {
    host.lastReply = "a1";
    await result("a1");
    host.transcript = [
      ...withAnswer(host.transcript),
      { id: "note", role: "assistant", parts: [{ type: "text", text: "FYI" }] }
    ];
    await fire();
    await drain();

    expect(host.ran).toEqual([]);
    expect(host.droppedEvents).toEqual(["cont-1:answered"]);
  });

  it("does nothing when no continuation is pending", async () => {
    await turns.runContinuationTurn(host.turn());

    expect(host.ran).toEqual([]);
    expect(host.errors).toEqual([]);
    expect(turns.aborts.size).toBe(0);
  });

  it("a turn the host could not enqueue releases the waiting connection and its abort signal", async () => {
    const turn = host.turn();
    host.turn = () => ({
      ...turn,
      enqueue: async () => {
        throw new Error("keep-alive lease failed");
      }
    });
    await result("a1");
    await fire();
    await drain();

    expect(host.ran).toEqual([]);
    expect(host.errors).toMatchObject([{ reported: false }]);
    // The tab is told there is no stream, the slot is free for the next
    // result, and no controller is left behind.
    expect(connection.sent).toEqual([RESUME_NONE]);
    expect(turns.continuation.pending).toBeNull();
    expect(turns.aborts.size).toBe(0);
    expect(turns.hasPendingDecision()).toBe(false);
  });

  it("a newer pending continuation with no deferred result is left as it is", async () => {
    const second = makeConnection("c2");
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") return;
      host.replyStreaming = true;
      turns.streamStarted("cont-1", () => {});
      // Arrives while the turn streams: a pending one, nothing deferred.
      await result("a1", second);
      host.replyStreaming = false;
      turns.replyFinalized();
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.errors).toEqual([]);
    expect(turns.continuation.pending?.requestId).toBe("cont-2");
    expect(turns.continuation.pending?.targetMessageIds).toEqual(["a1"]);
  });

  it("a turn a chat reset dropped from the queue leaves the new chat's continuations alone", async () => {
    let release!: () => void;
    const blocker = turns.queue.enqueue(
      "other",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    await result("a1");
    await fire();
    expect(turns.aborts.has("cont-1")).toBe(true);
    turns.reset();
    // The chat after the reset has a deferred result of its own by the time
    // the dropped turn ends. It is not the dropped turn's to run or drop.
    const deferred = {
      connection: makeConnection("c9"),
      connectionId: "c9",
      errorPrefix: "[test]",
      prerequisite: null,
      targetMessageIds: ["a9"]
    };
    turns.continuation.deferred = deferred;
    release();
    await blocker;
    await drain();

    expect(host.ran).toEqual([]);
    expect(host.errors).toEqual([]);
    expect(turns.aborts.has("cont-1")).toBe(false);
    expect(turns.continuation.deferred).toBe(deferred);
    expect(turns.continuation.pending).toBeNull();
  });

  it("a turn dropped from the queue does not clear a newer pending continuation", async () => {
    let release!: () => void;
    const blocker = turns.queue.enqueue(
      "other",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    await result("a1");
    await fire();
    turns.reset();
    host.transcript = [user("u9"), toolReply("a9", "output-available")];
    await result("a9");
    release();
    await blocker;
    await drain();

    expect(host.ran).toEqual([]);
    expect(turns.continuation.pending?.requestId).toBe("cont-2");
  });

  it("keeps a result that arrives before the stream deferred until the turn settles", async () => {
    const second = makeConnection("c2");
    let deferredAtStreamStart: unknown;
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") return;
      await result("a1", second);
      host.replyStreaming = true;
      turns.streamStarted("cont-1", () => {});
      deferredAtStreamStart = turns.continuation.deferred;
      expect(turns.continuation.pending).toBeNull();
      host.replyStreaming = false;
      turns.replyFinalized();
    };
    await result("a1");
    await fire();
    await drain();

    expect(deferredAtStreamStart).not.toBeNull();
    // The turn settled: the deferred result ran as the next continuation.
    expect(host.ran).toEqual(["cont-1", "cont-2"]);
    expect(turns.continuation.deferred).toBeNull();
    expect(turns.continuation.pending).toBeNull();
  });

  it("runs the deferred result after a continuation that failed before it streamed", async () => {
    const second = makeConnection("c2");
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") return;
      await result("a1", second);
      throw new Error("model down");
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.errors).toHaveLength(1);
    // The failed turn's own connection is released, and the result it
    // deferred still reaches the model.
    expect(connection.sent).toEqual([RESUME_NONE]);
    expect(host.ran).toEqual(["cont-1", "cont-2"]);
    expect(turns.aborts.has("cont-1")).toBe(false);
  });

  it("stops after the deferred result's continuation fails too", async () => {
    const second = makeConnection("c2");
    host.model = async (continuation) => {
      if (continuation.requestId === "cont-1") await result("a1", second);
      throw new Error("model down");
    };
    await result("a1");
    await fire();
    await drain();
    await fire();
    await drain();

    // Two results, two attempts, and nothing left to run a third.
    expect(host.ran).toEqual(["cont-1", "cont-2"]);
    expect(host.errors).toHaveLength(2);
    expect(second.sent).toEqual([RESUME_NONE]);
    expect(turns.continuation.pending).toBeNull();
    expect(turns.continuation.deferred).toBeNull();
    expect(turns.hasPendingDecision()).toBe(false);
  });

  it("does not run the deferred result once the reply went on to its answer", async () => {
    const second = makeConnection("c2");
    host.model = async (continuation) => {
      // A result lands while the turn waits on the model: deferred.
      await result("a1", second);
      await host.stream(continuation.requestId, true);
    };
    await result("a1");
    await fire();
    await drain();

    // The deferred result's turn finds a transcript that ends in the
    // model's answer: it calls no model and releases its connection.
    expect(host.ran).toEqual(["cont-1"]);
    expect(second.sent).toEqual([RESUME_NONE]);
    expect(turns.continuation.deferred).toBeNull();
    expect(turns.continuation.pending).toBeNull();
  });

  it("does not continue a reply whose stream went on to its answer", async () => {
    // The result lands while the reply streams, and the same stream then
    // writes the answer in a later step (#1618, #2171).
    host.replyStreaming = true;
    await result("a1");
    await fire();
    expect(host.ran).toEqual([]);

    host.transcript = withAnswer(host.transcript);
    host.replyStreaming = false;
    turns.replyFinalized();
    await fire();
    await drain();

    expect(host.ran).toEqual([]);
    expect(host.droppedEvents).toEqual(["cont-1:answered"]);
    expect(connection.sent).toEqual([RESUME_NONE]);
    expect(turns.continuation.pending).toBeNull();
  });

  it("continues a reply that ended on the tool call, text beside it or not", async () => {
    host.transcript = [
      user("u1"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "tool-x", toolCallId: "call-1", state: "output-available" },
          { type: "text", text: "Calling the tool." }
        ]
      }
    ];
    host.replyStreaming = true;
    await result("a1");
    host.replyStreaming = false;
    turns.replyFinalized();
    await fire();
    await drain();

    expect(host.ran).toEqual(["cont-1"]);
  });

  it("drops a result that arrives after the reply went on to its answer", async () => {
    // Two parallel calls. The reply got its answer step while the second
    // call was still unanswered (an app called continueLastTurn()). The
    // second result then arrives: continuing would end the request in
    // assistant text, so the result stays in the transcript for the next
    // turn and the waiting tab is released.
    host.transcript = withAnswer([
      user("u1"),
      toolReply("a1", "output-available", "output-available")
    ]);
    await result("a1");
    await fire();
    await drain();

    expect(host.ran).toEqual([]);
    expect(connection.sent).toEqual([RESUME_NONE]);
    expect(turns.continuation.pending).toBeNull();
  });

  it("a newer pending continuation takes over the targets of the deferred result it covers", async () => {
    const second = makeConnection("c2");
    const third = makeConnection("c3");
    host.transcript = [
      user("u0"),
      toolReply("a0", "output-available"),
      user("u1"),
      toolReply("a1", "output-available")
    ];
    let followUpTargets: readonly string[] | undefined;
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") {
        followUpTargets = continuation.targetMessageIds;
        return;
      }
      // Deferred, for the latest reply: arrives while the turn waits on
      // the model.
      await result("a1", second);
      host.replyStreaming = true;
      turns.streamStarted("cont-1", () => {});
      // A newer pending one, for an older reply: arrives while it streams.
      await result("a0", third);
      host.replyStreaming = false;
      turns.replyFinalized();
    };
    await result("a1");
    await fire();
    await drain();
    await fire();
    await drain();

    // The follow-up still answers the latest reply's result: it answers
    // both messages.
    expect(host.ran).toEqual(["cont-1", "cont-2"]);
    expect(followUpTargets).toEqual(["a0", "a1"]);
  });

  it("a stopped continuation drops the result deferred while it ran", async () => {
    const second = makeConnection("c2");
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") return;
      // Deferred: arrives while the turn waits on the model. Then the user
      // stops the continuation.
      await result("a1", second);
      turns.cancel(continuation.requestId);
      expect(turns.continuation.deferred).toBeNull();
      // The app is told, under the id of the turn the result waited behind.
      expect(host.droppedEvents).toEqual(["cont-1:stopped"]);
      // Its own continuation is left to its settle.
      expect(turns.continuation.pending?.requestId).toBe("cont-1");
    };
    await result("a1");
    await fire();
    await drain();
    await fire();
    await drain();

    expect(host.ran).toEqual(["cont-1"]);
    expect(turns.continuation.deferred).toBeNull();
    expect(turns.continuation.pending).toBeNull();
    expect(turns.hasPendingDecision()).toBe(false);
  });

  it("a result that arrives after a continuation was stopped still runs", async () => {
    const second = makeConnection("c2");
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") return;
      // The stop lands first. The stopped turn is still winding down when
      // a new result arrives: that is a new action.
      turns.cancel(continuation.requestId);
      await result("a1", second);
    };
    await result("a1");
    await fire();
    await drain();
    await fire();
    await drain();

    expect(host.ran).toEqual(["cont-1", "cont-2"]);
  });

  describe("a reply that is streaming", () => {
    let finishReply!: () => void;
    let reply: Promise<unknown>;

    /** A turn "req-1" runs and its reply streams until `finishReply()`. */
    const startReply = async () => {
      reply = turns.queue.enqueue(
        "req-1",
        () => new Promise<void>((resolve) => (finishReply = resolve))
      );
      await drain();
      host.replyStreaming = true;
    };
    const endReply = async () => {
      host.replyStreaming = false;
      turns.replyFinalized();
      finishReply();
      await reply;
    };

    it("drops the continuation its stream held when it is stopped", async () => {
      await startReply();
      // The result lands while the reply streams. Then the user stops it.
      await result("a1");
      turns.cancel("req-1");
      expect(connection.sent).toEqual([RESUME_NONE]);
      expect(turns.continuation.pending).toBeNull();

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual([]);
    });

    it("continues for a result that arrives after the stop", async () => {
      await startReply();
      await result("a1");
      turns.cancel("req-1");
      // Still streaming its last chunks: a new result is a new action.
      await result("a1");

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual(["cont-2"]);
    });

    it("drops the continuation when a recovered reply is stopped by its original request id", async () => {
      // The reply "req-1" is the recovered turn of a recovery attempt for
      // "original": its abort signal is linked to the attempt's.
      const attempt = turns.beginRecoveryAttempt("original");
      await startReply();
      turns.aborts.getSignal("req-1");
      turns.aborts.linkExternal("req-1", attempt.signal);
      await result("a1");

      // The client only knows the original id.
      turns.cancel("original");
      expect(turns.aborts.getExistingSignal("req-1")?.aborted).toBe(true);
      expect(connection.sent).toEqual([RESUME_NONE]);

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual([]);
      attempt.end();
    });

    it("keeps the continuation when a recovery attempt that is not the running turn is stopped", async () => {
      // The attempt still waits for the chat to be stable. Another reply
      // runs, and its continuation is not the attempt's to drop.
      const attempt = turns.beginRecoveryAttempt("original");
      await startReply();
      turns.aborts.getSignal("req-1");
      await result("a1");
      turns.cancel("original");

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual(["cont-1"]);
      attempt.end();
    });

    it("drops a result that was still being applied when the stop landed", async () => {
      await startReply();
      // The result's frame arrived, and its apply (a storage write) is
      // still running when the user stops the reply.
      let finishApply!: () => void;
      const applied = turns.applyInteraction(
        () =>
          new Promise((resolve) => {
            finishApply = () => resolve({ status: "changed", messageId: "a1" });
          }),
        true,
        () => spec()
      );
      await drain();
      turns.cancel("req-1");
      finishApply();
      await applied;

      expect(turns.continuation.pending).toBeNull();
      expect(host.droppedEvents).toEqual(["req-1:stopped"]);
      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual([]);
    });

    it("a second stop does not drop a result that arrived after the first", async () => {
      await startReply();
      await result("a1");
      turns.cancel("req-1");
      // A new action, while the stopped reply winds down.
      await result("a1");
      // The other tab presses stop too. It stops nothing.
      turns.cancel("req-1");

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual(["cont-2"]);
    });

    it("a stop after the runtime aborted the reply still drops", async () => {
      await startReply();
      turns.aborts.getSignal("req-1");
      await result("a1");
      turns.runtimeAbort(() => turns.cancel("req-1"));
      turns.cancel("req-1");

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual([]);
      expect(host.droppedEvents).toEqual(["cont-1:stopped"]);
    });

    it("stopping every request drops the continuation too", async () => {
      await startReply();
      turns.aborts.getSignal("req-1");
      await result("a1");
      turns.stopAll(new Error("stop everything"));
      expect(turns.aborts.size).toBe(0);
      expect(connection.sent).toEqual([RESUME_NONE]);

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual([]);
      expect(host.droppedEvents).toEqual(["cont-1:stopped"]);
    });

    it("a linked signal that stops the reply drops the continuation too", async () => {
      const external = new AbortController();
      await startReply();
      turns.aborts.getSignal("req-1");
      const unlink = turns.linkExternal("req-1", external.signal);
      await result("a1");
      external.abort(new Error("caller stopped"));
      expect(turns.aborts.getExistingSignal("req-1")?.aborted).toBe(true);

      await endReply();
      unlink();
      await fire();
      await drain();
      expect(host.ran).toEqual([]);
    });

    it("a linked signal for a request that is not running drops nothing", async () => {
      const external = new AbortController();
      await startReply();
      turns.aborts.getSignal("req-2");
      turns.linkExternal("req-2", external.signal);
      await result("a1");
      external.abort();
      expect(turns.aborts.getExistingSignal("req-2")?.aborted).toBe(true);

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual(["cont-1"]);
    });

    it("a signal that is already aborted stops the request when it is linked", () => {
      const external = new AbortController();
      external.abort(new Error("too late"));
      turns.linkExternal("req-9", external.signal);
      expect(turns.aborts.getExistingSignal("req-9")?.aborted).toBe(true);
    });

    it("keeps the continuation when another request is stopped", async () => {
      await startReply();
      await result("a1");
      // A request waiting in the queue is stopped, not the reply.
      turns.cancel("req-2");

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual(["cont-1"]);
    });

    it("keeps the continuation when the runtime aborts the reply for its own reasons", async () => {
      await startReply();
      await result("a1");
      // The stall watchdog aborts the turn, and recovery continues it.
      // That is not a stop, even though it goes through the host's
      // `abortRequest`, which is `cancel`.
      turns.aborts.getSignal("req-1");
      turns.runtimeAbort(() => turns.cancel("req-1"));
      expect(turns.aborts.getExistingSignal("req-1")?.aborted).toBe(true);

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual(["cont-1"]);
    });
  });

  it("leaves a newer pending continuation alone, and lets it cover the deferred result", async () => {
    const second = makeConnection("c2");
    const third = makeConnection("c3");
    let followUpTargets: readonly string[] | undefined;
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") {
        followUpTargets = continuation.targetMessageIds;
        return;
      }
      // Deferred: arrives while the turn waits on the model.
      await result("a1", second);
      host.replyStreaming = true;
      turns.streamStarted("cont-1", () => {});
      // A newer pending one: arrives while the turn streams.
      await result("a1", third);
      host.replyStreaming = false;
      turns.replyFinalized();
    };
    await result("a1");
    await fire();
    await drain();
    await fire();
    await drain();

    // One follow-up for both results, not two, and it names their message
    // once.
    expect(host.ran).toEqual(["cont-1", "cont-2"]);
    expect(followUpTargets).toEqual(["a1"]);
    expect(turns.continuation.deferred).toBeNull();
    expect(third.sent).toEqual([RESUME_NONE]);
  });
});

describe("what a continuation turn runs", () => {
  let host: FakeHost;
  let turns: ChatTurns<TestConnection>;
  let connection: TestConnection;

  const result = (messageId: string) =>
    turns.applyInteraction(
      async () => ({ status: "changed", messageId }),
      true,
      () => ({
        connection,
        clientTools: undefined,
        body: undefined,
        errorPrefix: "[test]"
      })
    );
  const fire = () => vi.advanceTimersByTimeAsync(COALESCE);
  const drain = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    turns = new ChatTurns<TestConnection>(host, { defaultDebounceMs: 750 });
    host.turns = turns;
    connection = makeConnection("c1");
    host.transcript = [user("u1"), toolReply("a1", "output-available")];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a failure before the stream: terminal record, then the frame, then the response hook", async () => {
    host.model = async () => {
      throw new Error("model down");
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.reports).toEqual([
      "describe:model down",
      "terminal:cont-1",
      "frame:cont-1:model down",
      "respond:a1:error:after-turn"
    ]);
    expect(host.errors).toMatchObject([
      { errorPrefix: "[test]", reported: true }
    ]);
  });

  it("reports a turn body that fails before the model is called", async () => {
    host.recoveryFails = true;
    await result("a1");
    await fire();
    await drain();

    expect(host.ran).toEqual([]);
    expect(host.reports).toEqual([
      "describe:recovery scope failed",
      "terminal:cont-1",
      "frame:cont-1:recovery scope failed",
      "respond:a1:error:after-turn"
    ]);
  });

  it("keeps the turn's own error when the error hook throws", async () => {
    host.describeThrows = true;
    host.model = async () => {
      throw new Error("model down");
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.errors).toHaveLength(1);
    expect((host.errors[0].error as Error).message).toBe("model down");
    expect(host.errors[0].reported).toBe(false);
  });

  it("a throwing onChatResponse does not undo the report", async () => {
    host.respondThrows = true;
    host.model = async () => {
      throw new Error("model down");
    };
    await result("a1");
    await fire();
    await drain();

    // The turn never rejects, whatever the hook does.
    await expect(host.fired).resolves.toBeUndefined();
    expect(host.errors).toMatchObject([{ reported: true }]);
    expect(host.reports.at(-1)).toBe("respond:a1:error:after-turn");
    expect(turns.continuation.pending).toBeNull();
  });

  it("reports a failed client request in the same order, with no response hook", async () => {
    const response = await turns.reportTurnFailure(host.turn().failure, {
      requestId: "req-1",
      error: new Error("persist failed"),
      continuation: false,
      stage: "persist"
    });

    expect(response).toBeUndefined();
    expect(host.reports).toEqual([
      "describe:persist failed:request",
      "terminal:req-1",
      "frame:req-1:persist failed:request"
    ]);
  });

  it("leaves a failure after the stream started to the reply pipeline", async () => {
    host.model = async (continuation) => {
      turns.streamStarted(continuation.requestId, () => {});
      throw new Error("persist failed");
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.reports).toEqual([]);
    expect(host.errors).toMatchObject([{ reported: false }]);
  });

  it("does not report a turn the Durable Object's reset cut off", async () => {
    // Recovery continues it after the restart: clients are told nothing.
    host.model = async () => {
      throw new Error("Durable Object reset because its code was updated.");
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.reports).toEqual([]);
    expect(host.errors).toMatchObject([{ reported: false }]);
  });

  it("does not report a turn that was stopped", async () => {
    host.model = async (continuation) => {
      turns.cancel(continuation.requestId);
      throw new Error("aborted");
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.reports).toEqual([]);
  });

  it("does not hand the host a stopped turn's error, whatever it threw", async () => {
    // A stopped provider call rejects with the stop's reason, not an
    // AbortError.
    host.model = async (continuation, signal) => {
      turns.cancel(continuation.requestId, "the user stopped it");
      throw signal.reason;
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.ran).toEqual(["cont-1"]);
    expect(host.errors).toEqual([]);
    expect(host.reports).toEqual([]);
  });

  it("hands the host the error of a turn the stall watchdog aborted", async () => {
    // The watchdog's abort is the runtime's, not a stop.
    host.model = async (continuation) => {
      turns.aborts.cancel(
        continuation.requestId,
        new ChatStreamStalledError("stalled")
      );
      throw new Error("stalled");
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.errors).toMatchObject([{ reported: false }]);
  });

  it("is not idle between the fire and the turn when the host's enqueue awaits first", async () => {
    // Think's admission awaits a keep-alive lease before it enqueues.
    const turn = host.turn();
    host.turn = () => ({
      ...turn,
      enqueue: async (requestId, run) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return turns.queue.enqueue(requestId, run);
      }
    });
    await result("a1");
    await fire();
    // Fired, and not on the queue yet.
    expect(turns.queue.isActive).toBe(false);
    expect(host.ran).toEqual([]);

    let idle = false;
    let stable = false;
    void turns.waitForIdle().then(() => (idle = true));
    void turns.waitUntilStable().then(() => (stable = true));
    await vi.advanceTimersByTimeAsync(1);
    expect(idle).toBe(false);
    expect(stable).toBe(false);

    await vi.advanceTimersByTimeAsync(2 * COALESCE);
    expect(host.ran).toEqual(["cont-1"]);
    expect(idle).toBe(true);
    expect(stable).toBe(true);
  });

  it("is idle again after a fired turn the queue dropped", async () => {
    const turn = host.turn();
    host.turn = () => ({
      ...turn,
      enqueue: async (requestId, run) => {
        const generation = turns.queue.generation;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return turns.queue.enqueue(requestId, run, { generation });
      }
    });
    await result("a1");
    await fire();
    turns.reset();
    await vi.advanceTimersByTimeAsync(10);

    expect(host.ran).toEqual([]);
    expect(turns.hasPendingDecision()).toBe(false);
  });

  it("the stream's start resumes connections parked on the turn's pre-stream window too", async () => {
    const parked = makeConnection("parked");
    const resumed: string[] = [];
    turns.preStream.begin("req-1");
    turns.preStream.park(parked);
    turns.streamStarted("req-1", (c) => resumed.push(c.id));

    expect(resumed).toEqual(["parked"]);
  });

  it("the stream of an ordinary turn leaves no record behind", () => {
    const state = new ContinuationState<TestConnection>();
    const parts = {
      continuation: state,
      autoContinuation: turns.autoContinuation,
      aborts: turns.aborts,
      messages: () => host.transcript,
      lastTurnReplyId: () => undefined,
      streamed: new Map<string, boolean>(),
      firing: new Set<object>(),
      dropped: () => {}
    };
    for (let i = 0; i < 100; i++) {
      continuationStreamStarted(parts, `req-${i}`, () => {});
    }

    expect(parts.streamed.size).toBe(0);
  });

  it("a continuation turn leaves no record behind", async () => {
    const parts = {
      continuation: turns.continuation,
      autoContinuation: turns.autoContinuation,
      aborts: turns.aborts,
      messages: () => host.transcript,
      lastTurnReplyId: () => undefined,
      streamed: new Map<string, boolean>(),
      firing: new Set<object>(),
      dropped: () => {}
    };
    host.model = async (continuation) => {
      expect(parts.streamed.get(continuation.requestId)).toBe(false);
      continuationStreamStarted(parts, continuation.requestId, () => {});
      expect(parts.streamed.get(continuation.requestId)).toBe(true);
    };
    await result("a1");
    turns.autoContinuation.cancelTimer();
    await runContinuationTurn(parts, host.turn());

    expect(host.ran).toEqual(["cont-1"]);
    expect(parts.streamed.size).toBe(0);
    expect(parts.firing.size).toBe(0);
  });

  it("the stream's end clears the continuation it made active", async () => {
    await result("a1");
    turns.streamStarted("cont-1", () => {});
    expect(turns.continuation.activeRequestId).toBe("cont-1");

    turns.streamEnded("other");
    expect(turns.continuation.activeRequestId).toBe("cont-1");
    turns.streamEnded("cont-1");
    expect(turns.continuation.activeRequestId).toBeNull();
    expect(turns.continuation.activeConnectionId).toBeNull();
  });

  describe("with no pending continuation", () => {
    const unscheduled = (requestId = "free-1") =>
      turns.runUnscheduledContinuationTurn(
        host.turn(),
        { requestId, connection: undefined, targetMessageIds: ["a1"] },
        "[free]"
      );

    it("runs the same turn with no connection, and settles nothing", async () => {
      // A pending continuation of a connection is not this turn's.
      await result("a1");
      await unscheduled();

      expect(host.ran).toEqual(["free-1"]);
      expect(turns.aborts.has("free-1")).toBe(false);
      expect(turns.continuation.pending?.requestId).toBe("cont-1");
      expect(turns.continuation.pending?.pastCoalesce).toBe(false);
    });

    it("never calls the model when it was stopped while it waited in the queue", async () => {
      let release!: () => void;
      const blocker = turns.queue.enqueue(
        "other",
        () => new Promise<void>((resolve) => (release = resolve))
      );
      const done = unscheduled();
      expect(turns.aborts.has("free-1")).toBe(true);
      turns.cancel("free-1");
      await drain();
      release();
      await blocker;
      await done;

      expect(host.ran).toEqual([]);
      expect(turns.aborts.has("free-1")).toBe(false);
    });

    it("runs nothing once the conversation moved past the message it answers", async () => {
      host.transcript = [...host.transcript, user("u2")];
      await unscheduled();

      expect(host.ran).toEqual([]);
      expect(host.droppedEvents).toEqual(["free-1:moved_on"]);
      expect(turns.aborts.has("free-1")).toBe(false);
    });

    it("runs nothing once the message it answers went on to its answer", async () => {
      host.transcript = withAnswer(host.transcript);
      await unscheduled();

      expect(host.ran).toEqual([]);
      expect(host.droppedEvents).toEqual(["free-1:answered"]);
    });

    it("runs nothing in a chat that was cleared since", async () => {
      host.transcript = [];
      await unscheduled();

      expect(host.ran).toEqual([]);
      expect(host.droppedEvents).toEqual(["free-1:moved_on"]);
    });

    it("reports a failure before the stream", async () => {
      host.model = async () => {
        throw new Error("model down");
      };
      await unscheduled();

      expect(host.reports).toEqual([
        "describe:model down",
        "terminal:free-1",
        "frame:free-1:model down",
        "respond:a1:error:after-turn"
      ]);
      expect(host.errors).toMatchObject([
        { errorPrefix: "[free]", reported: true }
      ]);
    });
  });
});

describe("transcriptEndsInAnswer", () => {
  const assistant = (...parts: unknown[]): ChatTurnMessage => ({
    id: "a",
    role: "assistant",
    parts
  });
  const tool = { type: "tool-x", toolCallId: "c", state: "output-available" };
  const text = { type: "text", text: "Done." };
  const step = { type: "step-start" };

  it("is true when the last step is the model's text", () => {
    expect(transcriptEndsInAnswer([assistant(step, text)])).toBe(true);
    expect(transcriptEndsInAnswer([assistant(step, tool, step, text)])).toBe(
      true
    );
  });

  it("is false when the last step holds a tool part", () => {
    expect(transcriptEndsInAnswer([assistant(step, tool)])).toBe(false);
    expect(transcriptEndsInAnswer([assistant(step, tool, text)])).toBe(false);
    expect(transcriptEndsInAnswer([assistant(step, text, step, tool)])).toBe(
      false
    );
    expect(
      transcriptEndsInAnswer([
        assistant(step, { type: "dynamic-tool", toolCallId: "d" })
      ])
    ).toBe(false);
  });

  it("treats a message with no step-start as one step", () => {
    // convertToModelMessages turns [tool, text] into an assistant message
    // and then the tool result, so the request ends in the result.
    expect(transcriptEndsInAnswer([assistant(tool, text)])).toBe(false);
    expect(transcriptEndsInAnswer([assistant(text, tool)])).toBe(false);
    expect(transcriptEndsInAnswer([assistant(text)])).toBe(true);
  });

  it("skips a provider-executed tool, whose result stays in the assistant message", () => {
    // convertToModelMessages keeps the call and the result of a
    // provider-executed tool inside the assistant message, so text after it
    // still ends the request.
    const webSearch = {
      type: "tool-web_search",
      toolCallId: "w",
      state: "output-available",
      providerExecuted: true
    };
    expect(
      transcriptEndsInAnswer([assistant(step, tool, step, webSearch, text)])
    ).toBe(true);
    // With no text after it, the request ends in the step before.
    expect(
      transcriptEndsInAnswer([assistant(step, tool, step, webSearch)])
    ).toBe(false);
  });

  it("is false when the last step holds only a server tool's result", () => {
    // The request ends in that result and the model has not answered it.
    const serverTool = {
      type: "tool-search",
      toolCallId: "s",
      state: "output-available"
    };
    expect(
      transcriptEndsInAnswer([assistant(step, tool, step, serverTool)])
    ).toBe(false);
  });

  it("does not count a last step of reasoning alone as an answer", () => {
    // Providers accept a request that ends this way and answer from the
    // tool result, so the continuation runs.
    const reasoning = { type: "reasoning", text: "Thinking." };
    expect(
      transcriptEndsInAnswer([assistant(step, tool, step, reasoning)])
    ).toBe(false);
    expect(
      transcriptEndsInAnswer([assistant(step, tool, step, reasoning, text)])
    ).toBe(true);
  });

  it("looks past a step with nothing in it", () => {
    expect(transcriptEndsInAnswer([assistant(step, tool, step)])).toBe(false);
    expect(
      transcriptEndsInAnswer([
        assistant(step, tool, step, { type: "text", text: "" })
      ])
    ).toBe(false);
    expect(transcriptEndsInAnswer([assistant(step, text, step)])).toBe(true);
  });

  it("counts a file as the model's answer", () => {
    const file = { type: "file", mediaType: "image/png", url: "data:," };
    expect(transcriptEndsInAnswer([assistant(step, tool, step, file)])).toBe(
      true
    );
  });

  it("does not count empty text as an answer", () => {
    expect(
      transcriptEndsInAnswer([
        assistant(step, tool, step, { type: "text", text: "" })
      ])
    ).toBe(false);
  });

  it("looks past a part with no type", () => {
    expect(transcriptEndsInAnswer([assistant(step, text, {})])).toBe(true);
    expect(transcriptEndsInAnswer([assistant(step, tool, { type: 7 })])).toBe(
      false
    );
  });

  it("is false when the latest message is not an assistant reply", () => {
    expect(transcriptEndsInAnswer([])).toBe(false);
    expect(transcriptEndsInAnswer([assistant(step, text), user("u")])).toBe(
      false
    );
  });
});
