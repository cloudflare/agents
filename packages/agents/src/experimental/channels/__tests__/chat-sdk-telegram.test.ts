import { createTelegramAdapter } from "@chat-adapter/telegram";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatSdkChannel } from "../chat-sdk";
import { INTERRUPTED_NOTICE, onPosting } from "../deliveries";
import type { ResponseChunk } from "../protocol";
import updates from "./fixtures/telegram-updates.json";

/**
 * Recorded-webhook replay: Telegram updates as the Bot API posts them,
 * through the real Telegram adapter, with the Bot API faked. Every call the
 * adapter makes is recorded; the expected calls are written down here.
 */

const TOKEN = "123:secret";
const SECRET = "webhook-secret";
const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
let nextMessageId = 500;
/** Resolved by the next call the adapter makes to the Bot API. */
let onCall: ((method: string) => void) | undefined;
/** Bot API methods answered once with a rate limit before they succeed. */
const rateLimitOnce = new Set<string>();

const server = setupServer(
  http.post(
    `https://api.telegram.org/bot${TOKEN}/:method`,
    async ({ params, request }) => {
      const method = String(params.method);
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      calls.push({ method, body });
      onCall?.(method);
      if (rateLimitOnce.delete(method)) {
        return HttpResponse.json(
          {
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 1",
            parameters: { retry_after: 1 }
          },
          { status: 429 }
        );
      }
      if (method === "getMe") {
        return HttpResponse.json({
          ok: true,
          result: {
            id: 999,
            is_bot: true,
            first_name: "Probe",
            username: "probe_bot"
          }
        });
      }
      if (method === "getWebhookInfo") {
        return HttpResponse.json({ ok: true, result: { url: "https://x" } });
      }
      return HttpResponse.json({
        ok: true,
        result: {
          message_id: nextMessageId++,
          date: 1767225700,
          chat: { id: body.chat_id, type: "private" },
          text: body.text
        }
      });
    }
  )
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  calls.length = 0;
  rateLimitOnce.clear();
  onCall = undefined;
});
afterAll(() => server.close());

function channel() {
  return chatSdkChannel({
    name: "telegram",
    path: "/webhooks/telegram",
    adapter: createTelegramAdapter({
      botToken: TOKEN,
      secretToken: SECRET,
      mode: "webhook",
      userName: "probe_bot"
    }),
    participant: (event) => event.actor?.id ?? null
  });
}

function webhook(update: unknown, secret = SECRET) {
  return new Request("https://example.com/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret
    },
    body: JSON.stringify(update)
  });
}

function chunks(...texts: string[]): ReadableStream<ResponseChunk> {
  return answer(texts, false);
}

/** An answer's chunks; `broken` ends it with an error instead of its end. */
function answer(
  texts: string[],
  broken: boolean
): ReadableStream<ResponseChunk> {
  const queue: ResponseChunk[] = [
    { type: "text-start", id: "a" },
    ...texts.map((delta): ResponseChunk => ({
      type: "text-delta",
      id: "a",
      delta
    })),
    ...(broken ? [] : [{ type: "text-end", id: "a" } as ResponseChunk])
  ];
  return new ReadableStream({
    pull(controller) {
      const next = queue.shift();
      if (next) controller.enqueue(next);
      else if (broken) controller.error(new Error("interrupted"));
      else controller.close();
    }
  });
}

/** The calls that send to a chat, as method, chat and text. */
function sends() {
  return calls
    .filter(({ method }) => method !== "getMe" && method !== "getWebhookInfo")
    .map(({ method, body }) => ({
      method,
      chat: body.chat_id,
      text:
        (body.rich_message as { markdown?: string } | undefined)?.markdown ??
        body.text
    }));
}

