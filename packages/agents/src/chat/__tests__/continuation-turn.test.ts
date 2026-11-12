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
import { transcriptEndsInAnswer } from "../continuation-turn";
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
  errors: unknown[] = [];
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
    void this.turns.runContinuationTurn({
      enqueue: (requestId, turn) => this.turns.queue.enqueue(requestId, turn),
      run: async (continuation, signal) => {
        this.ran.push(continuation.requestId);
        await this.model(continuation, signal);
      },
      onError: (error) => void this.errors.push(error)
    });
  }

  /**
   * What a host does when its reply stream starts and ends. `answer` appends
   * a step of text to the latest reply: the model went on to its answer.
   */
  async stream(requestId: string, answer = false) {
    this.replyStreaming = true;
    this.turns.continuationStreamStarted(requestId, (connection) =>
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

  it("settles a turn a chat reset dropped from the queue", async () => {
    let release!: () => void;
    const blocker = turns.queue.enqueue(
      "other",
      () => new Promise<void>((resolve) => (release = resolve))
    );
    await result("a1");
    await fire();
    turns.reset();
    // A continuation of the new chat, scheduled before the stale turn is
    // dequeued, is not the stale turn's to clear.
    host.transcript = [user("u9"), toolReply("a9", "output-available")];
    await result("a9");
    release();
    await blocker;
    await drain();

    expect(host.ran).toEqual([]);
    expect(host.errors).toEqual([]);
    expect(turns.continuation.pending?.requestId).toBe("cont-2");
  });

  it("keeps a result that arrives before the stream deferred until the turn settles", async () => {
    const second = makeConnection("c2");
    let deferredAtStreamStart: unknown;
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") return;
      await result("a1", second);
      host.replyStreaming = true;
      turns.continuationStreamStarted("cont-1", () => {});
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

  it("leaves a newer pending continuation alone, and lets it cover the deferred result", async () => {
    const second = makeConnection("c2");
    const third = makeConnection("c3");
    host.model = async (continuation) => {
      if (continuation.requestId !== "cont-1") return;
      // Deferred: arrives while the turn waits on the model.
      await result("a1", second);
      host.replyStreaming = true;
      turns.continuationStreamStarted("cont-1", () => {});
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
    expect(
      transcriptEndsInAnswer([
        assistant(step, tool, step, { type: "reasoning", text: "Thinking." })
      ])
    ).toBe(true);
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
