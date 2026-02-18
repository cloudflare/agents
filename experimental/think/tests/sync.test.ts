import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { getAgentByName } from "agents";
import {
  MessageType,
  type ServerMessage,
  type ThinkMessage,
  type ThreadInfo,
  type FileEntry
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

// ── File browser protocol ────────────────────────────────────────────────────
//
// These tests verify the WebSocket protocol for the file browser:
// LIST_FILES → FILE_LIST and READ_FILE → FILE_CONTENT round-trips,
// and the ownership guard that silently drops requests for unknown workspaces.
//
// Note: tests that need pre-populated file content are covered by the E2E
// suite (sync.spec.ts workspace tests), which runs the full agent to write
// files. The facet-derived workspace ID can't be accessed directly from the
// unit test environment.

describe("ThinkAgent file browser protocol", () => {
  function waitForFilelist(
    ws: WebSocket,
    dir: string,
    timeout = 2000
  ): Promise<FileEntry[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for FILE_LIST dir=${dir}`)),
        timeout
      );
      const handler = (e: MessageEvent) => {
        const data = JSON.parse(e.data as string) as ServerMessage;
        if (data.type === MessageType.FILE_LIST && data.dir === dir) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(data.entries as FileEntry[]);
        }
      };
      ws.addEventListener("message", handler);
    });
  }

  function waitForFileContent(
    ws: WebSocket,
    path: string,
    timeout = 2000
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Timeout waiting for FILE_CONTENT path=${path}`)),
        timeout
      );
      const handler = (e: MessageEvent) => {
        const data = JSON.parse(e.data as string) as ServerMessage;
        if (data.type === MessageType.FILE_CONTENT && data.path === path) {
          clearTimeout(timer);
          ws.removeEventListener("message", handler);
          resolve(data.content as string | null);
        }
      };
      ws.addEventListener("message", handler);
    });
  }

  it("LIST_FILES sends FILE_LIST for an owned empty workspace", async () => {
    const room = `fb-list-empty-${crypto.randomUUID()}`;
    const agent = await getAgentByName(env.ThinkAgent, room);
    const wsInfo = await agent.createWorkspace("EmptyWS");

    const { ws: socket } = await connectWS(room);
    await drainInitialMessages(socket);

    const listPromise = waitForFilelist(socket, "/");
    socket.send(
      JSON.stringify({
        type: MessageType.LIST_FILES,
        workspaceId: wsInfo.id,
        dir: "/"
      })
    );
    // The server must reply with a FILE_LIST (even if the workspace is empty)
    const entries = await listPromise;
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toEqual([]);
    socket.close();
  });

  it("LIST_FILES is silently ignored for a workspace not owned by this agent", async () => {
    const room = `fb-auth-${crypto.randomUUID()}`;
    const { ws: socket } = await connectWS(room);
    await drainInitialMessages(socket);

    socket.send(
      JSON.stringify({
        type: MessageType.LIST_FILES,
        workspaceId: "nonexistent-ws-id",
        dir: "/"
      })
    );

    // Should receive no FILE_LIST — the server silently drops unowned requests
    const messages = await collectMessages(socket, 20, 500);
    const fileLists = messages.filter((m) => m.type === MessageType.FILE_LIST);
    expect(fileLists).toHaveLength(0);
    socket.close();
  });

  it("READ_FILE returns null FILE_CONTENT for a missing path", async () => {
    const room = `fb-read-miss-${crypto.randomUUID()}`;
    const agent = await getAgentByName(env.ThinkAgent, room);
    const wsInfo = await agent.createWorkspace("MissWS");

    const { ws: socket } = await connectWS(room);
    await drainInitialMessages(socket);

    const contentPromise = waitForFileContent(socket, "/not-there.ts");
    socket.send(
      JSON.stringify({
        type: MessageType.READ_FILE,
        workspaceId: wsInfo.id,
        path: "/not-there.ts"
      })
    );
    // Server must reply — content is null for a non-existent file
    const content = await contentPromise;
    expect(content).toBeNull();
    socket.close();
  });

  it("READ_FILE is silently ignored for unowned workspace", async () => {
    const room = `fb-read-auth-${crypto.randomUUID()}`;
    const { ws: socket } = await connectWS(room);
    await drainInitialMessages(socket);

    socket.send(
      JSON.stringify({
        type: MessageType.READ_FILE,
        workspaceId: "fake-ws-id",
        path: "/secret.txt"
      })
    );

    const messages = await collectMessages(socket, 20, 500);
    const contentMsgs = messages.filter(
      (m) => m.type === MessageType.FILE_CONTENT
    );
    expect(contentMsgs).toHaveLength(0);
    socket.close();
  });

  it("LIST_FILES only sends to the requesting connection, not all clients", async () => {
    const room = `fb-targeted-${crypto.randomUUID()}`;
    const agent = await getAgentByName(env.ThinkAgent, room);
    const wsInfo = await agent.createWorkspace("TargetedWS");

    // Two clients connected to the same agent room
    const { ws: requester } = await connectWS(room);
    const { ws: observer } = await connectWS(room);
    await drainInitialMessages(requester);
    await drainInitialMessages(observer);

    // Only the requester sends LIST_FILES
    const listPromise = waitForFilelist(requester, "/");
    requester.send(
      JSON.stringify({
        type: MessageType.LIST_FILES,
        workspaceId: wsInfo.id,
        dir: "/"
      })
    );
    await listPromise; // requester receives it

    // Observer should NOT have received a FILE_LIST
    const observed = await collectMessages(observer, 20, 300);
    const fileLists = observed.filter((m) => m.type === MessageType.FILE_LIST);
    expect(fileLists).toHaveLength(0);

    requester.close();
    observer.close();
  });
});

