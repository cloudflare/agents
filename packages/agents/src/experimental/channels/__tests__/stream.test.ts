import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelGateway,
  consumeChunks,
  type Channel,
  type ResponseChunk,
  type DeliveryResult
} from "..";
import { collectText, createPacer } from "../stream";

const surface = {
  channelKey: "test",
  version: 1,
  address: null,
  label: "Test destination"
} as const;

function streamOf<T>(values: readonly T[], error?: unknown): ReadableStream<T> {
  let index = 0;
  return new ReadableStream<T>({
    pull(controller) {
      if (index < values.length) {
        controller.enqueue(values[index]!);
        index += 1;
        return;
      }
      if (error !== undefined) controller.error(error);
      else controller.close();
    }
  });
}

function text(...parts: string[]): ResponseChunk[] {
  return [
    { type: "text-start", id: "text" },
    ...parts.map((delta) => ({
      type: "text-delta" as const,
      id: "text",
      delta
    })),
    { type: "text-end", id: "text" }
  ];
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function host(channels: Record<string, Channel>) {
  return new ChannelGateway({
    channels,
    agent: () => {
      throw new Error("no agent");
    }
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("collectText", () => {
  it("joins every text chunk and ignores the other variants", async () => {
    const chunks: ResponseChunk[] = [
      { type: "reasoning-start", id: "reasoning" },
      { type: "reasoning-delta", id: "reasoning", delta: "thinking" },
      { type: "reasoning-end", id: "reasoning" },
      { type: "text-start", id: "first" },
      { type: "text-delta", id: "first", delta: "Hello " },
      { type: "text-end", id: "first" },
      {
        type: "tool-input-available",
        toolCallId: "search-1",
        toolName: "search",
        input: {}
      },
      {
        type: "tool-output-available",
        toolCallId: "search-1",
        output: "done"
      },
      { type: "text-start", id: "second" },
      { type: "text-delta", id: "second", delta: "world" },
      { type: "text-end", id: "second" },
      {
        type: "source-url",
        sourceId: "source-1",
        url: "https://example.com"
      }
    ];

    await expect(collectText(streamOf(chunks))).resolves.toEqual({
      text: "Hello world",
      interrupted: false
    });
  });

  it("separates text segments divided by a semantic chunk", async () => {
    const chunks: ResponseChunk[] = [
      { type: "text-start", id: "first" },
      { type: "text-delta", id: "first", delta: "Hello" },
      { type: "text-end", id: "first" },
      {
        type: "tool-output-available",
        toolCallId: "search-1",
        output: "done"
      },
      { type: "text-start", id: "second" },
      { type: "text-delta", id: "second", delta: "world" },
      { type: "text-end", id: "second" }
    ];

    await expect(collectText(streamOf(chunks))).resolves.toEqual({
      text: "Hello world",
      interrupted: false
    });
  });

  it("does not separate adjacent text deltas", async () => {
    await expect(
      collectText(streamOf(text("Half an", "swer")))
    ).resolves.toEqual({
      text: "Half answer",
      interrupted: false
    });
  });

  it("reports interruption instead of losing the partial answer", async () => {
    const chunks = streamOf(text("Half an "), new Error("model failed"));

    await expect(collectText(chunks)).resolves.toEqual({
      text: "Half an ",
      interrupted: true
    });
  });
});

describe("consumeChunks", () => {
  it("finalizes once when the stream closes normally", async () => {
    const onFinish = vi.fn(() => "done");

    await expect(
      consumeChunks(streamOf(text("a", "b")), { onChunk() {}, onFinish })
    ).resolves.toBe("done");
    expect(onFinish).toHaveBeenCalledExactlyOnceWith({ interrupted: false });
  });

  it("finalizes with the cause when the generation fails", async () => {
    const error = new Error("model failed");
    const seen: ResponseChunk[] = [];

    const outcome = await consumeChunks(streamOf(text("a"), error), {
      onChunk: (chunk) => void seen.push(chunk),
      onFinish: (result) => result
    });

    expect(seen).toEqual(text("a"));
    expect(outcome).toEqual({ interrupted: true, error });
  });

  it("finalizes and stops the producer when the handler throws", async () => {
    const cancel = vi.fn();
    const chunks = new ReadableStream<ResponseChunk>({
      pull: (controller) =>
        controller.enqueue({ type: "metadata", metadata: {} }),
      cancel
    });
    const error = new Error("provider rejected the append");

    const outcome = await consumeChunks(chunks, {
      onChunk() {
        throw error;
      },
      onFinish: (result) => result
    });

    expect(outcome).toEqual({ interrupted: true, error });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("finalizes before awaiting sibling-dependent producer cleanup", async () => {
    const source = new ReadableStream<ResponseChunk>({
      start(controller) {
        controller.enqueue({ type: "metadata", metadata: {} });
      }
    });
    const [failedBranch, openSibling] = source.tee();
    let markFinalized: (() => void) | undefined;
    const finalized = new Promise<void>((resolve) => {
      markFinalized = resolve;
    });
    const consumption = consumeChunks(failedBranch, {
      onChunk() {
        throw new Error("provider rejected the append");
      },
      onFinish() {
        markFinalized?.();
        return "finished";
      }
    });

    const finalizedFirst = await Promise.race([
      finalized.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0))
    ]);
    const settledBeforeSibling = await Promise.race([
      consumption,
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 0)
      )
    ]);

    expect(finalizedFirst).toBe(true);
    expect(settledBeforeSibling).toBe("blocked");

    await openSibling.cancel();
    await expect(consumption).resolves.toBe("finished");
  });
});

describe("createPacer", () => {
  it("allows the first flush immediately", () => {
    expect(createPacer(1000)()).toBe(true);
  });

  it("withholds a flush until the interval has passed", () => {
    vi.useFakeTimers();
    const shouldFlush = createPacer(1000);

    expect([shouldFlush(), shouldFlush(), shouldFlush()]).toEqual([
      true,
      false,
      false
    ]);

    vi.setSystemTime(Date.now() + 1000);
    expect(shouldFlush()).toBe(true);
  });

  it("never withholds when the interval is zero", () => {
    vi.useFakeTimers();
    const shouldFlush = createPacer(0);

    expect([shouldFlush(), shouldFlush()]).toEqual([true, true]);
  });
});

describe("ChannelGateway.stream", () => {
  it("hands a streaming Channel the normalized stream", async () => {
    const seen: ResponseChunk[] = [];
    const stream = vi.fn(
      async (
        _surface,
        chunks: ReadableStream<ResponseChunk>
      ): Promise<DeliveryResult> => {
        seen.push(...(await drain(chunks)));
        return { status: "delivered", reference: "message-1" };
      }
    );

    await expect(
      host({ test: { stream } }).stream(
        surface,
        streamOf(text("Hello ", "world")),
        { title: "Update" }
      )
    ).resolves.toEqual({ status: "delivered", reference: "message-1" });
    expect(seen).toEqual(text("Hello ", "world"));
    expect(stream.mock.calls[0]?.[2]).toEqual({ title: "Update" });
  });

  it("accepts a ResponseChunk stream without adaptation", async () => {
    const received: ResponseChunk[] = [];
    const channelHost = host({
      test: {
        async stream(_surface, chunks) {
          received.push(...(await drain(chunks)));
          return { status: "delivered" };
        }
      }
    });

    await channelHost.stream(surface, streamOf(text("Hello ", "world")));

    expect(received).toEqual(text("Hello ", "world"));
  });

  it("collects the answer for a Channel that cannot stream", async () => {
    const deliver = vi.fn(async () => ({ status: "delivered" as const }));

    await expect(
      host({ test: { deliver } }).stream(surface, streamOf(text("a", "b")), {
        title: "Update",
        delivery: { deliveryId: "notice-1" }
      })
    ).resolves.toEqual({ status: "delivered" });
    expect(deliver).toHaveBeenCalledWith(
      surface,
      { title: "Update", markdown: "ab" },
      { delivery: { deliveryId: "notice-1" } }
    );
  });

  it("delivers a partial answer as uncertain when the generation fails", async () => {
    const deliver = vi.fn(async () => ({
      status: "delivered" as const,
      reference: "message-1"
    }));

    await expect(
      host({ test: { deliver } }).stream(
        surface,
        streamOf(text("Half an "), new Error("model failed"))
      )
    ).resolves.toEqual({
      status: "uncertain",
      reference: "message-1",
      error: {
        code: "CHANNEL_STREAM_INTERRUPTED",
        message:
          "An incomplete answer was delivered because the stream ended early"
      }
    });
    expect(deliver).toHaveBeenCalledWith(
      surface,
      { markdown: "Half an " },
      undefined
    );
  });

  it("does not call a Channel when a failed generation produced nothing", async () => {
    const deliver = vi.fn(async () => ({ status: "delivered" as const }));

    await expect(
      host({ test: { deliver } }).stream(
        surface,
        streamOf<ResponseChunk>([], new Error("model failed"))
      )
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "CHANNEL_STREAM_INTERRUPTED" }
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("releases the stream when the Channel cannot deliver at all", async () => {
    const chunks = streamOf(text("a"));

    await expect(
      host({ test: {} }).stream(surface, chunks)
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "CHANNEL_DELIVERY_UNSUPPORTED" }
    });
    expect(chunks.locked).toBe(false);
    await expect(drain(chunks)).resolves.toEqual([]);
  });
});
