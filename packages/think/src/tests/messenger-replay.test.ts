import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";

/**
 * Recorded-webhook replay: Telegram updates as the Bot API posts them,
 * through Think's real Telegram messenger, with the Bot API faked by the
 * test config's outbound service. The outbound calls are the contract: the
 * same list on the base and on this change.
 */

type BotCall = { method: string; body: Record<string, unknown> };

const dm = (text: string) => ({
  update_id: 1,
  message: {
    message_id: 11,
    date: 1767225600,
    chat: { id: 42, type: "private", first_name: "Ada" },
    from: { id: 7, is_bot: false, first_name: "Ada", username: "ada" },
    text
  }
});

async function replay(name: string, update: unknown): Promise<BotCall[]> {
  const agent = () => getAgentByName(env.ThinkMessengerDeliveryTestAgent, name);
  await (
    await agent()
  )
    .fetch("https://example.com/messengers/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update)
    })
    .catch(() => undefined);
  const deadline = Date.now() + 20_000;
  let open = 1;
  while (Date.now() < deadline) {
    // The adapter answers after the webhook returns: wait for the model
    // to be asked, then for the reply to settle.
    const stub = await agent();
    const asked = (await stub.getRecorded("prompt")).length > 0;
    open = await stub.openReplyRunsForTest();
    if (asked && open === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(open).toBe(0);
  const calls = (await (
    await fetch(`https://fake-telegram.test/__calls?bot=${name}`)
  ).json()) as BotCall[];
  // What reaches a chat: posts and edits, not typing or drafts (previews
  // whose number follows the adapter's pacing).
  return calls
    .filter(
      ({ method }) =>
        method !== "getMe" &&
        method !== "sendChatAction" &&
        !method.endsWith("Draft")
    )
    .map(({ method, body }) => ({
      method,
      body: {
        chat_id: body.chat_id,
        text:
          (body.rich_message as { markdown?: string } | undefined)?.markdown ??
          body.text
      }
    }));
}

describe("Telegram messenger replies (recorded webhooks)", () => {
  it("answers a direct message with one post after its drafts", async () => {
    expect(await replay(`tg-dm-${crypto.randomUUID()}`, dm("hello"))).toEqual([
      { method: "sendRichMessage", body: { chat_id: "42", text: "Got it" } }
    ]);
  }, 30_000);

  it("answers a direct message once after a reset mid-reply", async () => {
    expect(
      await replay(`tg-reset-${crypto.randomUUID()}`, dm("hello"))
    ).toEqual([
      { method: "sendRichMessage", body: { chat_id: "42", text: "Got it" } }
    ]);
  }, 30_000);
});
