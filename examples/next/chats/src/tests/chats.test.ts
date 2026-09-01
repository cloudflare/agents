import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";

function uniqueUser() {
  return `user-${Math.random().toString(36).slice(2)}`;
}

/** Every chat request goes through the owning user's route. */
function chatUrl(userId: string, chatId: string) {
  return `http://example.com/agents/user-agent/${encodeURIComponent(userId)}/chats/${encodeURIComponent(chatId)}/messages`;
}

async function post(userId: string, chatId: string, text: string) {
  const response = await exports.default.fetch(chatUrl(userId, chatId), {
    method: "POST",
    body: JSON.stringify({ role: "user", text })
  });
  expect(response.status).toBe(200);
  return response.json<{ text: string }[]>();
}

describe("user hub routing to one DO per chat", () => {
  it("createChat appears in listChats with empty metadata", async () => {
    const user = await getAgentByName(env.UserAgent, uniqueUser());
    const chatId = await user.createChat();

    expect(await user.listChats()).toMatchObject([
      { id: chatId, metadata: { title: null, lastMessage: null } }
    ]);
  });

  it("routes messages through the hub and pushes metadata back", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const chatId = await user.createChat();

    await post(userId, chatId, "How do facets work?");
    const messages = await post(userId, chatId, "Any alternatives?");
    expect(messages.map((m) => m.text)).toEqual([
      "How do facets work?",
      "Any alternatives?"
    ]);

    const [entry] = await user.listChats();
    expect(entry).toMatchObject({
      id: chatId,
      metadata: {
        title: "How do facets work?",
        lastMessage: "Any alternatives?"
      }
    });
  });

  it("orders chats by most recent activity", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const first = await user.createChat();
    const second = await user.createChat();

    await post(userId, first, "older conversation");
    await post(userId, second, "newer conversation");
    expect((await user.listChats()).map((c) => c.id)).toEqual([second, first]);

    await post(userId, first, "back to the old thread");
    expect((await user.listChats()).map((c) => c.id)).toEqual([first, second]);
  });

  it("searches across chats via the hub only", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const a = await user.createChat();
    const b = await user.createChat();

    await post(userId, a, "plan the offsite");
    await post(userId, b, "debug the deploy");

    expect((await user.searchChats("OFFSITE")).map((c) => c.id)).toEqual([a]);
    expect(await user.searchChats("nothing-matches")).toEqual([]);
  });

  it("deleteChat stops routing and refuses delayed pushes", async () => {
    const userId = uniqueUser();
    const user = await getAgentByName(env.UserAgent, userId);
    const chatId = await user.createChat();
    await post(userId, chatId, "to be deleted");

    expect(await user.deleteChat(chatId)).toBe(true);
    expect(await user.deleteChat(chatId)).toBe(false);
    expect(await user.listChats()).toEqual([]);

    const gone = await exports.default.fetch(chatUrl(userId, chatId));
    expect(gone.status).toBe(404);

    expect(
      await user.recordChatActivity(chatId, {
        title: "stale",
        lastMessage: "late completion"
      })
    ).toBe(false);
    expect(await user.listChats()).toEqual([]);
  });
});
