import { createTelegramAdapter } from "@chat-adapter/telegram";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatSdkChannel } from "../chat-sdk";
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
  const queue: ResponseChunk[] = [
    { type: "text-start", id: "a" },
    ...texts.map((delta): ResponseChunk => ({
      type: "text-delta",
      id: "a",
      delta
    })),
    { type: "text-end", id: "a" }
  ];
  return new ReadableStream({
    pull(controller) {
      const next = queue.shift();
      if (next) controller.enqueue(next);
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
});
