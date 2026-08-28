import { describe, expect, it, vi } from "vitest";
import type { ChannelChunk } from "..";
import { slack } from "../adapters/slack";

const BOT_TOKEN = "xoxb-secret-token";
const CHANNEL_SURFACE = {
  channelKey: "slack",
  version: 1,
  address: {
    channelId: "CDEST",
    threadTs: "1711000000.000100",
    recipientUserId: "UHUMAN",
    recipientTeamId: "TWORK"
  },
  label: "Slack · CDEST"
} as const;

type Call = { method: string; body: Record<string, unknown> };

/** Record every Slack call, answering each stream method with ok. */
function recorder(overrides: Record<string, () => Response> = {}): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const method = String(input).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body)) });
    return (
      overrides[method]?.() ??
      Response.json({ ok: true, channel: "CDEST", ts: "1711000000.9" })
    );
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

describe("Slack streaming", () => {
  it("collects a top-level channel stream and posts it once", async () => {
    const { fetch, calls } = recorder();
    const channel = slack({ botToken: BOT_TOKEN, fetch });

    await expect(
      channel.stream!(
        {
          ...CHANNEL_SURFACE,
          address: { channelId: "CDEST" }
        },
        chunks("Hello", " world"),
        { title: "Update" }
      )
    ).resolves.toEqual({
      status: "delivered",
      reference: "slack:channel:CDEST:message:1711000000.9"
    });
    expect(calls).toEqual([
      {
        method: "chat.postMessage",
        body: {
          channel: "CDEST",
          text: "Update\n\nHello world",
          mrkdwn: true
        }
      }
    ]);
  });

  it("starts, appends, and stops one streaming message", async () => {
    const { fetch, calls } = recorder();
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });

    await expect(
      channel.stream!(CHANNEL_SURFACE, chunks("Hello ", "world"), {})
    ).resolves.toEqual({
      status: "delivered",
      reference: "slack:channel:CDEST:message:1711000000.9"
    });
    expect(calls.map((call) => call.method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
      "chat.stopStream"
    ]);
    expect(calls[0]?.body).toEqual({
      channel: "CDEST",
      thread_ts: "1711000000.000100",
      recipient_user_id: "UHUMAN",
      recipient_team_id: "TWORK"
    });
    expect(calls[1]?.body).toEqual({
      channel: "CDEST",
      ts: "1711000000.9",
      chunks: [{ type: "markdown_text", text: "Hello " }]
    });
    expect(calls[3]?.body).toEqual({
      channel: "CDEST",
      ts: "1711000000.9"
    });
  });

  it("opens the stream with the title, which is known before the first token", async () => {
    const { fetch, calls } = recorder();
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });

    await channel.stream!(CHANNEL_SURFACE, chunks("Body"), {
      title: "Deploy status"
    });

    // The title must travel as a chunk, not as `markdown_text`. Slack locks a
    // stream into the mode it was opened in and rejects every later append
    // with `streaming_mode_mismatch`, which loses the entire answer.
    expect(calls[0]?.body).toMatchObject({
      chunks: [{ type: "markdown_text", text: "Deploy status\n\n" }]
    });
    expect(calls[0]?.body.markdown_text).toBeUndefined();
    expect(calls.every((call) => call.body.markdown_text === undefined)).toBe(
      true
    );
  });

  it("appends every chunk produced inside one interval together", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = recorder();
    const channel = slack({
      botToken: BOT_TOKEN,
      fetch,
      streamIntervalMs: 1000
    });

    await channel.stream!(CHANNEL_SURFACE, chunks("a", "b", "c"), {});

    expect(
      calls
        .filter((call) => call.method === "chat.appendStream")
        .map((call) => call.body.chunks)
    ).toEqual([[{ type: "markdown_text", text: "a" }]]);
    // Whatever the interval withheld rides on the terminal call rather than
    // costing another round trip, so nothing is dropped.
    expect(calls.at(-1)).toEqual({
      method: "chat.stopStream",
      body: {
        channel: "CDEST",
        ts: "1711000000.9",
        chunks: [
          { type: "markdown_text", text: "b" },
          { type: "markdown_text", text: "c" }
        ]
      }
    });
    vi.useRealTimers();
  });

  it("renders tool progress as task updates and sources beneath the answer", async () => {
    const { fetch, calls } = recorder();
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });
    const parts: ChannelChunk[] = [
      { type: "reasoning", text: "dropped" },
      {
        type: "tool",
        name: "search",
        status: "started",
        title: "Searching",
        detail: "query"
      },
      { type: "tool", name: "search", status: "completed" },
      { type: "source", url: "https://example.com", title: "Example" },
      { type: "text", text: "Answer" }
    ];

    await channel.stream!(CHANNEL_SURFACE, streamOf(parts), {});

    const appended = calls
      .filter((call) => call.method === "chat.appendStream")
      .flatMap((call) => call.body.chunks as unknown[]);
    expect(appended).toEqual([
      {
        type: "task_update",
        id: "search",
        title: "Searching",
        status: "in_progress",
        details: "query"
      },
      {
        type: "task_update",
        id: "search",
        title: "search",
        status: "complete"
      },
      { type: "markdown_text", text: "Answer" }
    ]);
    expect(calls.at(-1)?.body.blocks).toEqual([
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "<https://example.com|Example>"
          }
        ]
      }
    ]);
  });

  it("splits text past Slack's append limit", async () => {
    const { fetch, calls } = recorder();
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });

    await channel.stream!(CHANNEL_SURFACE, chunks("x".repeat(12_001)), {});

    const appended = calls.filter(
      (call) => call.method === "chat.appendStream"
    );
    expect(
      (appended[0]!.body.chunks as { text: string }[]).map(
        (chunk) => chunk.text.length
      )
    ).toEqual([12_000, 1]);
  });

  it("stops the stream and reports uncertain when the generation fails", async () => {
    const { fetch, calls } = recorder();
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });
    const interrupted = streamOf(
      [{ type: "text", text: "Half an " } as const],
      new Error("model failed")
    );

    await expect(
      channel.stream!(CHANNEL_SURFACE, interrupted, {})
    ).resolves.toEqual({
      status: "uncertain",
      reference: "slack:channel:CDEST:message:1711000000.9",
      error: {
        code: "SLACK_STREAM_INTERRUPTED",
        message: "The answer ended early, so the Slack message is incomplete"
      }
    });
    expect(calls.at(-1)?.method).toBe("chat.stopStream");
  });

  it("stops the stream even after an append is rejected", async () => {
    const { fetch, calls } = recorder({
      "chat.appendStream": () => Response.json({ ok: false, error: "no_text" })
    });
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });

    await expect(
      channel.stream!(CHANNEL_SURFACE, chunks("a", "b"), {})
    ).resolves.toEqual({
      status: "uncertain",
      reference: "slack:channel:CDEST:message:1711000000.9",
      error: {
        code: "SLACK_API_ERROR_NO_TEXT",
        message: "Slack rejected the message: no_text"
      }
    });
    expect(calls.map((call) => call.method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream"
    ]);
  });

  it("reports a rejected stop as uncertain, since the message exists", async () => {
    const { fetch } = recorder({
      "chat.stopStream": () =>
        Response.json({ ok: false, error: "internal_error" }, { status: 500 })
    });
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });

    await expect(
      channel.stream!(CHANNEL_SURFACE, chunks("a"), {})
    ).resolves.toMatchObject({
      status: "uncertain",
      reference: "slack:channel:CDEST:message:1711000000.9",
      error: { code: "SLACK_API_ERROR_INTERNAL_ERROR" }
    });
  });

  it("never reads the stream when Slack refuses to start one", async () => {
    const { fetch, calls } = recorder({
      "chat.startStream": () =>
        Response.json({ ok: false, error: "not_in_channel" })
    });
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });
    const source = chunks("a");

    await expect(channel.stream!(CHANNEL_SURFACE, source, {})).resolves.toEqual(
      {
        status: "failed",
        retryable: false,
        error: {
          code: "SLACK_API_ERROR_NOT_IN_CHANNEL",
          message: "Slack rejected the message: not_in_channel"
        }
      }
    );
    expect(calls).toHaveLength(1);
    expect(source.locked).toBe(false);
  });

  it("rejects a malformed surface without calling Slack", async () => {
    const { fetch, calls } = recorder();
    const channel = slack({ botToken: BOT_TOKEN, fetch });

    await expect(
      channel.stream!(
        { channelKey: "slack", version: 1, address: null, label: "bad" },
        chunks("a"),
        {}
      )
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "SLACK_SURFACE_INVALID" }
    });
    expect(calls).toEqual([]);
  });

  it("opens a direct message and streams to the resolved conversation", async () => {
    const { fetch, calls } = recorder({
      "conversations.open": () =>
        Response.json({ ok: true, channel: { id: "DADA" } })
    });
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });

    await channel.stream!(
      {
        channelKey: "slack",
        version: 1,
        address: { teamId: "TWORK", userId: "UADA" },
        label: "Slack · user UADA"
      },
      chunks("Hi"),
      {}
    );

    expect(calls[1]).toEqual({
      method: "chat.startStream",
      body: {
        channel: "DADA",
        recipient_user_id: "UADA",
        recipient_team_id: "TWORK"
      }
    });
  });

  it("falls back to delivery when a top-level surface has an incomplete recipient pair", async () => {
    const { fetch, calls } = recorder();
    const channel = slack({ botToken: BOT_TOKEN, fetch, streamIntervalMs: 0 });

    await channel.stream!(
      {
        channelKey: "slack",
        version: 1,
        address: { channelId: "CDEST", recipientUserId: "UHUMAN" },
        label: "Slack · CDEST"
      },
      chunks("Hi"),
      {}
    );

    expect(calls[0]).toEqual({
      method: "chat.postMessage",
      body: { channel: "CDEST", text: "Hi", mrkdwn: true }
    });
  });

  it("rejects a nonsensical stream interval when the Channel is created", () => {
    expect(() => slack({ botToken: BOT_TOKEN, streamIntervalMs: -1 })).toThrow(
      "streamIntervalMs must be a non-negative integer"
    );
  });
});
