import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getAgentByName } from "agents";
import {
  MessageType,
  type ServerMessage,
  type ThinkMessage,
  type ThreadInfo
} from "../src/shared";
import type { Env } from "./worker";
import worker from "./worker";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const DEFAULT_THREAD = "default";

// ── Helpers ──────────────────────────────────────────────────────────

async function connectWS(room: string) {
  const ctx = createExecutionContext();
  const req = new Request(`http://example.com/agents/think-agent/${room}`, {
    headers: { Upgrade: "websocket" }
  });
  const res = await worker.fetch(req, env, ctx);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  expect(ws).toBeDefined();
  ws.accept();
  return { ws, ctx };
}

function waitForType(
  ws: WebSocket,
  type: string,
  timeout = 2000
): Promise<ServerMessage<ThinkMessage>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for ${type}`)),
      timeout
    );
    const handler = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as ServerMessage<ThinkMessage>;
      if (data.type === type) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function waitForSync(ws: WebSocket, timeout = 2000): Promise<ThinkMessage[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timeout waiting for sync")),
      timeout
    );
    const handler = (e: MessageEvent) => {
      const data = JSON.parse(e.data as string) as ServerMessage<ThinkMessage>;
      if (data.type === MessageType.SYNC) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(data.messages);
      }
    };
    ws.addEventListener("message", handler);
  });
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeout = 2000
): Promise<Array<ServerMessage<ThinkMessage>>> {
  return new Promise((resolve) => {
    const messages: Array<ServerMessage<ThinkMessage>> = [];
    const timer = setTimeout(() => resolve(messages), timeout);
    const handler = (e: MessageEvent) => {
      try {
        messages.push(
          JSON.parse(e.data as string) as ServerMessage<ThinkMessage>
        );
        if (messages.length >= count) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(messages);
        }
      } catch {
        // skip
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function drainInitialMessages(ws: WebSocket) {
  await collectMessages(ws, 10, 500);
}

function makeMessage(
  role: "user" | "assistant",
  content: string
): ThinkMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    role,
    content,
    createdAt: Date.now()
  };
}

// ── Thread management (RPC) ──────────────────────────────────────────

describe("ThinkAgent thread management (RPC)", () => {
  it("starts with no threads", async () => {
    const agent = await getAgentByName(
      env.ThinkAgent,
      `empty-${crypto.randomUUID()}`
    );
    const threads = await agent.getThreads();
    expect(threads).toEqual([]);
  });

  it("creates a thread with auto-generated name", async () => {
    const agent = await getAgentByName(
      env.ThinkAgent,
      `create-${crypto.randomUUID()}`
    );
    const thread = await agent.createThread();

    expect(thread.id).toBeTruthy();
    expect(thread.name).toContain("Thread");

    const threads = await agent.getThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(thread.id);
  });

  it("creates a thread with custom name", async () => {
    const agent = await getAgentByName(
      env.ThinkAgent,
      `create-named-${crypto.randomUUID()}`
    );
    const thread = await agent.createThread("My Chat");

    expect(thread.name).toBe("My Chat");
  });

  it("creates multiple threads", async () => {
    const agent = await getAgentByName(
      env.ThinkAgent,
      `multi-${crypto.randomUUID()}`
    );
    await agent.createThread("First");
    await agent.createThread("Second");
    await agent.createThread("Third");

    const threads = await agent.getThreads();
    expect(threads).toHaveLength(3);
  });

  it("deletes a thread", async () => {
    const agent = await getAgentByName(
      env.ThinkAgent,
      `delete-${crypto.randomUUID()}`
    );
    const t1 = await agent.createThread("Keep");
    const t2 = await agent.createThread("Remove");

    await agent.deleteThread(t2.id);

    const threads = await agent.getThreads();
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe(t1.id);
  });

  it("renames a thread", async () => {
    const agent = await getAgentByName(
      env.ThinkAgent,
      `rename-${crypto.randomUUID()}`
    );
    const thread = await agent.createThread("Old Name");
    await agent.renameThread(thread.id, "New Name");

    const threads = await agent.getThreads();
    expect(threads[0].name).toBe("New Name");
  });

  it("auto-creates thread on first message to unknown threadId", async () => {
    const room = `auto-${crypto.randomUUID()}`;
    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    const { ws: ws2 } = await connectWS(room);
    await drainInitialMessages(ws2);

    const threadsPromise = waitForType(ws2, MessageType.THREADS);
    ws.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: "new-thread",
        message: makeMessage("user", "hello")
      })
    );

    const threadsMsg = await threadsPromise;
    if (threadsMsg.type === MessageType.THREADS) {
      expect(threadsMsg.threads.length).toBeGreaterThanOrEqual(1);
      const found = threadsMsg.threads.find(
        (t: ThreadInfo) => t.id === "new-thread"
      );
      expect(found).toBeDefined();
    }

    ws.close();
    ws2.close();
  });
});

// ── Thread management (WebSocket) ────────────────────────────────────

describe("ThinkAgent thread management (WebSocket)", () => {
  it("sends thread list on connect", async () => {
    const room = `connect-threads-${crypto.randomUUID()}`;

    const agent = await getAgentByName(env.ThinkAgent, room);
    await agent.createThread("Pre-existing");

    const { ws } = await connectWS(room);
    const msg = await waitForType(ws, MessageType.THREADS);

    if (msg.type === MessageType.THREADS) {
      expect(msg.threads).toHaveLength(1);
      expect(msg.threads[0].name).toBe("Pre-existing");
    }

    ws.close();
  });

  it("broadcasts thread list on create", async () => {
    const room = `ws-create-${crypto.randomUUID()}`;
    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    const threadsPromise = waitForType(ws, MessageType.THREADS);
    ws.send(
      JSON.stringify({
        type: MessageType.CREATE_THREAD,
        name: "New Thread"
      })
    );
    const msg = await threadsPromise;

    if (msg.type === MessageType.THREADS) {
      expect(msg.threads).toHaveLength(1);
      expect(msg.threads[0].name).toBe("New Thread");
    }

    ws.close();
  });

  it("broadcasts thread list on delete", async () => {
    const room = `ws-delete-${crypto.randomUUID()}`;
    const agent = await getAgentByName(env.ThinkAgent, room);
    const t = await agent.createThread("To Delete");

    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    const threadsPromise = waitForType(ws, MessageType.THREADS);
    ws.send(
      JSON.stringify({
        type: MessageType.DELETE_THREAD,
        threadId: t.id
      })
    );
    const msg = await threadsPromise;

    if (msg.type === MessageType.THREADS) {
      expect(msg.threads).toEqual([]);
    }

    ws.close();
  });

  it("broadcasts thread list on rename", async () => {
    const room = `ws-rename-${crypto.randomUUID()}`;
    const agent = await getAgentByName(env.ThinkAgent, room);
    const t = await agent.createThread("Old");

    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    const threadsPromise = waitForType(ws, MessageType.THREADS);
    ws.send(
      JSON.stringify({
        type: MessageType.RENAME_THREAD,
        threadId: t.id,
        name: "Renamed"
      })
    );
    const msg = await threadsPromise;

    if (msg.type === MessageType.THREADS) {
      expect(msg.threads[0].name).toBe("Renamed");
    }

    ws.close();
  });
});

// ── Message sync (existing tests, updated) ───────────────────────────

describe("ThinkAgent message sync", () => {
  it("persists a message and syncs to other clients", async () => {
    const room = `add-${crypto.randomUUID()}`;
    const { ws: ws1 } = await connectWS(room);
    await drainInitialMessages(ws1);
    const { ws: ws2 } = await connectWS(room);
    await drainInitialMessages(ws2);

    const msg = makeMessage("user", "hello world");
    const syncPromise = waitForSync(ws2);
    ws1.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: DEFAULT_THREAD,
        message: msg
      })
    );

    const synced = await syncPromise;
    expect(synced).toHaveLength(1);
    expect(synced[0].content).toBe("hello world");

    ws1.close();
    ws2.close();
  });

  it("messages in different threads are independent", async () => {
    const room = `multi-thread-${crypto.randomUUID()}`;
    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);
    const { ws: ws2 } = await connectWS(room);
    await drainInitialMessages(ws2);

    ws.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: "thread-a",
        message: makeMessage("user", "in thread A")
      })
    );
    const syncA = await waitForSync(ws2);

    ws.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: "thread-b",
        message: makeMessage("user", "in thread B")
      })
    );
    const syncB = await waitForSync(ws2);

    expect(syncA).toHaveLength(1);
    expect(syncA[0].content).toBe("in thread A");
    expect(syncB).toHaveLength(1);
    expect(syncB[0].content).toBe("in thread B");

    ws.close();
    ws2.close();
  });

  it("GET_MESSAGES returns persisted messages for a thread", async () => {
    const room = `get-msgs-${crypto.randomUUID()}`;
    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    ws.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: "my-thread",
        message: makeMessage("user", "persisted msg")
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    const syncPromise = waitForSync(ws);
    ws.send(
      JSON.stringify({
        type: MessageType.GET_MESSAGES,
        threadId: "my-thread"
      })
    );
    const result = await syncPromise;

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("persisted msg");

    ws.close();
  });

  it("GET_MESSAGES returns empty for unknown thread", async () => {
    const room = `get-msgs-empty-${crypto.randomUUID()}`;
    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    const syncPromise = waitForSync(ws);
    ws.send(
      JSON.stringify({
        type: MessageType.GET_MESSAGES,
        threadId: "nonexistent"
      })
    );
    const result = await syncPromise;

    expect(result).toEqual([]);

    ws.close();
  });

  it("ignores malformed messages", async () => {
    const room = `malformed-${crypto.randomUUID()}`;
    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    ws.send("not json");
    ws.send(JSON.stringify({ type: MessageType.ADD }));

    const { ws: ws2 } = await connectWS(room);
    await drainInitialMessages(ws2);

    const msg = makeMessage("user", "still works");
    const syncPromise = waitForSync(ws2);
    ws.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: DEFAULT_THREAD,
        message: msg
      })
    );
    const result = await syncPromise;
    expect(result).toHaveLength(1);

    ws.close();
    ws2.close();
  });
});