describe("Chat SDK Channel over the Telegram adapter (recorded webhooks)", () => {
  it("refuses a webhook without the secret token", async () => {
    const result = await channel().ingress!.receive(
      webhook(updates.directMessage, "wrong")
    );
    expect(result?.response.status).toBe(401);
    expect(result?.events).toEqual([]);
  });

  it("turns a direct message into one event whose surface is its chat", async () => {
    const result = await channel().ingress!.receive(
      webhook(updates.directMessage)
    );
    expect(result?.response.status).toBe(200);
    expect(result?.events.map(({ event }) => event)).toEqual([
      expect.objectContaining({
        type: "message",
        eventId: "telegram:42:11",
        thread: expect.objectContaining({ isDirectMessage: true }),
        replySurface: expect.objectContaining({ key: expect.any(String) }),
        actor: expect.objectContaining({
          id: "telegram:7",
          username: "alice"
        }),
        message: expect.objectContaining({ id: "42:11", text: "hello" })
      })
    ]);
    expect(sends()).toEqual([]);
  });

  it("gives a repeated update the same event id, so Channels takes it once", async () => {
    const c = channel();
    const first = await c.ingress!.receive(webhook(updates.directMessage));
    const again = await c.ingress!.receive(webhook(updates.directMessage));
    expect(again?.events[0]?.event.eventId).toBe(
      first?.events[0]?.event.eventId
    );
  });

  it("takes a group mention, keeps a document's facts, and drops the bot's own message", async () => {
    const c = channel();
    const mention = await c.ingress!.receive(webhook(updates.groupMention));
    expect(mention?.events.map(({ event }) => event.type)).toEqual(["message"]);
    const document = await c.ingress!.receive(webhook(updates.document));
    expect(document?.events[0]?.event).toMatchObject({
      type: "message",
      message: {
        text: "see attached",
        attachments: [
          expect.objectContaining({
            name: "notes.txt",
            mediaType: "text/plain"
          })
        ]
      }
    });
    const own = await c.ingress!.receive(webhook(updates.fromBot));
    expect(own?.events).toEqual([]);
  });

  it("answers the chat a message came from, once, with the whole answer", async () => {
    const c = channel();
    const result = await c.ingress!.receive(webhook(updates.directMessage));
    const surface = {
      ...result!.events[0]!.event.replySurface!,
      channelKey: "telegram"
    };
    const delivered = await c.stream!(surface, chunks("Hel", "lo"), {});
    expect(delivered).toMatchObject({ status: "delivered" });
    // Drafts while it streams (as many as the adapter's pacing makes), then
    // one message with the whole answer, all to the chat it came from.
    const sent = sends();
    expect(sent.at(-1)).toEqual({
      method: "sendRichMessage",
      chat: "42",
      text: "Hello"
    });
    expect(
      sent.filter((call) => call.method === "sendRichMessage")
    ).toHaveLength(1);
    expect(
      sent.every(
        (call) =>
          call.chat === "42" &&
          (call.method === "sendRichMessage" ||
            call.method === "sendRichMessageDraft")
      )
    ).toBe(true);
  });

  it("posts the whole answer to a group, where the adapter will not stream", async () => {
    const c = channel();
    const result = await c.ingress!.receive(webhook(updates.groupMention));
    const surface = {
      ...result!.events[0]!.event.replySurface!,
      channelKey: "telegram"
    };
    const delivered = await c.stream!(surface, chunks("Hel", "lo"), {});
    expect(delivered).toMatchObject({ status: "delivered" });
    expect(sends()).toEqual([
      { method: "sendRichMessage", chat: "-100", text: "Hel" },
      { method: "editMessageText", chat: "-100", text: "Hello" }
    ]);
  });

  it("posts a group reply's first text before the answer ends", async () => {
    const c = channel();
    const result = await c.ingress!.receive(webhook(updates.groupMention));
    const surface = {
      ...result!.events[0]!.event.replySurface!,
      channelKey: "telegram"
    };
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const queue: ResponseChunk[] = [
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Hel" }
    ];
    const open = new ReadableStream<ResponseChunk>({
      async pull(controller) {
        const next = queue.shift();
        if (next) return controller.enqueue(next);
        await finished;
        controller.enqueue({ type: "text-delta", id: "a", delta: "lo" });
        controller.enqueue({ type: "text-end", id: "a" });
        controller.close();
      }
    });
    const firstPost = new Promise<string>((resolve) => {
      onCall = (method) => {
        if (method === "sendRichMessage") resolve(method);
      };
    });
    const delivered = c.stream!(surface, open, {});
    await expect(firstPost).resolves.toBe("sendRichMessage");
    finish();
    await expect(delivered).resolves.toMatchObject({ status: "delivered" });
    onCall = undefined;
    expect(sends().at(-1)).toMatchObject({ text: "Hello" });
  });

  it("posts the notice to a group when the answer broke off before any text", async () => {
    const c = channel();
    const result = await c.ingress!.receive(webhook(updates.groupMention));
    const surface = {
      ...result!.events[0]!.event.replySurface!,
      channelKey: "telegram"
    };
    const delivered = await c.stream!(surface, answer([], true), {});
    expect(delivered).toMatchObject({ status: "delivered" });
    expect(sends()).toEqual([
      {
        method: "sendRichMessage",
        chat: "-100",
        text: INTERRUPTED_NOTICE
      }
    ]);
  });

  it("posts what an interrupted answer had, once, and says it is incomplete", async () => {
    const c = channel();
    const result = await c.ingress!.receive(webhook(updates.directMessage));
    const surface = {
      ...result!.events[0]!.event.replySurface!,
      channelKey: "telegram"
    };
    const delivered = await c.stream!(surface, answer(["Hel"], true), {});
    expect(delivered).toMatchObject({ status: "uncertain" });
    const posts = sends().filter((call) => call.method === "sendRichMessage");
    expect(posts).toEqual([
      { method: "sendRichMessage", chat: "42", text: "Hel" }
    ]);
  });

  it("gives an edited message a new event id, so Channels takes the edit", async () => {
    const c = channel();
    const original = await c.ingress!.receive(webhook(updates.directMessage));
    const edit = await c.ingress!.receive(webhook(updates.edited));
    expect(edit?.events[0]?.event.eventId).toBeDefined();
    expect(edit?.events[0]?.event.eventId).not.toBe(
      original?.events[0]?.event.eventId
    );
  });

  it("retries a private reply whose final post was rate limited after its drafts", async () => {
    const c = channel();
    const result = await c.ingress!.receive(webhook(updates.directMessage));
    const surface = {
      ...result!.events[0]!.event.replySurface!,
      channelKey: "telegram"
    };
    rateLimitOnce.add("sendRichMessage");
    const first = await c.stream!(surface, chunks("Hel", "lo"), {});
    expect(first).toMatchObject({ status: "failed", retryable: true });
    const second = await c.stream!(surface, chunks("Hel", "lo"), {});
    expect(second).toMatchObject({ status: "delivered" });
    // Only drafts went out before the rate limit: one answer in the chat.
    expect(
      calls.filter(({ method }) => method === "sendRichMessage")
    ).toHaveLength(2);
  });

  it("does not take a private reply's drafts as posted", async () => {
    const c = channel();
    const result = await c.ingress!.receive(webhook(updates.directMessage));
    const surface = {
      ...result!.events[0]!.event.replySurface!,
      channelKey: "telegram"
    };
    const options = {};
    const marks: string[] = [];
    onPosting(options, () => marks.push("posting"));
    onCall = (method) => marks.push(method);
    await expect(
      c.stream!(surface, chunks("Hel", "lo"), options)
    ).resolves.toMatchObject({ status: "delivered" });
    // A reset during the drafts finds no mark, so the reply is sent again.
    expect(marks).not.toContain("posting");
    expect(marks.at(-1)).toBe("sendRichMessage");
  });

  it("marks a group reply as posting just before its first post", async () => {
    const c = channel();
    const result = await c.ingress!.receive(webhook(updates.groupMention));
    const surface = {
      ...result!.events[0]!.event.replySurface!,
      channelKey: "telegram"
    };
    const options = {};
    const marks: string[] = [];
    onPosting(options, () => marks.push("posting"));
    onCall = (method) => marks.push(method);
    await c.stream!(surface, chunks("Hel", "lo"), options);
    expect(marks.filter((mark) => mark !== "getMe")).toEqual([
      "posting",
      "sendRichMessage",
      "editMessageText"
    ]);
  });

  it("retries a group reply whose first post was rate limited", async () => {
    const c = channel();
    const result = await c.ingress!.receive(webhook(updates.groupMention));
    const surface = {
      ...result!.events[0]!.event.replySurface!,
      channelKey: "telegram"
    };
    rateLimitOnce.add("sendRichMessage");
    await expect(
      c.stream!(surface, chunks("Hello"), {})
    ).resolves.toMatchObject({ status: "failed", retryable: true });
  });
});
