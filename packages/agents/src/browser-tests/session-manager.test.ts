import { describe, expect, it } from "vitest";
import {
  createBrowserSessionManager,
  type BrowserSessionLock,
  type BrowserSessionStore,
  type StoredBrowserSession
} from "../browser/session-manager";

class MemorySessionStore implements BrowserSessionStore {
  sessions: Map<string, StoredBrowserSession>;
  onRelease?: (key: string) => void;
  #queues = new Map<string, Promise<void>>();

  constructor(sessions = new Map<string, StoredBrowserSession>()) {
    this.sessions = sessions;
  }

  async acquireLock(key: string): Promise<BrowserSessionLock> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    this.#queues.set(
      key,
      previous.then(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      )
    );
    await previous;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        release();
        this.onRelease?.(key);
      }
    };
  }

  get(key: string): StoredBrowserSession | undefined {
    return this.sessions.get(key);
  }

  set(key: string, session: StoredBrowserSession): void {
    this.sessions.set(key, session);
  }

  delete(key: string): void {
    this.sessions.delete(key);
  }
}

class FakeWebSocket {
  closeCount = 0;

  accept(): void {}

  addEventListener(): void {}

  send(): void {}

  close(): void {
    this.closeCount++;
  }
}

interface BrowserRequest {
  url: string;
  method: string;
  upgrade: boolean;
}

function responseWithSocket(
  sessionId: string,
  socket: FakeWebSocket
): Response {
  const response = new Response(null, {
    headers: { "cf-browser-session-id": sessionId }
  });
  Object.defineProperty(response, "webSocket", {
    value: socket
  });
  return response;
}

function createFakeBrowser(options?: {
  listStatuses?: number[];
  deleteStatuses?: number[];
}) {
  const requests: BrowserRequest[] = [];
  const sockets: FakeWebSocket[] = [];
  let created = 0;
  const listStatuses = [...(options?.listStatuses ?? [])];
  const deleteStatuses = [...(options?.deleteStatuses ?? [])];

  const browser = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const upgrade = headers.get("Upgrade") === "websocket";
      requests.push({ url, method, upgrade });

      if (upgrade) {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        const sessionId = url.includes("/session-")
          ? (url.match(/\/session-[^/?]+/)?.[0]?.slice(1) ?? "session-unknown")
          : "session-upgraded";
        return responseWithSocket(sessionId, socket);
      }

      if (method === "POST") {
        created++;
        return Response.json({ sessionId: `session-${created}` });
      }

      if (url.endsWith("/json/list")) {
        const status = listStatuses.shift();
        if (status) {
          return new Response(null, { status });
        }
        return Response.json([
          {
            id: "target-1",
            type: "page",
            url: "https://example.com/",
            title: "Example",
            devtoolsFrontendUrl: "https://live.example/target-1"
          },
          {
            id: "target-2",
            type: "page",
            url: "https://example.org/",
            title: "Relative DevTools",
            devtoolsFrontendUrl:
              "/devtools/inspector.html?ws=127.0.0.1:1234/devtools/page/target-2"
          }
        ]);
      }

      if (method === "DELETE") {
        return new Response(null, { status: deleteStatuses.shift() ?? 204 });
      }

      return new Response(null, { status: 204 });
    },
    connect: () => {
      throw new Error("connect is not implemented in this test Fetcher");
    }
  } satisfies Fetcher;

  return { browser, requests, sockets };
}

