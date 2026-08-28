import { describe, expect, it, vi } from "vitest";
import type { ChannelChunk } from "..";
import { telegram } from "../adapters/telegram";

const BOT_TOKEN = "4242:bot-secret";
const PRIVATE_SURFACE = {
  channelKey: "telegram",
  version: 1,
  address: { chatId: "99" },
  label: "Telegram · 99"
} as const;

type Call = { method: string; body: Record<string, unknown> };

function recorder(overrides: Record<string, () => Response> = {}): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let messageId = 500;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const method = String(input).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    if (overrides[method]) return overrides[method]!();
    if (method !== "sendMessage")
      return Response.json({ ok: true, result: true });
    messageId += 1;
    return Response.json({ ok: true, result: { message_id: messageId } });
  });
  return { fetch, calls };
}

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

function chunks(...parts: string[]): ReadableStream<ChannelChunk> {
  return streamOf(parts.map((text) => ({ type: "text", text }) as const));
}

function of(calls: Call[], method: string): Call[] {
  return calls.filter((call) => call.method === method);
}

describe("Telegram streaming", () => {
  it("previews cumulative drafts, then persists the whole answer", async () => {
    const { fetch, calls } = recorder();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      streamIntervalMs: 0
    });

    await expect(
      channel.stream!(PRIVATE_SURFACE, chunks("Hello ", "world"), {})
    ).resolves.toEqual({ status: "delivered", reference: "501" });

    const drafts = of(calls, "sendMessageDraft");
    expect(drafts.map((call) => call.body.text)).toEqual([
      "Hello ",
      "Hello world"
    ]);
    // One draft id, so Telegram animates between the snapshots.
    expect(new Set(drafts.map((call) => call.body.draft_id)).size).toBe(1);
    expect(drafts[0]?.body.chat_id).toBe(99);
    expect(calls.at(-1)).toEqual({
      method: "sendMessage",
      body: { chat_id: "99", text: "Hello world" }
    });
  });

  it("previews at most once per interval, then persists everything", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = recorder();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      streamIntervalMs: 1000
    });

    await channel.stream!(PRIVATE_SURFACE, chunks("a", "b", "c"), {});

    // No trailing preview: the message that replaces it lands immediately
    // after, so drafting the tail would only flicker.
    expect(of(calls, "sendMessageDraft").map((call) => call.body.text)).toEqual(
      ["a"]
    );
    expect(calls.at(-1)?.body.text).toBe("abc");
    vi.useRealTimers();
  });

  it("prefixes the title on both the preview and the message", async () => {
    const { fetch, calls } = recorder();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      streamIntervalMs: 0
    });

    await channel.stream!(PRIVATE_SURFACE, chunks("Body"), {
      title: "Deploy status"
    });

    expect(of(calls, "sendMessageDraft")[0]?.body.text).toBe(
      "Deploy status\n\nBody"
    );
    expect(calls.at(-1)?.body.text).toBe("Deploy status\n\nBody");
  });

  it("never applies a parse mode to a draft, whose markup is unbalanced", async () => {
    const { fetch, calls } = recorder();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      parseMode: "MarkdownV2",
      streamIntervalMs: 0
    });

    await channel.stream!(PRIVATE_SURFACE, chunks("*bold", "*"), {});

    expect(of(calls, "sendMessageDraft")[0]?.body.parse_mode).toBeUndefined();
    expect(calls.at(-1)?.body.parse_mode).toBe("MarkdownV2");
  });

  it("sends the real message even when the generation failed part-way", async () => {
    const { fetch, calls } = recorder();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      streamIntervalMs: 0
    });
    const interrupted = streamOf(
      [{ type: "text", text: "Half an " } as const],
      new Error("model failed")
    );

    await expect(
      channel.stream!(PRIVATE_SURFACE, interrupted, {})
    ).resolves.toEqual({
      status: "uncertain",
      reference: "501",
      error: {
        code: "TELEGRAM_STREAM_INTERRUPTED",
        message: "An incomplete answer was sent because the stream ended early"
      }
    });
    expect(calls.at(-1)).toEqual({
      method: "sendMessage",
      body: { chat_id: "99", text: "Half an " }
    });
  });

  it("sends the real message even when every draft was rejected", async () => {
    const { fetch, calls } = recorder({
      sendMessageDraft: () =>
        Response.json({ ok: false, error_code: 400, description: "nope" })
    });
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      streamIntervalMs: 0
    });

    await expect(
      channel.stream!(PRIVATE_SURFACE, chunks("a", "b"), {})
    ).resolves.toEqual({ status: "delivered", reference: "501" });
    // Drafting stops after the first refusal rather than retrying per chunk.
    expect(of(calls, "sendMessageDraft")).toHaveLength(1);
    expect(of(calls, "sendMessage")).toHaveLength(1);
  });

  it("skips drafts in a group, where Telegram does not support them", async () => {
    const { fetch, calls } = recorder();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      streamIntervalMs: 0
    });

    await expect(
      channel.stream!(
        {
          channelKey: "telegram",
          version: 1,
          address: { chatId: "-100200" },
          label: "Telegram · group"
        },
        chunks("Hello"),
        {}
      )
    ).resolves.toEqual({ status: "delivered", reference: "501" });
    expect(of(calls, "sendMessageDraft")).toEqual([]);
    expect(calls.at(-1)?.body).toEqual({ chat_id: "-100200", text: "Hello" });
  });

  it("splits an answer that outgrows one Telegram message", async () => {
    const { fetch, calls } = recorder();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      maxLength: 10,
      streamIntervalMs: 0
    });

    await expect(
      channel.stream!(PRIVATE_SURFACE, chunks("0123456789abc"), {})
    ).resolves.toEqual({ status: "delivered", reference: "501" });
    expect(of(calls, "sendMessage").map((call) => call.body.text)).toEqual([
      "0123456789",
      "abc"
    ]);
    // The preview cannot outgrow the limit either.
    expect(of(calls, "sendMessageDraft")[0]?.body.text).toBe("0123456789");
  });

  it("reports a partly accepted split answer as uncertain", async () => {
    let sends = 0;
    const { fetch } = recorder({
      sendMessage: () => {
        sends += 1;
        return sends === 1
          ? Response.json({ ok: true, result: { message_id: 501 } })
          : Response.json({ ok: false, error_code: 400, description: "no" });
      }
    });
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      maxLength: 10,
      streamIntervalMs: 0
    });

    await expect(
      channel.stream!(PRIVATE_SURFACE, chunks("0123456789abc"), {})
    ).resolves.toEqual({
      status: "uncertain",
      reference: "501",
      error: {
        code: "TELEGRAM_STREAM_PARTIAL",
        message: "Telegram accepted only part of a split answer"
      }
    });
  });

  it("refuses a stream that carried no text", async () => {
    const { fetch, calls } = recorder();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      streamIntervalMs: 0
    });

    await expect(
      channel.stream!(
        PRIVATE_SURFACE,
        streamOf([{ type: "reasoning", text: "quiet" } as const]),
        {}
      )
    ).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: {
        code: "TELEGRAM_STREAM_EMPTY",
        message: "The stream carried no text to send"
      }
    });
    expect(calls).toEqual([]);
  });

  it("distinguishes an empty stream from one that died before its first token", async () => {
    const { fetch } = recorder();
    const channel = telegram({
      botToken: BOT_TOKEN,
      fetch,
      streamIntervalMs: 0
    });

    await expect(
      channel.stream!(
        PRIVATE_SURFACE,
        streamOf<ChannelChunk>([], new Error("model failed")),
        {}
      )
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "TELEGRAM_STREAM_INTERRUPTED" }
    });
  });

  it("rejects a malformed surface without calling Telegram", async () => {
    const { fetch, calls } = recorder();
    const channel = telegram({ botToken: BOT_TOKEN, fetch });

    await expect(
      channel.stream!(
        { channelKey: "telegram", version: 1, address: null, label: "bad" },
        chunks("a"),
        {}
      )
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "TELEGRAM_SURFACE_INVALID" }
    });
    expect(calls).toEqual([]);
  });

  it("rejects a nonsensical stream interval when the Channel is created", () => {
    expect(() =>
      telegram({ botToken: BOT_TOKEN, streamIntervalMs: 1.5 })
    ).toThrow("streamIntervalMs must be a non-negative integer");
  });
});
