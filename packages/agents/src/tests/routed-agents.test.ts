import { env, exports } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentByName } from "../index";

const openSockets = new Set<WebSocket>();

afterEach(() => {
  for (const socket of openSockets) {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "test done");
  }
  openSockets.clear();
});

function ownerName(): string {
  return `routing-owner-${crypto.randomUUID()}`;
}

function routedPath(owner: string, id: string, suffix = ""): string {
  return `/agents/routing-owner-agent/${encodeURIComponent(owner)}/chats/${encodeURIComponent(id)}${suffix}`;
}

async function connect(path: string): Promise<WebSocket> {
  const response = await exports.default.fetch(`http://example.com${path}`, {
    headers: { Upgrade: "websocket" }
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("Expected a WebSocket response");
  socket.accept();
  openSockets.add(socket);
  return socket;
}

function waitForString(
  socket: WebSocket,
  predicate: (message: string) => boolean,
  timeoutMs = 3_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for matching WebSocket message"));
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      if (typeof event.data !== "string" || !predicate(event.data)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(event.data);
    }

    socket.addEventListener("message", onMessage);
  });
}

describe("RoutedAgents", () => {
  it("creates and lists opaque independent Agent entries", async () => {
    const owner = await getAgentByName(env.RoutingOwnerAgent, ownerName());
    const created = await owner.createChat("First chat");

    expect(created).toMatchObject({
      metadata: { title: "First chat" }
    });
    expect(created.id).toBeTypeOf("string");

    const physicalName = await owner.physicalName(created.id);
    expect(physicalName).toBeTypeOf("string");
    expect(physicalName).not.toBe(created.id);

    expect(await owner.listChats()).toEqual([created]);
  });

  it("updates metadata without waking unrelated child Agents", async () => {
    const owner = await getAgentByName(env.RoutingOwnerAgent, ownerName());
    const first = await owner.createChat("First");
    const second = await owner.createChat("Second");

    expect(await owner.setChatMetadata(first.id, "Renamed")).toBe(true);
    expect(await owner.setChatMetadata("missing", "Ignored")).toBe(false);

    const entries = await owner.listChats();
    expect(entries.find((entry) => entry.id === first.id)?.metadata).toEqual({
      title: "Renamed"
    });
    expect(entries.find((entry) => entry.id === second.id)?.metadata).toEqual({
      title: "Second"
    });
  });

  it("forwards HTTP requests and preserves the suffix", async () => {
    const name = ownerName();
    const owner = await getAgentByName(env.RoutingOwnerAgent, name);
    const created = await owner.createChat("Routed");
    const physicalName = await owner.physicalName(created.id);

    const response = await exports.default.fetch(
      `http://example.com${routedPath(name, created.id, "/details")}`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      source: "namespace-chat",
      name: physicalName,
      path: "/details"
    });

    const missing = await exports.default.fetch(
      `http://example.com${routedPath(name, "missing")}`
    );
    expect(missing.status).toBe(404);
  });

  it("routes by the owning entry when the route segment repeats in the path", async () => {
    const name = "chats";
    const owner = await getAgentByName(env.RoutingOwnerAgent, name);
    const created = await owner.createChat("Collision");
    const physicalName = await owner.physicalName(created.id);

    const response = await exports.default.fetch(
      `http://example.com${routedPath(name, created.id, "/chats/other")}`
    );
    expect(await response.json()).toMatchObject({
      name: physicalName,
      path: "/chats/other"
    });
  });

  it("returns a child-owned WebSocket that survives child eviction", async () => {
    const name = ownerName();
    const owner = await getAgentByName(env.RoutingOwnerAgent, name);
    const created = await owner.createChat("Socket");
    const physicalName = await owner.physicalName(created.id);
    if (!physicalName) throw new Error("Expected a physical Agent name");

    const socket = await connect(routedPath(name, created.id));
    expect(
      await waitForString(socket, (message) => message.startsWith("connected:"))
    ).toBe(`connected:${physicalName}`);

    const child = await getAgentByName(env.RoutedChatAgent, physicalName);
    await evictDurableObject(child);

    socket.send("after-eviction");
    expect(
      await waitForString(socket, (message) => message.startsWith("chat:"))
    ).toBe(`chat:${physicalName}:after-eviction`);
  });

  it("makes an entry unreachable, then its Agent storage is wiped", async () => {
    const name = ownerName();
    const owner = await getAgentByName(env.RoutingOwnerAgent, name);
    const created = await owner.createChat("Delete me");
    const physicalName = await owner.physicalName(created.id);
    if (!physicalName) throw new Error("Expected a physical Agent name");

    expect(await owner.setChatValue(created.id, "message", "persisted")).toBe(
      true
    );
    expect(await owner.deleteChat(created.id)).toBe(true);
    expect(await owner.deleteChat(created.id)).toBe(false);
    expect(await owner.listChats()).toEqual([]);

    const route = await exports.default.fetch(
      `http://example.com${routedPath(name, created.id)}`
    );
    expect(route.status).toBe(404);

    await vi.waitFor(async () => {
      const recreated = await getAgentByName(env.RoutedChatAgent, physicalName);
      expect(await recreated.getValue("message")).toBeNull();
    }, 10_000);
  });
});
