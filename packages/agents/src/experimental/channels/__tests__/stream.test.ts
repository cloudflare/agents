import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeChunks, createPacer } from "../stream";

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

afterEach(() => {
  vi.useRealTimers();
});

describe("consumeChunks", () => {
  it("finalizes once when the stream closes normally", async () => {
    const onFinish = vi.fn(() => "done");

    await expect(
      consumeChunks(streamOf(["a", "b"]), { onChunk() {}, onFinish })
    ).resolves.toBe("done");
    expect(onFinish).toHaveBeenCalledExactlyOnceWith({ interrupted: false });
  });

  it("finalizes with the cause when the generation fails", async () => {
    const error = new Error("model failed");
    const seen: string[] = [];

    const outcome = await consumeChunks(streamOf(["a"], error), {
      onChunk: (chunk) => void seen.push(chunk),
      onFinish: (result) => result
    });

    expect(seen).toEqual(["a"]);
    expect(outcome).toEqual({ interrupted: true, error });
  });

  it("finalizes and stops the producer when the handler throws", async () => {
    const cancel = vi.fn();
    const chunks = new ReadableStream<string>({
      pull: (controller) => controller.enqueue("a"),
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
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("a");
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
