import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  evictLargeMediaFromMessage,
  resolveMediaEvictionConfig,
  type EvictMessageOptions
} from "../media-eviction";

/**
 * Pure-function coverage for the media-eviction rewrite logic (#1710).
 * The integration behavior (row selection, workspace writes, scheduling)
 * is covered in hydration-budget.test.ts; these tests pin the message
 * rewrite semantics — what is evicted, what is preserved, and that inputs
 * are never mutated.
 */

const THRESHOLD = 1_000;

function options(
  overrides?: Partial<EvictMessageOptions>
): EvictMessageOptions {
  return {
    minPartBytes: THRESHOLD,
    externalize: true,
    pathFor: (index, extension) => `/evicted/blob-${index}.${extension}`,
    ...overrides
  };
}

function bigDataUrl(chars = THRESHOLD): string {
  return `data:image/png;base64,${"A".repeat(chars)}`;
}

describe("resolveMediaEvictionConfig", () => {
  it("false disables, true and {} resolve defaults", () => {
    expect(resolveMediaEvictionConfig(false)).toBeNull();
    const fromTrue = resolveMediaEvictionConfig(true);
    expect(fromTrue).toEqual({
      keepRecentMessages: 8,
      minPartBytes: 32 * 1024,
      externalizeToWorkspace: true,
      maxRowsPerPass: 64
    });
    expect(resolveMediaEvictionConfig({})).toEqual(fromTrue);
  });

  it("partial config merges over defaults", () => {
    expect(
      resolveMediaEvictionConfig({ minPartBytes: 1, maxRowsPerPass: 2 })
    ).toEqual({
      keepRecentMessages: 8,
      minPartBytes: 1,
      externalizeToWorkspace: true,
      maxRowsPerPass: 2
    });
  });
});

describe("evictLargeMediaFromMessage — file parts", () => {
  it("replaces a large data-URL file part with a marker and records the blob", () => {
    const url = bigDataUrl();
    const message = {
      id: "m",
      role: "user",
      parts: [
        { type: "text", text: "see attached" },
        { type: "file", mediaType: "image/png", url }
      ]
    } as UIMessage;

    const result = evictLargeMediaFromMessage(message, options());
    expect(result.changed).toBe(true);
    expect(result.parts).toBe(1);
    expect(result.bytes).toBe(url.length);
    expect(result.blobs).toEqual([
      { path: "/evicted/blob-0.png", data: url, mediaType: "image/png" }
    ]);

    const marker = result.message.parts[1] as { type: string; text: string };
    expect(marker.type).toBe("text");
    expect(marker.text).toContain("image/png");
    expect(marker.text).toContain(`${url.length} bytes`);
    expect(marker.text).toContain("/evicted/blob-0.png");
    // Sibling small parts survive untouched.
    expect(result.message.parts[0]).toEqual({
      type: "text",
      text: "see attached"
    });
  });

  it("leaves small data URLs, non-data URLs, and text parts alone", () => {
    const message = {
      id: "m",
      role: "user",
      parts: [
        { type: "file", mediaType: "image/png", url: "data:image/png;,tiny" },
        {
          type: "file",
          mediaType: "image/png",
          url: `https://example.com/${"x".repeat(THRESHOLD * 2)}`
        },
        // Plain text is user-visible prose — never evicted, however large.
        { type: "text", text: "T".repeat(THRESHOLD * 2) }
      ]
    } as UIMessage;

    const result = evictLargeMediaFromMessage(message, options());
    expect(result.changed).toBe(false);
    expect(result.parts).toBe(0);
    expect(result.blobs).toEqual([]);
    // Unchanged input is returned as-is (same reference, no copy).
    expect(result.message).toBe(message);
  });

  it("does not mutate the input message", () => {
    const url = bigDataUrl();
    const message = {
      id: "m",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", url }]
    } as UIMessage;
    const snapshot = JSON.parse(JSON.stringify(message));

    const result = evictLargeMediaFromMessage(message, options());
    expect(result.changed).toBe(true);
    expect(message).toEqual(snapshot);
    expect(result.message).not.toBe(message);
  });
});

