import { describe, it, expect } from "vitest";
import { teeAsyncIterable } from "../tee";

async function* tokenStream(tokens: string[]) {
  for (const token of tokens) {
    yield token;
  }
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let result = "";
  for await (const chunk of stream) {
    result += chunk;
  }
  return result;
}

describe("teeAsyncIterable", () => {
  it("splits a stream into two identical readers", async () => {
    const source = tokenStream(["Hello", " ", "world"]);
    const { streams } = teeAsyncIterable(source, 2);

    const [a, b] = await Promise.all([
      collect(streams[0]),
      collect(streams[1])
    ]);
    expect(a).toBe("Hello world");
    expect(b).toBe("Hello world");
  });

  it("splits into three readers", async () => {
    const source = tokenStream(["a", "b", "c"]);
    const { streams } = teeAsyncIterable(source, 3);

    const results = await Promise.all(streams.map(collect));
    expect(results).toEqual(["abc", "abc", "abc"]);
  });

  it("provides collected promise with full text", async () => {
    const source = tokenStream(["one", " ", "two", " ", "three"]);
    const { streams, collected } = teeAsyncIterable(source, 1);

    await collect(streams[0]);
    const full = await collected;
    expect(full).toBe("one two three");
  });

  it("collected resolves even if streams are consumed at different speeds", async () => {
    const source = tokenStream(["fast", " ", "slow"]);
    const { streams, collected } = teeAsyncIterable(source, 2);

    const first = await collect(streams[0]);
    expect(first).toBe("fast slow");

    const second = await collect(streams[1]);
    expect(second).toBe("fast slow");

    expect(await collected).toBe("fast slow");
  });

  it("handles empty stream", async () => {
    const source = tokenStream([]);
    const { streams, collected } = teeAsyncIterable(source, 2);

    const [a, b] = await Promise.all([
      collect(streams[0]),
      collect(streams[1])
    ]);
    expect(a).toBe("");
    expect(b).toBe("");
    expect(await collected).toBe("");
  });

  it("handles single-chunk stream", async () => {
    const source = tokenStream(["only"]);
    const { streams } = teeAsyncIterable(source, 2);

    const [a, b] = await Promise.all([
      collect(streams[0]),
      collect(streams[1])
    ]);
    expect(a).toBe("only");
    expect(b).toBe("only");
  });

  it("works with count=1", async () => {
    const source = tokenStream(["hello"]);
    const { streams, collected } = teeAsyncIterable(source, 1);

    expect(await collect(streams[0])).toBe("hello");
    expect(await collected).toBe("hello");
  });
});
