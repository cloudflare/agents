import type { Adapter, ChatInstance, Message } from "chat";
import { describe, expect, it, vi } from "vitest";
import { chatSdkChannel } from "../chat-sdk";
import type { ResponseChunk } from "../protocol";

const SURFACE = {
  channelKey: "telegram",
  version: 1,
  address: { threadId: "telegram:42" },
  label: "telegram · telegram:42"
} as const;

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    threadId: "telegram:42",
    text: "hello",
    author: {
      userId: "7",
      userName: "alice",
      fullName: "Alice",
      isBot: false,
      isMe: false
    },
    attachments: [],
    metadata: { dateSent: new Date("2026-01-01T00:00:00Z"), edited: false },
    ...overrides
  } as unknown as Message;
}

/** An adapter whose webhook reports `reports` to the chat instance. */
function fakeAdapter(
  reports: Array<Message | (() => Promise<Message>)> = [],
  extra: Partial<Adapter> = {}
) {
  let chat: ChatInstance | undefined;
  const adapter = {
    name: "telegram",
    initialize: vi.fn(async (instance: ChatInstance) => {
      chat = instance;
    }),
    handleWebhook: vi.fn(async () => {
      for (const report of reports) {
        void chat!.processMessage(adapter, "telegram:42", report);
      }
      return new Response("ok");
    }),
    isDM: () => true,
    postMessage: vi.fn(async (threadId: string) => ({
      id: "sent-1",
      threadId,
      raw: {}
    })),
    ...extra
  } as unknown as Adapter & {
    postMessage: ReturnType<typeof vi.fn>;
    handleWebhook: ReturnType<typeof vi.fn>;
    initialize: ReturnType<typeof vi.fn>;
  };
  return adapter;
}

function channelFor(adapter: Adapter) {
  return chatSdkChannel({
    adapter,
    name: "telegram",
    path: "/webhooks/telegram",
    participant: (event) => event.actor?.id ?? null
  });
}

const request = (path = "/webhooks/telegram") =>
  new Request(`https://example.com${path}`, { method: "POST", body: "{}" });

function chunksOf(...parts: Array<ResponseChunk | Error>) {
  const queue = [...parts];
  // Pulled one at a time, so an error comes after the chunks before it.
  return new ReadableStream<ResponseChunk>({
    pull(controller) {
      const part = queue.shift();
      if (part === undefined) controller.close();
      else if (part instanceof Error) controller.error(part);
      else controller.enqueue(part);
    }
  });
}

describe("Chat SDK Channel", () => {
  it("leaves a request for another path to other Channels", async () => {
    const adapter = fakeAdapter();
    expect(await channelFor(adapter).ingress!.receive(request("/other"))).toBe(
      null
    );
    expect(adapter.handleWebhook).not.toHaveBeenCalled();
  });

  it("turns the messages the adapter reports for a webhook into its events", async () => {
    const adapter = fakeAdapter([
      message("m1"),
      async () => message("m2", { text: "later" }),
      message("m3", {
        author: {
          userId: "bot",
          userName: "bot",
          fullName: "Bot",
          isBot: true,
          isMe: true
        }
      } as Partial<Message>)
    ]);
    const result = await channelFor(adapter).ingress!.receive(request());

    expect(await result!.response.text()).toBe("ok");
    expect(result!.events.map((e) => e.event)).toEqual([
      {
        type: "message",
        eventId: "telegram:m1",
        thread: { id: "telegram:42", isDirectMessage: true },
        replySurface: {
          version: 1,
          address: { threadId: "telegram:42" },
          label: "telegram · telegram:42",
          key: "telegram:42"
        },
        actor: {
          id: "telegram:7",
          identity: { scope: "telegram", subject: "7" },
          username: "alice",
          fullName: "Alice",
          isBot: false
        },
        message: {
          id: "m1",
          text: "hello",
          attachments: [],
          metadata: { sentAt: "2026-01-01T00:00:00.000Z", edited: false }
        }
      },
      expect.objectContaining({
        eventId: "telegram:m2",
        message: expect.objectContaining({ text: "later" })
      })
    ]);
    expect(adapter.initialize).toHaveBeenCalledTimes(1);
  });

  it("posts a finished message as Markdown and says what it sent", async () => {
    const adapter = fakeAdapter();
    await expect(
      channelFor(adapter).deliver!(SURFACE, { markdown: "**hi**" })
    ).resolves.toEqual({ status: "delivered", reference: "sent-1" });
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:42", {
      markdown: "**hi**"
    });
  });

  it("retries a failed post unless the platform refused it", async () => {
    const down = fakeAdapter([], {
      postMessage: vi.fn(async () => {
        throw new Error("socket hang up");
      })
    });
    await expect(
      channelFor(down).deliver!(SURFACE, { markdown: "hi" })
    ).resolves.toMatchObject({ status: "failed", retryable: true });

    const refused = fakeAdapter([], {
      postMessage: vi.fn(async () => {
        throw Object.assign(new Error("Forbidden"), { status: 403 });
      })
    });
    await expect(
      channelFor(refused).deliver!(SURFACE, { markdown: "hi" })
    ).resolves.toMatchObject({ status: "failed", retryable: false });
  });

  it("streams text deltas through the adapter's stream", async () => {
    const seen: string[] = [];
    const adapter = fakeAdapter([], {
      stream: vi.fn(async (threadId: string, text: AsyncIterable<unknown>) => {
        for await (const part of text) seen.push(String(part));
        return { id: "streamed", threadId, raw: {} };
      })
    });
    await expect(
      channelFor(adapter).stream!(
        SURFACE,
        chunksOf(
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", delta: "Hel" },
          { type: "text-delta", id: "a", delta: "lo" },
          { type: "text-end", id: "a" }
        ),
        {}
      )
    ).resolves.toEqual({ status: "delivered", reference: "streamed" });
    expect(seen).toEqual(["Hel", "lo"]);
  });

  it("is uncertain about a stream that broke after text went out", async () => {
    const adapter = fakeAdapter([], {
      stream: vi.fn(async (_threadId: string, text: AsyncIterable<unknown>) => {
        for await (const _part of text) {
          // consume until the response breaks
        }
        return null;
      })
    });
    await expect(
      channelFor(adapter).stream!(
        SURFACE,
        chunksOf(
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", delta: "Hel" },
          new Error("interrupted")
        ),
        {}
      )
    ).resolves.toMatchObject({ status: "uncertain" });
  });

  it("posts for an adapter that cannot stream", async () => {
    const adapter = fakeAdapter();
    await expect(
      channelFor(adapter).stream!(
        SURFACE,
        chunksOf(
          { type: "text-start", id: "a" },
          { type: "text-delta", id: "a", delta: "Hello" },
          { type: "text-end", id: "a" }
        ),
        {}
      )
    ).resolves.toEqual({ status: "delivered", reference: "sent-1" });
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:42", {
      markdown: "Hello"
    });
  });

  it("shows posted and edited text without trailing whitespace", async () => {
    const editMessage = vi.fn(async () => ({ id: "sent-1", raw: {} }));
    const adapter = fakeAdapter([], { editMessage } as Partial<Adapter>);
    await channelFor(adapter).stream!(
      SURFACE,
      chunksOf(
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: "Got " },
        { type: "text-delta", id: "a", delta: "it " },
        { type: "text-end", id: "a" }
      ),
      {}
    );
    expect(adapter.postMessage).toHaveBeenCalledWith("telegram:42", {
      markdown: "Got"
    });
    expect(editMessage.mock.calls).toEqual([
      ["telegram:42", "sent-1", { markdown: "Got it" }]
    ]);
  });
});
