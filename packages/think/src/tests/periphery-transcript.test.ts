import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { action, isAction } from "../actions";
import { withoutFinalAnswerParts } from "../inference/structured-output";
import {
  ThinkTranscriptCache,
  cachedMessageBytes,
  type TranscriptCacheHost
} from "../transcript-cache";
import { incomingMessageWrite } from "../turn-metadata";

const text = (id: string, role: UIMessage["role"] = "user", value = id) =>
  ({ id, role, parts: [{ type: "text", text: value }] }) as UIMessage;

function cache(overrides: Partial<TranscriptCacheHost> = {}) {
  const windowed = vi.fn();
  const refreshed = vi.fn();
  const transcript = new ThinkTranscriptCache({
    budget: () => 1000,
    readAll: async () => [text("all")],
    readRecent: async () => ({
      messages: [text("recent")],
      truncated: false,
      totalContentBytes: 100
    }),
    emitWindowed: windowed,
    refreshed,
    ...overrides
  });
  return { transcript, windowed, refreshed };
}

describe("ThinkTranscriptCache", () => {
  it("reads everything when no budget applies", async () => {
    const { transcript, refreshed } = cache({ budget: () => Infinity });
    expect((await transcript.sync()).map((m) => m.id)).toEqual(["all"]);
    expect(transcript.coversActivePath).toBe(true);
    expect(transcript.lastHydration).toBeNull();
    expect(refreshed).toHaveBeenCalledOnce();
  });

  it("hydrates a window and reports it once per change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transcript, windowed } = cache({
      readRecent: async () => ({
        messages: [text("recent")],
        truncated: true,
        totalContentBytes: 5000
      })
    });
    await transcript.sync();
    await transcript.sync();
    expect(transcript.coversActivePath).toBe(false);
    expect(transcript.lastHydration).toEqual({
      truncated: true,
      totalContentBytes: 5000,
      hydratedMessages: 1
    });
    expect(windowed).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("stops covering the path once growth passes the budget", async () => {
    const { transcript } = cache();
    await transcript.sync();
    expect(transcript.coversActivePath).toBe(true);
    transcript.noteGrowth(800);
    expect(transcript.coversActivePath).toBe(true);
    transcript.noteGrowth(200);
    expect(transcript.coversActivePath).toBe(false);
    await transcript.sync();
    expect(transcript.coversActivePath).toBe(true);
  });

  it("leaves the cache unreliable when a refresh throws", async () => {
    const { transcript } = cache();
    await transcript.sync();
    const failing = cache({
      readRecent: async () => {
        throw new Error("SQLITE_NOMEM");
      }
    }).transcript;
    failing.coversActivePath = true;
    await expect(failing.sync()).rejects.toThrow("SQLITE_NOMEM");
    expect(failing.coversActivePath).toBe(false);
  });

  it("measures messages in UTF-8 bytes", () => {
    const ascii = cachedMessageBytes(text("a", "user", "aa"));
    const multibyte = cachedMessageBytes(text("a", "user", "ää"));
    expect(multibyte - ascii).toBe(2);
  });
});

describe("incomingMessageWrite", () => {
  it("skips a message the server already holds", () => {
    const stored = { ...text("1"), metadata: { channel: "web" } } as UIMessage;
    expect(incomingMessageWrite(text("1"), text("1"), stored, "web")).toBe(
      null
    );
  });

  it("keeps the stored reserved metadata over the client's", () => {
    const stored = { ...text("1"), metadata: { channel: "web" } } as UIMessage;
    const forged = {
      ...text("1", "user", "edited"),
      metadata: { channel: "admin", note: 1 }
    } as UIMessage;
    expect(incomingMessageWrite(forged, forged, stored, undefined)).toEqual({
      message: {
        ...text("1", "user", "edited"),
        metadata: { note: 1, channel: "web" }
      },
      source: "server"
    });
  });

  it("stamps a new user message with the channel", () => {
    const write = incomingMessageWrite(text("n"), text("n"), undefined, "tg");
    expect(write?.source).toBe("server");
    expect(write?.message.metadata).toEqual({ channel: "tg" });
  });

  it("writes a new message without reserved metadata as the client sent it", () => {
    const original = text("n", "assistant");
    expect(incomingMessageWrite(original, original, undefined, "tg")).toEqual({
      message: original,
      source: "client"
    });
  });
});

describe("withoutFinalAnswerParts", () => {
  it("drops the final-answer tool parts only", () => {
    const message = {
      id: "a",
      role: "assistant",
      parts: [
        { type: "text", text: "x" },
        { type: "tool-think_final_answer", toolCallId: "1" },
        { type: "dynamic-tool", toolName: "think_final_answer_2" },
        { type: "tool-search", toolCallId: "2" }
      ]
    } as unknown as UIMessage;
    expect(withoutFinalAnswerParts(message).parts.map((p) => p.type)).toEqual([
      "text",
      "tool-search"
    ]);
    const plain = text("p", "assistant");
    expect(withoutFinalAnswerParts(plain)).toBe(plain);
  });
});

describe("action()", () => {
  it("brands and freezes the descriptor", () => {
    const descriptor = action({
      description: "d",
      inputSchema: {} as never,
      execute: () => 1
    });
    expect(isAction(descriptor)).toBe(true);
    expect(isAction({ config: {} })).toBe(false);
    expect(Object.isFrozen(descriptor.config)).toBe(true);
  });

  it("rejects a durable pause that never parks", () => {
    expect(() =>
      action({
        description: "d",
        inputSchema: {} as never,
        kind: "durable-pause",
        approval: false,
        execute: () => 1
      })
    ).toThrow(/never parks/);
  });
});
