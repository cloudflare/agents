import { describe, expect, it } from "vitest";
import { sseDataStream } from "../../../models/core/sse";

/** Runs `bytes` through the decoder in chunks of `size` bytes. */
async function decode(bytes: Uint8Array, size: number): Promise<string[]> {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(bytes.subarray(i, i + size));
  }
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  })
    .pipeThrough(sseDataStream())
    .getReader();
  const events: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return events;
    events.push(value);
  }
}

describe("sseDataStream", () => {
  it("gives the same events for every chunking and line ending", async () => {
    for (const separator of ["\n", "\r\n", "\r"]) {
      const text = [
        ": keepalive",
        "event: delta",
        'data: {"a":',
        'data:  "é"}',
        "",
        "data: tail"
      ].join(separator);
      const bytes = new TextEncoder().encode(text);
      for (let size = 1; size <= bytes.length; size++) {
        expect(await decode(bytes, size)).toEqual(['{"a":\n "é"}', "tail"]);
      }
    }
  });

  it("reads a large event in many chunks in linear time", async () => {
    // 8 MB of data in 512-byte chunks: about 20 ms when only new text is
    // scanned, several seconds when the incomplete line is rescanned on every
    // chunk (about 64 billion characters).
    const payload = "x".repeat(8 * 1024 * 1024);
    const bytes = new TextEncoder().encode(`data: ${payload}\n\n`);
    const started = Date.now();
    const events = await decode(bytes, 512);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toHaveLength(payload.length);
  }, 30_000);
});
