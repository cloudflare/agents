import { describe, expect, it } from "vitest";
import type { StreamJson, StreamWriter } from "agents/streams";
import { BufferedEventWriter } from "../events";

describe("BufferedEventWriter", () => {
  it("packs deltas and flushes before terminal settlement", () => {
    const chunks: StreamJson[] = [];
    let closed = false;
    const backing: StreamWriter = {
      streamId: "turn:test",
      get cursor() {
        return chunks.length;
      },
      append(chunk) {
        chunks.push(chunk);
        return chunks.length - 1;
      },
      close() {
        closed = true;
      },
      error() {
        closed = true;
      }
    };
    const writer = new BufferedEventWriter(backing);

    writer.append({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "assistant:test:0",
      delta: "a"
    });
    writer.append({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "assistant:test:0",
      delta: "b"
    });
    expect(chunks).toEqual([]);

    writer.close();
    expect(chunks).toEqual([
      [
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "assistant:test:0",
          delta: "a"
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "assistant:test:0",
          delta: "b"
        }
      ]
    ]);
    expect(closed).toBe(true);
  });
});
