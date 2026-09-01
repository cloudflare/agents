import { env, exports as workerExports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

function uniqueUser() {
  return `user-${Math.random().toString(36).slice(2)}`;
}

async function chatFor(userId: string, chatId: string) {
  return getAgentByName(env.ChatAgent, `${userId}:${chatId}`);
}

async function addMessage(
  chat: Awaited<ReturnType<typeof chatFor>>,
  role: "user" | "assistant",
  text: string,
  messageId: string = crypto.randomUUID()
) {
  return chat.addMessage(messageId, role, text);
}

async function fetchWorker(
  path: string,
  init?: RequestInit
): Promise<Response> {
  return workerExports.default.fetch(`http://example.com${path}`, init);
}

describe("one DO per chat + per-user index", () => {
  it("createChat appears in listChats", async () => {
    const user = await getAgentByName(env.UserAgent, uniqueUser());
    const chatId = await user.createChat();

    const chats = await user.listChats();
    expect(chats.map((c) => c.chatId)).toEqual([chatId]);
    expect(chats[0].title).toBeNull();
  });

  it("addMessage pushes title and lastMessage into the index", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const chatId = await user.createChat();

    const chat = await chatFor(userId, chatId);
    await addMessage(chat, "user", "How do facets work?");
    await addMessage(chat, "assistant", "They are colocated isolates.");

    const [meta] = await user.listChats();
    expect(meta.chatId).toBe(chatId);
    expect(meta.title).toBe("How do facets work?");
    expect(meta.lastMessage).toBe("They are colocated isolates.");
  });

  it("orders chats by most recent activity", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const first = await user.createChat();
    const second = await user.createChat();

    const firstChat = await chatFor(userId, first);
    await addMessage(firstChat, "user", "older conversation");
    const secondChat = await chatFor(userId, second);
    await addMessage(secondChat, "user", "newer conversation");

    expect((await user.listChats()).map((c) => c.chatId)).toEqual([
      second,
      first
    ]);

    // Messaging the older chat flips the order — the push keeps the
    // index current without waking any other chat.
    await addMessage(firstChat, "user", "back to the old thread");
    expect((await user.listChats()).map((c) => c.chatId)).toEqual([
      first,
      second
    ]);
  });

  it("uses User-agent activity order when wall-clock timestamps tie", async () => {
    const user = await getAgentByName(env.UserAgent, uniqueUser());
    const first = await user.createChat();
    const second = await user.createChat();
    const updatedAt = 123;

    await user.applyChatSnapshot({
      chatId: first,
      revision: 1,
      title: "first",
      lastMessage: "first activity",
      updatedAt
    });
    await user.applyChatSnapshot({
      chatId: second,
      revision: 1,
      title: "second",
      lastMessage: "second activity",
      updatedAt
    });

    expect((await user.listChats()).map((chat) => chat.chatId)).toEqual([
      second,
      first
    ]);

    await user.applyChatSnapshot({
      chatId: first,
      revision: 2,
      title: "first",
      lastMessage: "latest activity",
      updatedAt
    });
    expect((await user.listChats()).map((chat) => chat.chatId)).toEqual([
      first,
      second
    ]);

    await user.applyChatSnapshot({
      chatId: first,
      revision: 1,
      title: "stale",
      lastMessage: "must be ignored",
      updatedAt
    });
    expect((await user.listChats())[0]?.lastMessage).toBe("latest activity");
  });

  it("does not treat delayed old activity as newer", async () => {
    const user = await getAgentByName(env.UserAgent, uniqueUser());
    const recent = await user.createChat();
    const delayed = await user.createChat();

    await user.applyChatSnapshot({
      chatId: recent,
      revision: 1,
      title: "match recent",
      lastMessage: "newer activity",
      updatedAt: 200
    });
    await user.applyChatSnapshot({
      chatId: delayed,
      revision: 1,
      title: "match delayed",
      lastMessage: "older activity delivered later",
      updatedAt: 100
    });

    expect((await user.listChats()).map((chat) => chat.chatId)).toEqual([
      recent,
      delayed
    ]);
    expect(
      (await user.searchChats("match")).map((chat) => chat.chatId)
    ).toEqual([recent, delayed]);
  });

  it("does not recreate a deleted catalog row from delayed activity", async () => {
    const user = await getAgentByName(env.UserAgent, uniqueUser());
    const chatId = await user.createChat();
    await user.deleteChat(chatId);

    expect(
      await user.applyChatSnapshot({
        chatId,
        revision: 1,
        title: "stale",
        lastMessage: "late completion",
        updatedAt: Date.now()
      })
    ).toBe(false);
    expect(await user.listChats()).toEqual([]);
  });

  it("accepts a message once and repairs a failed index projection", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const chatId = await user.createChat();
    const chat = await chatFor(userId, chatId);

    await user.setProjectionDeliveryBlocked(true);

    await expect(
      chat.addMessage("message-1", "user", "survives delivery failure")
    ).resolves.toEqual({ status: "accepted", revision: 1 });
    expect((await user.listChats())[0]?.lastMessage).toBeNull();

    await user.setProjectionDeliveryBlocked(false);
    await expect(user.repairChat(chatId)).resolves.toBe(true);
    expect((await user.listChats())[0]?.lastMessage).toBe(
      "survives delivery failure"
    );

    await addMessage(chat, "assistant", "a newer message", "message-2");
    await user.setProjectionDeliveryBlocked(true);
    await expect(
      chat.addMessage("message-1", "user", "survives delivery failure")
    ).resolves.toEqual({ status: "accepted", revision: 1 });
    expect(await chat.getMessages()).toHaveLength(2);
    expect((await user.listChats())[0]?.lastMessage).toBe("a newer message");
  });

  it("searches across chats via the index only", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const a = await user.createChat();
    const b = await user.createChat();

    await addMessage(await chatFor(userId, a), "user", "plan the offsite");
    await addMessage(await chatFor(userId, b), "user", "debug the deploy");

    const hits = await user.searchChats("offsite");
    expect(hits.map((c) => c.chatId)).toEqual([a]);
    expect(await user.searchChats("nothing-matches")).toEqual([]);
  });

  it("routes active chats through the User catalog and hides physical routes", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const chatId = await user.createChat();

    const response = await fetchWorker(
      `/users/${encodeURIComponent(userId)}/chats/${encodeURIComponent(chatId)}`,
      { headers: { Upgrade: "websocket" } }
    );
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, "test complete");

    const direct = await fetchWorker(
      `/agents/chat-agent/${encodeURIComponent(`${userId}:${chatId}`)}`,
      { headers: { Upgrade: "websocket" } }
    );
    expect(direct.status).toBe(404);
  });

  it("deleteChat rejects reconnects and writes from stale chat handles", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const chatId = await user.createChat();
    await addMessage(await chatFor(userId, chatId), "user", "before delete");

    await user.deleteChat(chatId);

    const reconnect = await fetchWorker(
      `/users/${encodeURIComponent(userId)}/chats/${encodeURIComponent(chatId)}`,
      { headers: { Upgrade: "websocket" } }
    );
    expect(reconnect.status).toBe(404);

    const revived = await chatFor(userId, chatId);
    await expect(
      revived.addMessage("stale-message", "user", "after delete")
    ).resolves.toEqual({ status: "inactive" });
    expect(await revived.getMessages()).toEqual([]);
  });

  it("deleteChat removes the index row and wipes the chat's storage", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const chatId = await user.createChat();

    const chat = await chatFor(userId, chatId);
    await addMessage(chat, "user", "to be deleted");

    await user.deleteChat(chatId);
    expect(await user.listChats()).toEqual([]);

    // A fresh stub to the same name starts from empty storage.
    const revived = await chatFor(userId, chatId);
    expect(await revived.getMessages()).toEqual([]);
  });
});
