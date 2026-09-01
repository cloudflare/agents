import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

function uniqueUser() {
  return `user-${Math.random().toString(36).slice(2)}`;
}

async function chatFor(userId: string, chatId: string) {
  return getAgentByName(env.ChatAgent, `${userId}:${chatId}`);
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
    await chat.addMessage("user", "How do facets work?");
    await chat.addMessage("assistant", "They are colocated isolates.");

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
    await firstChat.addMessage("user", "older conversation");
    const secondChat = await chatFor(userId, second);
    await secondChat.addMessage("user", "newer conversation");

    expect((await user.listChats()).map((c) => c.chatId)).toEqual([
      second,
      first
    ]);

    // Messaging the older chat flips the order — the push keeps the
    // index current without waking any other chat.
    await firstChat.addMessage("user", "back to the old thread");
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

    await user.recordChatActivity({
      chatId: first,
      title: "first",
      lastMessage: "first activity",
      updatedAt
    });
    await user.recordChatActivity({
      chatId: second,
      title: "second",
      lastMessage: "second activity",
      updatedAt
    });

    expect((await user.listChats()).map((chat) => chat.chatId)).toEqual([
      second,
      first
    ]);

    await user.recordChatActivity({
      chatId: first,
      title: "first",
      lastMessage: "latest activity",
      updatedAt
    });
    expect((await user.listChats()).map((chat) => chat.chatId)).toEqual([
      first,
      second
    ]);
  });

  it("does not recreate a deleted catalog row from delayed activity", async () => {
    const user = await getAgentByName(env.UserAgent, uniqueUser());
    const chatId = await user.createChat();
    await user.deleteChat(chatId);

    expect(
      await user.recordChatActivity({
        chatId,
        title: "stale",
        lastMessage: "late completion",
        updatedAt: Date.now()
      })
    ).toBe(false);
    expect(await user.listChats()).toEqual([]);
  });

  it("searches across chats via the index only", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const a = await user.createChat();
    const b = await user.createChat();

    await (await chatFor(userId, a)).addMessage("user", "plan the offsite");
    await (await chatFor(userId, b)).addMessage("user", "debug the deploy");

    const hits = await user.searchChats("offsite");
    expect(hits.map((c) => c.chatId)).toEqual([a]);
    expect(await user.searchChats("nothing-matches")).toEqual([]);
  });

  it("deleteChat removes the index row and wipes the chat's storage", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const chatId = await user.createChat();

    const chat = await chatFor(userId, chatId);
    await chat.addMessage("user", "to be deleted");

    await user.deleteChat(chatId);
    expect(await user.listChats()).toEqual([]);

    // A fresh stub to the same name starts from empty storage.
    const revived = await chatFor(userId, chatId);
    expect(await revived.getMessages()).toEqual([]);
  });
});
