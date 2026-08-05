import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import {
  applyChatResponseFrame,
  failChatStream,
  ReplayChunkBatch
} from "../replay-batch";

/** Minimal stand-in for the stream controller the transport owns. */
function createRecorder() {
  const enqueued: UIMessageChunk[] = [];
  const events: string[] = [];
  const controller = {
    close: () => {
      events.push("close");
    },
    enqueue: (chunk: UIMessageChunk) => {
      enqueued.push(chunk);
      events.push(`enqueue:${chunk.type}`);
    },
    error: (err: unknown) => {
      events.push(`error:${(err as Error).message}`);
    }
  } as unknown as ReadableStreamDefaultController<UIMessageChunk>;
  return { controller, enqueued, events };
}

/**
 * A batch whose end-of-turn window is closed manually, so tests decide when
 * the turn ends instead of racing a timer.
 */
function createBatch(
  controller: ReadableStreamDefaultController<UIMessageChunk>
) {
  let pending: (() => void) | undefined;
  const batch = new ReplayChunkBatch(controller, (flush) => {
    pending = flush;
    return () => {
      pending = undefined;
    };
  });
  return {
    batch,
    /** Runs the end-of-turn flush, as the event loop would. */
    endTurn: () => pending?.(),
    windowIsOpen: () => pending !== undefined
  };
}

const textDelta = (id: string, delta: string): UIMessageChunk => ({
  delta,
  id,
  type: "text-delta"
});

/** One replay pass of message `m1`: `start`, `text-start`, then deltas. */
const replayPass = (...deltas: string[]): UIMessageChunk[] => [
  { messageId: "m1", type: "start" },
  { id: "t1", type: "text-start" },
  ...deltas.map((delta) => textDelta("t1", delta))
];

const replayFrame = (chunk: UIMessageChunk) => ({
  body: JSON.stringify(chunk),
  done: false,
  replay: true
});

describe("ReplayChunkBatch", () => {
  it("merges consecutive deltas of the same part", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    batch.push(textDelta("t1", "Hello"));
    batch.push(textDelta("t1", " "));
    batch.push(textDelta("t1", "world"));
    batch.flush();

    expect(enqueued).toEqual([textDelta("t1", "Hello world")]);
  });

  it("does not merge across different parts, preserving order", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    batch.push(textDelta("t1", "a"));
    batch.push({ id: "r1", type: "reasoning-delta", delta: "why" });
    batch.push(textDelta("t1", "b"));
    batch.push(textDelta("t2", "c"));
    batch.flush();

    expect(enqueued).toEqual([
      textDelta("t1", "a"),
      { delta: "why", id: "r1", type: "reasoning-delta" },
      textDelta("t1", "b"),
      textDelta("t2", "c")
    ]);
  });

  it("merges tool input deltas by tool call id", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    batch.push({
      inputTextDelta: '{"a"',
      toolCallId: "c1",
      type: "tool-input-delta"
    });
    batch.push({
      inputTextDelta: ":1}",
      toolCallId: "c1",
      type: "tool-input-delta"
    });
    batch.push({
      inputTextDelta: "{}",
      toolCallId: "c2",
      type: "tool-input-delta"
    });
    batch.flush();

    expect(enqueued).toEqual([
      { inputTextDelta: '{"a":1}', toolCallId: "c1", type: "tool-input-delta" },
      { inputTextDelta: "{}", toolCallId: "c2", type: "tool-input-delta" }
    ]);
  });

  it("keeps deltas carrying provider metadata whole", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);
    const withMetadata: UIMessageChunk = {
      delta: "b",
      id: "t1",
      providerMetadata: { openai: { logprob: 1 } },
      type: "text-delta"
    };

    batch.push(textDelta("t1", "a"));
    batch.push(withMetadata);
    batch.push(textDelta("t1", "c"));
    batch.flush();

    expect(enqueued).toEqual([
      textDelta("t1", "a"),
      withMetadata,
      textDelta("t1", "c")
    ]);
  });

  it("empties itself on flush", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    batch.push(textDelta("t1", "a"));
    expect(batch.isEmpty).toBe(false);
    batch.flush();
    expect(batch.isEmpty).toBe(true);

    batch.flush();
    expect(enqueued).toHaveLength(1);
  });
});

