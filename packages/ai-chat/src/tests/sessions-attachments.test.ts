import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

/**
 * ai-chat keeps its existing message behavior when a payload is chunked out.
 *
 * Sessions is a message store: a payload only leaves the row when the row
 * cannot hold it, so every fixture below carries more than
 * `MAX_INLINE_ROW_BYTES` (1.5 MiB).
 */
const OVER_BUDGET_BYTES = 2 * 1024 * 1024;

describe("AIChatAgent Sessions attachments", () => {
  it("stores a pointer but keeps in-memory and HTTP messages reconstructed", async () => {
    const room = `sessions-attachment-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.TestChatAgent, room);

    const url = `data:image/png;base64,${btoa("p".repeat(OVER_BUDGET_BYTES))}`;
    const message: UIMessage = {
      id: "image-message",
      role: "user",
      parts: [{ type: "file", mediaType: "image/png", url }]
    };
    await stub.persistMessages([message]);

    const stored = (await stub.getPersistedMessages()) as UIMessage[];
    expect((stored[0].parts[0] as { url: string }).url).toMatch(
      /^attachment:sha256:[0-9a-f]{64}$/
    );
    expect(
      ((await stub.getMessagesForTest()) as UIMessage[])[0].parts[0]
    ).toMatchObject({ type: "file", url });
    expect(await stub.getAttachmentFileCountForTest()).toBe(1);

    const response = await exports.default.fetch(
      `http://example.com/agents/test-chat-agent/${room}/get-messages`
    );
    const fetched = (await response.json()) as UIMessage[];
    expect(fetched[0].parts[0]).toMatchObject({ type: "file", url });

    await stub.clearSessionForTest();
    expect(await stub.getAttachmentFileCountForTest()).toBe(0);
  });

  it("rehydrates reconstructed messages after a Durable Object eviction", async () => {
    const room = `sessions-attachment-wake-${crypto.randomUUID()}`;
    // This agent declares `sessionAttachments` as a class field, so the policy
    // survives eviction the way a real subclass's policy does.
    const stub = await getAgentByName(env.AttachmentChatAgent, room);

    const url = `data:image/png;base64,${btoa("o".repeat(OVER_BUDGET_BYTES))}`;
    await stub.persistMessages([
      {
        id: "wake-user",
        role: "user",
        parts: [
          { type: "text", text: "look at this" },
          { type: "file", mediaType: "image/png", url }
        ]
      },
      {
        id: "wake-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "seen" }]
      }
    ]);
    expect(await stub.getAttachmentFileCountForTest()).toBe(1);

    await evictDurableObject(stub);

    // Wake-time hydration runs in onStart and reconstructs the pointer back
    // into the original data URL.
    const restored = (await stub.getMessagesForTest()) as UIMessage[];
    expect(restored.map((message) => message.id)).toEqual([
      "wake-user",
      "wake-assistant"
    ]);
    expect(restored[0].parts[0]).toMatchObject({
      type: "text",
      text: "look at this"
    });
    expect(restored[0].parts[1]).toMatchObject({ type: "file", url });

    // Storage still holds the pointer, and no duplicate blob was written.
    const stored = (await stub.getPersistedMessages()) as UIMessage[];
    expect((stored[0].parts[1] as { url: string }).url).toMatch(
      /^attachment:sha256:[0-9a-f]{64}$/
    );
    expect(await stub.getAttachmentFileCountForTest()).toBe(1);

    const response = await exports.default.fetch(
      `http://example.com/agents/attachment-chat-agent/${room}/get-messages`
    );
    expect((await response.json()) as UIMessage[]).toEqual(restored);
  });
});
