import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { getCurrentAgent } from "../../lifecycle/current-agent";
import {
  transcriptEndsInAnswer,
  type ContinuationTurn
} from "../continuation-turn";
import { CHAT_MESSAGE_TYPES } from "../protocol";

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
  keepAliveWhile<T>(fn: () => Promise<T>) {
    return fn();
  }
  fireContinuation() {
    void this.turns.runContinuationTurn(this.turn());
  }

  /** What the reply pipeline reported, in order. */
  reports: string[] = [];
  /** Set to make the recovery scope fail before it runs the body. */
  recoveryFails = false;
  /** `getCurrentAgent()` as each step saw it. */
  contexts: Array<{ step: string; agent: unknown; connection: unknown }> = [];

  private see(step: string) {
    const { agent, connection } = getCurrentAgent();
    this.contexts.push({ step, agent, connection });
  }

  /**
   * The turn a host supplies. `model` stands for both the model call and
   * the stream, so one function drives a test.
   */
  turn(): ContinuationTurn<TestConnection, true, ChatTurnMessage> {
    return {
      agent: this,
      enqueue: (requestId, turn) => this.turns.queue.enqueue(requestId, turn),
      recover: async (_requestId, body) => {
        if (this.recoveryFails) throw new Error("recovery scope failed");
        await body();
      },
      model: async (continuation, signal) => {
        this.see("model");
        this.ran.push(continuation.requestId);
        await this.model(
          continuation as ContinuationPending<TestConnection>,
          signal
        );
        return true;
      },
      stream: async () => {
        this.see("stream");
      },
      failure: {
        describe: (error) => {
          const message = error instanceof Error ? error.message : "failed";
          this.reports.push(`describe:${message}`);
          return message;
        },
        recordTerminal: async (requestId) => {
          this.reports.push(`terminal:${requestId}`);
        },
        broadcast: (frame) => {
          this.reports.push(`frame:${frame.id}:${frame.body}`);
        },
        respond: (result) => {
          this.reports.push(`respond:${result.message.id}:${result.status}`);
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
    host.model = async (continuation, signal) => {
      seen = signal;
      expect(continuation.pastCoalesce).toBe(true);
      expect(turns.aborts.has(continuation.requestId)).toBe(true);
      await host.stream(continuation.requestId, true);
    };
    await result("a1");
    await fire();
    await drain();

    expect(host.ran).toEqual(["cont-1"]);
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
    expect(connection.sent).toEqual([RESUME_NONE]);
    expect(turns.continuation.pending).toBeNull();
    expect(turns.aborts.has("cont-1")).toBe(false);
  });

  it("claims only the continuation the turn was fired for", async () => {
    await result("a1");
    expect(turns.takeContinuation("cont-other")).toBeNull();
    expect(turns.continuation.pending?.pastCoalesce).toBe(false);
    expect(turns.takeContinuation("cont-1")?.requestId).toBe("cont-1");
  });

  it("runs nothing once the conversation moved on, and releases the waiting connection", async () => {
    await result("a1");
    host.transcript = [...host.transcript, user("u2")];
    await fire();
    await drain();

    expect(host.ran).toEqual([]);
    expect(connection.sent).toEqual([RESUME_NONE]);
    expect(turns.continuation.pending).toBeNull();
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
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") return;
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

    // The follow-up still answers the latest reply's result.
    expect(host.ran).toEqual(["cont-1", "cont-2"]);
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
      // A stall watchdog or a superseded submit aborts through the
      // registry. That is not a stop.
      turns.aborts.getSignal("req-1");
      turns.aborts.cancel("req-1");

      await endReply();
      await fire();
      await drain();
      expect(host.ran).toEqual(["cont-1"]);
    });
  });

  it("leaves a newer pending continuation alone, and lets it cover the deferred result", async () => {
    const second = makeConnection("c2");
    const third = makeConnection("c3");
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") return;
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

    // One follow-up for both results, not two.
    expect(host.ran).toEqual(["cont-1", "cont-2"]);
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

  it("runs the model call and the stream in the agent context of the continuation's connection", async () => {
    await result("a1");
    await fire();
    await drain();

    expect(host.contexts).toEqual([
      { step: "model", agent: host, connection },
      { step: "stream", agent: host, connection }
    ]);
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
      "respond:a1:error"
    ]);
    expect(host.errors).toMatchObject([
      { errorPrefix: "[test]", reported: true }
    ]);
  });

  it("reports a recovery scope that fails before the model is called", async () => {
    host.recoveryFails = true;
    await result("a1");
    await fire();
    await drain();

    expect(host.ran).toEqual([]);
    expect(host.reports).toEqual([
      "describe:recovery scope failed",
      "terminal:cont-1",
      "frame:cont-1:recovery scope failed",
      "respond:a1:error"
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

  it("the stream's start resumes connections parked on the turn's pre-stream window too", async () => {
    const parked = makeConnection("parked");
    const resumed: string[] = [];
    turns.preStream.begin("req-1");
    turns.preStream.park(parked);
    turns.streamStarted("req-1", (c) => resumed.push(c.id));

    expect(resumed).toEqual(["parked"]);
  });

  it("the stream's end clears the continuation it made active", async () => {
    await result("a1");
    turns.takeContinuation("cont-1");
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
        { requestId, connection: undefined },
        "[free]"
      );

    it("runs the same turn with no connection, and settles nothing", async () => {
      // A pending continuation of a connection is not this turn's.
      await result("a1");
      await unscheduled();

      expect(host.ran).toEqual(["free-1"]);
      expect(host.contexts).toEqual([
        { step: "model", agent: host, connection: undefined },
        { step: "stream", agent: host, connection: undefined }
      ]);
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

    it("reports a failure before the stream", async () => {
      host.model = async () => {
        throw new Error("model down");
      };
      await unscheduled();

      expect(host.reports).toEqual([
        "describe:model down",
        "terminal:free-1",
        "frame:free-1:model down",
        "respond:a1:error"
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

  it("is false when the last step holds only a server tool's result", () => {
    // The request ends in that result and the model has not answered it.
    const serverTool = {
      type: "tool-search",
      toolCallId: "s",
      state: "output-available",
      providerExecuted: true
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

  it("is false when the latest message is not an assistant reply", () => {
    expect(transcriptEndsInAnswer([])).toBe(false);
    expect(transcriptEndsInAnswer([assistant(step, text), user("u")])).toBe(
      false
    );
  });
});
