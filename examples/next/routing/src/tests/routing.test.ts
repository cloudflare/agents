import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import {
  CALLABLES_RPC_QUERY,
  CALLABLES_RPC_VALUE,
  CAPNWEB_TRANSPORT_QUERY,
  CAPNWEB_TRANSPORT_VALUE
} from "agents/websockets";
import { RpcTarget } from "cloudflare:workers";

function uniqueUser() {
  return `user-${Math.random().toString(36).slice(2)}`;
}

/** Every chat request goes through the owning user's route. */
function chatUrl(userId: string, chatId: string) {
  return `http://example.com/agents/user-hub/${encodeURIComponent(userId)}/chats/${encodeURIComponent(chatId)}/messages`;
}

async function post(userId: string, chatId: string, text: string) {
  const response = await exports.default.fetch(chatUrl(userId, chatId), {
    method: "POST",
    body: JSON.stringify({ role: "user", text })
  });
  expect(response.status).toBe(200);
  return response.json<{ text: string }[]>();
}

describe("a plain Durable Object hub routing to one Agent per chat", () => {
  it("createChat appears in listChats with empty metadata", async () => {
    const user = env.UserHub.getByName(uniqueUser());
    const chatId = await user.createChat();

    expect(await user.listChats()).toMatchObject([
      { id: chatId, metadata: { title: null, lastMessage: null } }
    ]);
  });

  it("routes messages through the hub and pushes metadata back", async () => {
    const userId = uniqueUser();
    const user = env.UserHub.getByName(userId);
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
    const user = env.UserHub.getByName(userId);
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
    const user = env.UserHub.getByName(userId);
    const a = await user.createChat();
    const b = await user.createChat();

    await post(userId, a, "plan the offsite");
    await post(userId, b, "debug the deploy");

    expect((await user.searchChats("OFFSITE")).map((c) => c.id)).toEqual([a]);
    expect(await user.searchChats("nothing-matches")).toEqual([]);
  });

  it("rejects a malformed message body with 400 instead of throwing", async () => {
    const userId = uniqueUser();
    const user = env.UserHub.getByName(userId);
    const chatId = await user.createChat();

    const badJson = await exports.default.fetch(chatUrl(userId, chatId), {
      method: "POST",
      body: "not json"
    });
    expect(badJson.status).toBe(400);

    const wrongShape = await exports.default.fetch(chatUrl(userId, chatId), {
      method: "POST",
      body: JSON.stringify({ role: "narrator", text: 5 })
    });
    expect(wrongShape.status).toBe(400);

    expect(await user.listChats()).toMatchObject([
      { id: chatId, metadata: { title: null, lastMessage: null } }
    ]);
  });

  it("deleteChat stops routing and refuses delayed pushes", async () => {
    const userId = uniqueUser();
    const user = env.UserHub.getByName(userId);
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
        lastMessage: "late completion",
        seq: 99
      })
    ).toBe(false);
    expect(await user.listChats()).toEqual([]);
  });

  it("a delayed push cannot overwrite a more recent one", async () => {
    const userId = uniqueUser();
    const user = env.UserHub.getByName(userId);
    const chatId = await user.createChat();

    expect(
      await user.recordChatActivity(chatId, {
        title: "Newer",
        lastMessage: "arrived first",
        seq: 2
      })
    ).toBe(true);

    // A push whose own ordinal is lower is rejected even though it is
    // delivered second — this is what a slow round-trip from an earlier
    // message would look like landing after a later one.
    expect(
      await user.recordChatActivity(chatId, {
        title: "Older",
        lastMessage: "delayed",
        seq: 1
      })
    ).toBe(false);

    expect((await user.listChats())[0]?.metadata).toMatchObject({
      title: "Newer",
      lastMessage: "arrived first"
    });
  });

  it("two messages landing in the same millisecond never tie", async () => {
    const userId = uniqueUser();
    const user = env.UserHub.getByName(userId);
    const chatId = await user.createChat();

    // The real client sends the user message and its echo back to back;
    // both can land in the same millisecond. Using each message's own
    // AUTOINCREMENT ordinal instead of Date.now() means the second push
    // is never mistaken for a tie and discarded.
    await post(userId, chatId, "first");
    const messages = await post(userId, chatId, "second, same millisecond");

    expect((await user.listChats())[0]?.metadata).toMatchObject({
      lastMessage: messages.at(-1)?.text
    });
  });

  it("forwards WebSocket upgrades so the chat owns the socket", async () => {
    const userId = uniqueUser();
    const user = env.UserHub.getByName(userId);
    const chatId = await user.createChat();

    const response = await exports.default.fetch(
      `http://example.com/agents/user-hub/${userId}/chats/${chatId}`,
      { headers: { Upgrade: "websocket" } }
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a WebSocket upgrade response");
    socket.accept();

    const echoed = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event) => {
        const data = String(event.data);
        // Agent sends identity and state frames on connect; wait for ours.
        if (data.startsWith("echo:")) resolve(data);
      });
    });
    socket.send("ping");
    expect(await echoed).toBe("echo:ping");

    const closed = new Promise<void>((resolve) =>
      socket.addEventListener("close", () => resolve(), { once: true })
    );
    socket.close(1000, "done");
    await closed;
  });

  it("answers 404 under the route for an unknown chat without waking anything", async () => {
    const missing = await exports.default.fetch(
      chatUrl(uniqueUser(), crypto.randomUUID())
    );
    expect(missing.status).toBe(404);
  });

  it("serves the hub's methods to the browser as Cap'n Web callables", async () => {
    const userId = uniqueUser();
    const url = new URL(`http://example.com/agents/user-hub/${userId}`);
    url.searchParams.set(CALLABLES_RPC_QUERY, CALLABLES_RPC_VALUE);
    const response = await exports.default.fetch(url, {
      headers: { Upgrade: "websocket" }
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a WebSocket upgrade response");
    socket.accept();
    const hub = newWebSocketRpcSession<{
      createChat(): Promise<string>;
      listChats(): Promise<{ id: string }[]>;
      deleteChat(id: string): Promise<boolean>;
    }>(socket);
    try {
      const chatId = await hub.createChat();
      await post(userId, chatId, "hello over callables");
      expect(await hub.listChats()).toMatchObject([{ id: chatId }]);
      expect(await hub.deleteChat(chatId)).toBe(true);
      expect(await hub.listChats()).toEqual([]);
    } finally {
      (hub as Partial<Disposable>)[Symbol.dispose]?.();
    }
  });

  it("speaks the Agent protocol to useAgent over a plain socket", async () => {
    const userId = uniqueUser();
    const response = await exports.default.fetch(
      `http://example.com/agents/user-hub/${userId}`,
      { headers: { Upgrade: "websocket" } }
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a WebSocket upgrade response");
    socket.accept();
    const frames: Record<string, unknown>[] = [];
    const waiters: ((f: Record<string, unknown>) => void)[] = [];
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    const next = () =>
      frames.length
        ? Promise.resolve(frames.shift()!)
        : new Promise<Record<string, unknown>>((r) => waiters.push(r));

    // Identity first: this is what resolves useAgent's `ready`.
    expect(await next()).toEqual({
      type: "cf_agent_identity",
      name: userId,
      agent: "user-hub"
    });
    // Then rpc frames, exactly what `stub.createChat()` sends.
    socket.send(
      JSON.stringify({ type: "rpc", id: "1", method: "createChat", args: [] })
    );
    const created = await next();
    expect(created).toMatchObject({ id: "1", success: true, done: true });
    socket.send(
      JSON.stringify({ type: "rpc", id: "2", method: "listChats", args: [] })
    );
    expect(await next()).toMatchObject({
      id: "2",
      result: [{ id: created.result }]
    });
    socket.close(1000, "done");
  });

  it("speaks the same protocol over the Cap'n Web transport", async () => {
    const userId = uniqueUser();
    const url = new URL(`http://example.com/agents/user-hub/${userId}`);
    url.searchParams.set(CAPNWEB_TRANSPORT_QUERY, CAPNWEB_TRANSPORT_VALUE);
    const response = await exports.default.fetch(url, {
      headers: { Upgrade: "websocket" }
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("Expected a WebSocket upgrade response");
    socket.accept();

    const frames: Record<string, unknown>[] = [];
    const waiters: ((f: Record<string, unknown>) => void)[] = [];
    class Inbox extends RpcTarget {
      message(value: string) {
        const frame = JSON.parse(value) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter) waiter(frame);
        else frames.push(frame);
      }
    }
    const next = () =>
      frames.length
        ? Promise.resolve(frames.shift()!)
        : new Promise<Record<string, unknown>>((r) => waiters.push(r));
    const pipe = newWebSocketRpcSession<{
      __cf_agent_send(message: string): Promise<void>;
    }>(socket, new Inbox());
    try {
      expect(await next()).toMatchObject({
        type: "cf_agent_identity",
        name: userId
      });
      await pipe.__cf_agent_send(
        JSON.stringify({ type: "rpc", id: "1", method: "listChats", args: [] })
      );
      expect(await next()).toMatchObject({
        id: "1",
        success: true,
        result: []
      });
    } finally {
      pipe[Symbol.dispose]();
    }
  });
});
