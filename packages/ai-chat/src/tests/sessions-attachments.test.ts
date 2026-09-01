import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";

/** ai-chat keeps its existing message behavior when attachment storage is on. */
describe("AIChatAgent Sessions attachments", () => {
  it("stores a pointer but keeps in-memory and HTTP messages reconstructed", async () => {
    const room = `sessions-attachment-${crypto.randomUUID()}`;
    const stub = await getAgentByName(env.TestChatAgent, room);
    await stub.enableAttachmentsForTest();

    const url = `data:image/png;base64,${btoa("image payload")}`;
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
});