describe("createBrowserSessionManager", () => {
  it("rejects reusable sessions for cdpUrl", () => {
    const store = new MemorySessionStore();
    const options = {
      cdpUrl: "http://localhost:9222",
      session: { mode: "reuse", store }
    } as unknown as Parameters<typeof createBrowserSessionManager>[0];

    expect(() => createBrowserSessionManager(options)).toThrow(
      "Browser Rendering binding"
    );
  });

  it("creates, reports, and closes reusable sessions", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store, keepAliveMs: 120_000 }
    });

    const resetInfo = await manager.reset();
    expect(resetInfo?.sessionId).toBe("session-1");
    expect(store.sessions.get("default")?.sessionId).toBe("session-1");
    expect(requests[0].url).toContain("keep_alive=120000");
    expect(requests[0].url).toContain("targets=true");

    const info = await manager.info();
    expect(info).toEqual({
      sessionId: "session-1",
      targets: [
        {
          id: "target-1",
          type: "page",
          url: "https://example.com/",
          title: "Example",
          devtoolsFrontendUrl: "https://live.example/target-1"
        },
        {
          id: "target-2",
          type: "page",
          url: "https://example.org/",
          title: "Relative DevTools",
          devtoolsFrontendUrl:
            "/devtools/inspector.html?ws=127.0.0.1:1234/devtools/page/target-2"
        }
      ]
    });

    await manager.close();
    await manager.close();
    expect(store.sessions.has("default")).toBe(false);
    expect(
      requests.filter(
        (request) =>
          request.method === "DELETE" &&
          request.url === "https://localhost/v1/devtools/browser/session-1"
      )
    ).toHaveLength(1);
  });

  it("reconnects to a stored reusable session and releases without deleting", async () => {
    const { browser, requests, sockets } = createFakeBrowser();
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store }
    });

    const lease = await manager.acquire();
    expect(lease.session.sessionId).toBe("session-1");
    await lease.release();

    expect(sockets[0].closeCount).toBe(1);
    expect(
      requests.some(
        (request) =>
          request.method === "DELETE" && request.url.includes("session-1")
      )
    ).toBe(false);
  });

  it("reconnects to a stored reusable session through a fresh store facade", async () => {
    const { browser, requests, sockets } = createFakeBrowser();
    const sessions = new Map<string, StoredBrowserSession>();
    const firstStore = new MemorySessionStore(sessions);
    const firstManager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store: firstStore }
    });

    await firstManager.start();
    const requestCount = requests.length;
    const secondStore = new MemorySessionStore(sessions);
    const secondManager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store: secondStore }
    });

    const lease = await secondManager.acquire();
    expect(lease.session.sessionId).toBe("session-1");
    await lease.release();

    const secondAcquireRequests = requests.slice(requestCount);
    expect(sessions.get("default")?.sessionId).toBe("session-1");
    expect(
      secondAcquireRequests.filter((request) => request.method === "POST")
    ).toHaveLength(0);
    expect(
      secondAcquireRequests.some(
        (request) =>
          request.url.includes("session-1/json/list") && !request.upgrade
      )
    ).toBe(true);
    expect(sockets[0].closeCount).toBe(1);
  });

  it("preserves stored reusable sessions when target listing fails transiently", async () => {
    const { browser } = createFakeBrowser({ listStatuses: [500] });
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store }
    });

    await expect(manager.info()).rejects.toThrow(
      "Failed to list Browser Rendering targets"
    );

    expect(store.sessions.get("default")?.sessionId).toBe("session-1");
  });

  it("clears stored reusable sessions when target listing confirms they are gone", async () => {
    const { browser } = createFakeBrowser({ listStatuses: [404] });
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store }
    });

    await expect(manager.info()).resolves.toBeUndefined();

    expect(store.sessions.has("default")).toBe(false);
  });

  it("creates a fresh reusable session when acquire finds stale stored state", async () => {
    const { browser, requests, sockets } = createFakeBrowser({
      listStatuses: [404]
    });
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-stale",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store }
    });

    const lease = await manager.acquire();
    expect(lease.session.sessionId).toBe("session-1");
    await lease.release();

    expect(store.sessions.get("default")?.sessionId).toBe("session-1");
    expect(
      requests.some(
        (request) =>
          request.url.includes("session-stale/json/list") && !request.upgrade
      )
    ).toBe(true);
    expect(
      requests.some(
        (request) => request.url.includes("session-stale") && request.upgrade
      )
    ).toBe(false);
    expect(
      requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    expect(sockets[0].closeCount).toBe(1);
  });

  it("preserves stored reusable sessions when close deletion fails transiently", async () => {
    const { browser } = createFakeBrowser({ deleteStatuses: [500] });
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store }
    });

    await expect(manager.close()).rejects.toThrow(
      "Failed to delete Browser Rendering session"
    );

    expect(store.sessions.get("default")?.sessionId).toBe("session-1");
  });

  it("clears stored reusable sessions when close deletion confirms they are gone", async () => {
    const { browser } = createFakeBrowser({ deleteStatuses: [404] });
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store }
    });

    await manager.close();

    expect(store.sessions.has("default")).toBe(false);
  });

  it("holds the store lock for the full reusable browser lease", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const firstManager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store }
    });
    const secondManager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store }
    });

    const lease = await firstManager.acquire();
    const closePromise = secondManager.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      requests.some(
        (request) =>
          request.method === "DELETE" && request.url.includes("session-1")
      )
    ).toBe(false);

    await lease.release();
    await closePromise;
    expect(
      requests.filter(
        (request) =>
          request.method === "DELETE" && request.url.includes("session-1")
      )
    ).toHaveLength(1);
  });

  it("uses one-shot sessions until a dynamic session is started", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "dynamic", store, keepAliveMs: 120_000 }
    });

    const oneShotLease = await manager.acquire();
    expect(oneShotLease.session.sessionId).toBe("session-upgraded");
    await oneShotLease.release();
    expect(store.sessions.has("default")).toBe(false);

    const startInfo = await manager.start();
    expect(startInfo?.sessionId).toBe("session-1");
    expect(store.sessions.get("default")?.sessionId).toBe("session-1");

    const reusableLease = await manager.acquire();
    expect(reusableLease.session.sessionId).toBe("session-1");
    await reusableLease.release();

    expect(
      requests.some((request) => request.url.includes("keep_alive=120000"))
    ).toBe(true);
  });

  it("sweeps reusable sessions idle past keepAliveMs", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now() - 600_000,
      updatedAt: Date.now() - 600_000
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store, keepAliveMs: 120_000 }
    });

    const result = await manager.sweep();

    expect(result).toEqual({ swept: true, sessionId: "session-1" });
    expect(store.sessions.has("default")).toBe(false);
    expect(
      requests.filter(
        (request) =>
          request.method === "DELETE" && request.url.includes("session-1")
      )
    ).toHaveLength(1);
  });

  it("keeps reusable sessions still inside the idle window", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store, keepAliveMs: 120_000 }
    });

    const result = await manager.sweep();

    expect(result).toEqual({ swept: false });
    expect(store.sessions.get("default")?.sessionId).toBe("session-1");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("honors an explicit maxIdleMs override when sweeping", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now() - 5_000,
      updatedAt: Date.now() - 5_000
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store, keepAliveMs: 600_000 }
    });

    expect(await manager.sweep({ maxIdleMs: 60_000 })).toEqual({
      swept: false
    });
    expect(await manager.sweep({ maxIdleMs: 1_000 })).toEqual({
      swept: true,
      sessionId: "session-1"
    });
    expect(store.sessions.has("default")).toBe(false);
  });

  it("treats sweep as a no-op when no session is stored", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "reuse", store }
    });

    expect(await manager.sweep()).toEqual({ swept: false });
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("never sweeps one-shot sessions", async () => {
    const { browser } = createFakeBrowser();
    const manager = createBrowserSessionManager({ browser });

    expect(await manager.sweep()).toEqual({ swept: false });
  });

  it("sweeps the underlying reusable session in dynamic mode", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now() - 600_000,
      updatedAt: Date.now() - 600_000
    });
    const manager = createBrowserSessionManager({
      browser,
      session: { mode: "dynamic", store, keepAliveMs: 120_000 }
    });

    expect(await manager.sweep()).toEqual({
      swept: true,
      sessionId: "session-1"
    });
    expect(store.sessions.has("default")).toBe(false);
  });

  it("does not release the dynamic reusable lock before returning the lease", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    store.set("default", {
      sessionId: "session-1",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    let closePromise: Promise<void> | undefined;
    let manager: ReturnType<typeof createBrowserSessionManager> | undefined;
    store.onRelease = () => {
      if (!manager) throw new Error("manager was not initialized");
      closePromise ??= manager.close();
    };
    manager = createBrowserSessionManager({
      browser,
      session: { mode: "dynamic", store }
    });

    const lease = await manager.acquire();
    expect(lease.session.sessionId).toBe("session-1");
    expect(closePromise).toBeUndefined();

    await lease.release();
    await closePromise;
    expect(
      requests.filter((request) => request.method === "POST")
    ).toHaveLength(0);
    expect(store.sessions.has("default")).toBe(false);
  });
});