describe("applyChatResponseFrame", () => {
  it("buffers mid-burst replay chunks instead of enqueuing them", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "a")));
    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "b")));

    expect(enqueued).toEqual([]);
    expect(batch.isEmpty).toBe(false);
  });

  it("flushes at replayComplete, which carries an empty body", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "a")));
    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "b")));
    applyChatResponseFrame(batch, {
      body: "",
      done: false,
      replay: true,
      replayComplete: true
    });

    expect(enqueued).toEqual([textDelta("t1", "ab")]);
  });

  it("flushes at done for streams that never send replayComplete", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "a")));
    applyChatResponseFrame(batch, {
      body: "",
      done: true,
      replay: true
    });

    expect(enqueued).toEqual([textDelta("t1", "a")]);
  });

  it("flushes the batch before the first live chunk", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "a")));
    applyChatResponseFrame(batch, {
      body: JSON.stringify(textDelta("t1", "live")),
      done: false
    });

    expect(enqueued).toEqual([textDelta("t1", "a"), textDelta("t1", "live")]);
  });

  it("passes live chunks straight through", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    applyChatResponseFrame(batch, {
      body: JSON.stringify(textDelta("t1", "a")),
      done: false
    });

    expect(enqueued).toEqual([textDelta("t1", "a")]);
    expect(batch.isEmpty).toBe(true);
  });

  it("skips malformed bodies without stranding the batch", () => {
    const { controller, enqueued } = createRecorder();
    const { batch } = createBatch(controller);

    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "a")));
    applyChatResponseFrame(batch, {
      body: "not json",
      done: false,
      replay: true
    });
    applyChatResponseFrame(batch, { body: "not json", done: true });

    expect(enqueued).toEqual([textDelta("t1", "a")]);
  });
});

describe("the end-of-turn window", () => {
  it("flushes a burst that never sends a terminator", () => {
    const { controller, enqueued } = createRecorder();
    const { batch, endTurn } = createBatch(controller);

    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "a")));
    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "b")));
    expect(enqueued).toEqual([]);

    endTurn();

    expect(enqueued).toEqual([textDelta("t1", "ab")]);
  });

  it("never holds chunks across turns, so replay passes stay separate", () => {
    const { controller, enqueued } = createRecorder();
    const { batch, endTurn } = createBatch(controller);

    // A second announcement of the same stream replays the turn again (#1733).
    // The hook repairs that duplicate by inspecting messages the first pass
    // already applied, so two passes must never merge into one batch.
    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "Hello")));
    endTurn();
    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "Hello")));
    endTurn();

    expect(enqueued).toEqual([
      textDelta("t1", "Hello"),
      textDelta("t1", "Hello")
    ]);
  });

  it("supersedes a buffered pass when the same turn replays again", () => {
    const { controller, enqueued } = createRecorder();
    const { batch, endTurn } = createBatch(controller);

    // Two announcements of one stream can replay the turn twice before either
    // pass is delivered (#1733). Every replay rebuilds from its first chunk, so
    // delivering both would duplicate the message's parts. This must not
    // depend on which pass the flush timer happens to land between.
    for (const chunk of replayPass("Hello ", "world")) {
      applyChatResponseFrame(batch, replayFrame(chunk));
    }
    for (const chunk of replayPass("Hello ", "world")) {
      applyChatResponseFrame(batch, replayFrame(chunk));
    }
    endTurn();

    expect(enqueued).toEqual([
      { messageId: "m1", type: "start" },
      { id: "t1", type: "text-start" },
      textDelta("t1", "Hello world")
    ]);
  });

  it("keeps a continuation replay, which appends instead of rebuilding", () => {
    const { controller, enqueued } = createRecorder();
    const { batch, endTurn } = createBatch(controller);

    for (const chunk of replayPass("first")) {
      applyChatResponseFrame(batch, {
        ...replayFrame(chunk),
        continuation: true
      });
    }
    for (const chunk of replayPass("second")) {
      applyChatResponseFrame(batch, {
        ...replayFrame(chunk),
        continuation: true
      });
    }
    endTurn();

    expect(enqueued).toHaveLength(6);
  });

  it("closes the window when a terminator arrives first", () => {
    const { controller, enqueued } = createRecorder();
    const { batch, endTurn, windowIsOpen } = createBatch(controller);

    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "a")));
    expect(windowIsOpen()).toBe(true);

    applyChatResponseFrame(batch, {
      body: "",
      done: false,
      replay: true,
      replayComplete: true
    });
    expect(windowIsOpen()).toBe(false);

    endTurn();
    expect(enqueued).toEqual([textDelta("t1", "a")]);
  });
});

describe("failChatStream", () => {
  it("errors the stream directly when nothing is buffered", () => {
    const { controller, events } = createRecorder();

    failChatStream(new ReplayChunkBatch(controller), "boom");

    expect(events).toEqual(["error:boom"]);
  });

  it("delivers buffered content before the error (#1575)", () => {
    const { controller, enqueued, events } = createRecorder();
    const { batch } = createBatch(controller);

    applyChatResponseFrame(batch, replayFrame(textDelta("t1", "a")));
    failChatStream(batch, "model exploded");

    expect(enqueued).toEqual([
      textDelta("t1", "a"),
      { errorText: "model exploded", type: "error" }
    ]);
    expect(events).toEqual(["enqueue:text-delta", "enqueue:error", "close"]);
  });
});
