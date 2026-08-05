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

const textDelta = (id: string, delta: string): UIMessageChunk => ({
  delta,
  id,
  type: "text-delta"
});

const replayFrame = (chunk: UIMessageChunk) => ({
  body: JSON.stringify(chunk),
  done: false,
  replay: true
});

describe("ReplayChunkBatch", () => {
  it("merges consecutive deltas of the same part", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

    batch.push(textDelta("t1", "Hello"));
    batch.push(textDelta("t1", " "));
    batch.push(textDelta("t1", "world"));
    batch.flush(controller);

    expect(enqueued).toEqual([textDelta("t1", "Hello world")]);
  });

  it("does not merge across different parts, preserving order", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

    batch.push(textDelta("t1", "a"));
    batch.push({ id: "r1", type: "reasoning-delta", delta: "why" });
    batch.push(textDelta("t1", "b"));
    batch.push(textDelta("t2", "c"));
    batch.flush(controller);

    expect(enqueued).toEqual([
      textDelta("t1", "a"),
      { delta: "why", id: "r1", type: "reasoning-delta" },
      textDelta("t1", "b"),
      textDelta("t2", "c")
    ]);
  });

  it("merges tool input deltas by tool call id", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

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
    batch.flush(controller);

    expect(enqueued).toEqual([
      { inputTextDelta: '{"a":1}', toolCallId: "c1", type: "tool-input-delta" },
      { inputTextDelta: "{}", toolCallId: "c2", type: "tool-input-delta" }
    ]);
  });

  it("keeps deltas carrying provider metadata whole", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();
    const withMetadata: UIMessageChunk = {
      delta: "b",
      id: "t1",
      providerMetadata: { openai: { logprob: 1 } },
      type: "text-delta"
    };

    batch.push(textDelta("t1", "a"));
    batch.push(withMetadata);
    batch.push(textDelta("t1", "c"));
    batch.flush(controller);

    expect(enqueued).toEqual([
      textDelta("t1", "a"),
      withMetadata,
      textDelta("t1", "c")
    ]);
  });

  it("empties itself on flush", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

    batch.push(textDelta("t1", "a"));
    expect(batch.isEmpty).toBe(false);
    batch.flush(controller);
    expect(batch.isEmpty).toBe(true);

    batch.flush(controller);
    expect(enqueued).toHaveLength(1);
  });
});

describe("applyChatResponseFrame", () => {
  it("buffers mid-burst replay chunks instead of enqueuing them", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

    applyChatResponseFrame(
      batch,
      controller,
      replayFrame(textDelta("t1", "a"))
    );
    applyChatResponseFrame(
      batch,
      controller,
      replayFrame(textDelta("t1", "b"))
    );

    expect(enqueued).toEqual([]);
    expect(batch.isEmpty).toBe(false);
  });

  it("flushes at replayComplete, which carries an empty body", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

    applyChatResponseFrame(
      batch,
      controller,
      replayFrame(textDelta("t1", "a"))
    );
    applyChatResponseFrame(
      batch,
      controller,
      replayFrame(textDelta("t1", "b"))
    );
    applyChatResponseFrame(batch, controller, {
      body: "",
      done: false,
      replay: true,
      replayComplete: true
    });

    expect(enqueued).toEqual([textDelta("t1", "ab")]);
  });

  it("flushes at done for streams that never send replayComplete", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

    applyChatResponseFrame(
      batch,
      controller,
      replayFrame(textDelta("t1", "a"))
    );
    applyChatResponseFrame(batch, controller, {
      body: "",
      done: true,
      replay: true
    });

    expect(enqueued).toEqual([textDelta("t1", "a")]);
  });

  it("flushes the batch before the first live chunk", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

    applyChatResponseFrame(
      batch,
      controller,
      replayFrame(textDelta("t1", "a"))
    );
    applyChatResponseFrame(batch, controller, {
      body: JSON.stringify(textDelta("t1", "live")),
      done: false
    });

    expect(enqueued).toEqual([textDelta("t1", "a"), textDelta("t1", "live")]);
  });

  it("passes live chunks straight through", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

    applyChatResponseFrame(batch, controller, {
      body: JSON.stringify(textDelta("t1", "a")),
      done: false
    });

    expect(enqueued).toEqual([textDelta("t1", "a")]);
    expect(batch.isEmpty).toBe(true);
  });

  it("skips malformed bodies without stranding the batch", () => {
    const { controller, enqueued } = createRecorder();
    const batch = new ReplayChunkBatch();

    applyChatResponseFrame(
      batch,
      controller,
      replayFrame(textDelta("t1", "a"))
    );
    applyChatResponseFrame(batch, controller, {
      body: "not json",
      done: false,
      replay: true
    });
    applyChatResponseFrame(batch, controller, { body: "not json", done: true });

    expect(enqueued).toEqual([textDelta("t1", "a")]);
  });
});

describe("failChatStream", () => {
  it("errors the stream directly when nothing is buffered", () => {
    const { controller, events } = createRecorder();

    failChatStream(new ReplayChunkBatch(), controller, "boom");

    expect(events).toEqual(["error:boom"]);
  });

  it("delivers buffered content before the error (#1575)", () => {
    const { controller, enqueued, events } = createRecorder();
    const batch = new ReplayChunkBatch();

    applyChatResponseFrame(
      batch,
      controller,
      replayFrame(textDelta("t1", "a"))
    );
    failChatStream(batch, controller, "model exploded");

    expect(enqueued).toEqual([
      textDelta("t1", "a"),
      { errorText: "model exploded", type: "error" }
    ]);
    expect(events).toEqual(["enqueue:text-delta", "enqueue:error", "close"]);
  });
});