// ── RUN queue ────────────────────────────────────────────────────────────────

describe("ThinkAgent RUN queue", () => {
  it("a second RUN while one is running queues and executes after the first", async () => {
    // Two simultaneous RUN messages → two STREAM_ENDs (not one, not three):
    // the first fires immediately, the second is queued and runs after.
    // Because the AI binding isn't available in tests, each run errors quickly,
    // but STREAM_END is still always sent in the finally path.
    const room = `run-queue-${crypto.randomUUID()}`;

    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    ws.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: DEFAULT_THREAD,
        message: makeMessage("user", "hello")
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    // Fire two RUNs near-simultaneously
    ws.send(
      JSON.stringify({ type: MessageType.RUN, threadId: DEFAULT_THREAD })
    );
    ws.send(
      JSON.stringify({ type: MessageType.RUN, threadId: DEFAULT_THREAD })
    );

    // Collect for up to 8 s — two agent runs need time even when they error fast
    const msgs = await collectMessages(ws, 100, 8000);
    const streamEnds = msgs.filter(
      (m) => m.type === MessageType.STREAM_END && m.threadId === DEFAULT_THREAD
    );

    // Two STREAM_ENDs — one for the immediate run, one for the queued run
    expect(streamEnds).toHaveLength(2);

    ws.close();
  }, 10_000); // extend vitest test timeout for two sequential agent runs

  it("more than two concurrent RUNs result in exactly two runs (queue capped at one)", async () => {
    // Three RUNs: first runs immediately, second is queued, third is discarded
    // (queue is already full). After the first completes the queued one runs.
    // Total STREAM_ENDs: 2 — not 3.
    const room = `run-queue-cap-${crypto.randomUUID()}`;

    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    ws.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: DEFAULT_THREAD,
        message: makeMessage("user", "hi")
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    ws.send(
      JSON.stringify({ type: MessageType.RUN, threadId: DEFAULT_THREAD })
    );
    ws.send(
      JSON.stringify({ type: MessageType.RUN, threadId: DEFAULT_THREAD })
    );
    ws.send(
      JSON.stringify({ type: MessageType.RUN, threadId: DEFAULT_THREAD })
    );

    const msgs = await collectMessages(ws, 100, 8000);
    const streamEnds = msgs.filter(
      (m) => m.type === MessageType.STREAM_END && m.threadId === DEFAULT_THREAD
    );

    // Exactly two — the third RUN was silently discarded because one was already queued
    expect(streamEnds).toHaveLength(2);

    ws.close();
  }, 10_000);
});

// ── RUN with workspace attached ───────────────────────────────────────────────
//
// These tests verify that passing a workspace to Chat (rather than pre-built
// tool closures) doesn't break the streaming pipeline. Without a real AI
// binding the run will error internally, but STREAM_END must still arrive.

describe("ThinkAgent RUN with workspace", () => {
  it("RUN with attached workspace still delivers STREAM_END (no RPC disconnect)", async () => {
    const room = `ws-run-${crypto.randomUUID()}`;
    const agent = await getAgentByName(env.ThinkAgent, room);

    // Create a workspace and thread, attach them
    const wsInfo = await agent.createWorkspace("CodeWS");
    const thread = await agent.createThread("CodeThread");
    await agent.attachWorkspace(thread.id, wsInfo.id);

    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    ws.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: thread.id,
        message: makeMessage("user", "create a file /hello.txt")
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    const streamEndPromise = waitForType(ws, MessageType.STREAM_END, 6000);
    ws.send(JSON.stringify({ type: MessageType.RUN, threadId: thread.id }));

    // STREAM_END must arrive even though the AI binding isn't available.
    // The critical thing: no "WritableStream disconnected" crash — the run
    // must fail gracefully and still signal completion to the client.
    const msg = await streamEndPromise;
    expect(msg.type).toBe(MessageType.STREAM_END);

    ws.close();
  }, 8000);

  it("RUN with workspace attached then detached sends STREAM_END for both", async () => {
    const room = `ws-detach-run-${crypto.randomUUID()}`;
    const agent = await getAgentByName(env.ThinkAgent, room);

    const wsInfo = await agent.createWorkspace("TempWS");
    const thread = await agent.createThread("TempThread");
    await agent.attachWorkspace(thread.id, wsInfo.id);
    await agent.detachWorkspace(thread.id);

    const { ws } = await connectWS(room);
    await drainInitialMessages(ws);

    ws.send(
      JSON.stringify({
        type: MessageType.ADD,
        threadId: thread.id,
        message: makeMessage("user", "hello")
      })
    );
    await new Promise((r) => setTimeout(r, 100));

    const streamEndPromise = waitForType(ws, MessageType.STREAM_END, 6000);
    ws.send(JSON.stringify({ type: MessageType.RUN, threadId: thread.id }));

    const msg = await streamEndPromise;
    expect(msg.type).toBe(MessageType.STREAM_END);

    ws.close();
  }, 8000);
});