describe("evictLargeMediaFromMessage — tool outputs", () => {
  it("replaces large strings nested in objects and arrays, preserving shape", () => {
    const big1 = "B".repeat(THRESHOLD);
    const big2 = bigDataUrl(THRESHOLD * 2);
    const message = {
      id: "m",
      role: "assistant",
      parts: [
        {
          type: "tool-screenshot",
          toolCallId: "c1",
          state: "output-available",
          input: { page: 1 },
          output: {
            note: "small",
            data: big1,
            frames: [{ image: big2 }, { image: "small" }]
          }
        }
      ]
    } as unknown as UIMessage;

    const result = evictLargeMediaFromMessage(message, options());
    expect(result.changed).toBe(true);
    expect(result.parts).toBe(2);
    expect(result.bytes).toBe(big1.length + big2.length);
    // Sequential per-message blob indexes; data URLs carry their media type
    // into the file extension, plain strings fall back to .txt.
    expect(result.blobs.map((b) => b.path)).toEqual([
      "/evicted/blob-0.txt",
      "/evicted/blob-1.png"
    ]);

    const part = result.message.parts[0] as unknown as {
      type: string;
      state: string;
      input: unknown;
      output: {
        note: string;
        data: string;
        frames: Array<{ image: string }>;
      };
    };
    // Container shape intact so toModelOutput handlers can still replay it.
    expect(part.type).toBe("tool-screenshot");
    expect(part.state).toBe("output-available");
    expect(part.input).toEqual({ page: 1 });
    expect(part.output.note).toBe("small");
    expect(part.output.data).toContain("[evicted");
    expect(part.output.frames[0].image).toContain("[evicted image/png");
    expect(part.output.frames[1].image).toBe("small");
  });

  it("handles dynamic-tool parts", () => {
    const big = "C".repeat(THRESHOLD);
    const message = {
      id: "m",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "browser",
          toolCallId: "c1",
          state: "output-available",
          input: {},
          output: { blob: big }
        }
      ]
    } as unknown as UIMessage;

    const result = evictLargeMediaFromMessage(message, options());
    expect(result.changed).toBe(true);
    expect(result.parts).toBe(1);
    expect(
      (result.message.parts[0] as unknown as { output: { blob: string } })
        .output.blob
    ).toContain("[evicted");
  });

  it("stops descending at the depth limit instead of recursing forever", () => {
    // A large string buried deeper than MAX_WALK_DEPTH (8) is left alone —
    // pathological nesting must not blow the stack or the pass budget.
    let deep: Record<string, unknown> = { blob: "D".repeat(THRESHOLD) };
    for (let i = 0; i < 10; i++) deep = { nested: deep };
    const message = {
      id: "m",
      role: "assistant",
      parts: [
        {
          type: "tool-deep",
          toolCallId: "c1",
          state: "output-available",
          input: {},
          output: deep
        }
      ]
    } as unknown as UIMessage;

    const result = evictLargeMediaFromMessage(message, options());
    expect(result.changed).toBe(false);
    expect(result.message).toBe(message);
  });

  it("externalize: false drops the bytes with a size-only marker", () => {
    const big = "E".repeat(THRESHOLD);
    const message = {
      id: "m",
      role: "assistant",
      parts: [
        {
          type: "tool-dump",
          toolCallId: "c1",
          state: "output-available",
          input: {},
          output: { blob: big }
        }
      ]
    } as unknown as UIMessage;

    const result = evictLargeMediaFromMessage(
      message,
      options({ externalize: false })
    );
    expect(result.changed).toBe(true);
    expect(result.blobs).toEqual([]);
    const marker = (
      result.message.parts[0] as unknown as { output: { blob: string } }
    ).output.blob;
    expect(marker).toContain(`[evicted ${big.length} bytes]`);
    expect(marker).not.toContain("preserved at");
  });
});
