import { describe, expect, it } from "vitest";
import { BrowserConnector } from "../browser/connector";
import { getBrowserRecording } from "../browser/browser-run";
import type {
  BrowserSessionLock,
  BrowserSessionStore,
  StoredBrowserSession
} from "../browser/session-manager";

class MemorySessionStore implements BrowserSessionStore {
  sessions = new Map<string, StoredBrowserSession>();
  /** Keys whose lock is currently held — for asserting locks never span network calls. */
  heldKeys = new Set<string>();
  #queues = new Map<string, Promise<void>>();

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
    this.heldKeys.add(key);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.heldKeys.delete(key);
        release();
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

  list(prefix: string): Map<string, StoredBrowserSession> {
    const result = new Map<string, StoredBrowserSession>();
    for (const [key, value] of this.sessions) {
      if (key.startsWith(prefix)) result.set(key, value);
    }
    return result;
  }
}

/** A CDP WebSocket that echoes a result for every command. */
class FakeCdpSocket {
  closeCount = 0;
  sent: Array<Record<string, unknown>> = [];
  #listeners = new Map<string, Array<(event: unknown) => void>>();
  #errorMethods: Set<string>;

  constructor(errorMethods: Set<string> = new Set()) {
    this.#errorMethods = errorMethods;
  }

  accept(): void {}

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }

  static nextCdpSession = 0;

  send(data: string): void {
    const message = JSON.parse(data) as { id: number; method: string };
    this.sent.push(message);
    queueMicrotask(() => {
      if (this.#errorMethods.has(message.method)) {
        this.#emit("message", {
          data: JSON.stringify({
            id: message.id,
            error: {
              code: -32601,
              message: `'${message.method}' wasn't found`
            }
          })
        });
        return;
      }
      const result =
        message.method === "Target.attachToTarget"
          ? { sessionId: `cdp-session-${++FakeCdpSocket.nextCdpSession}` }
          : { echo: message.method };
      this.#emit("message", {
        data: JSON.stringify({ id: message.id, result })
      });
    });
  }

  close(): void {
    this.closeCount++;
    this.#emit("close", {});
  }

  #emit(type: string, event: unknown): void {
    for (const fn of this.#listeners.get(type) ?? []) {
      fn(event);
    }
  }
}

interface BrowserRequest {
  url: string;
  method: string;
  upgrade: boolean;
}

function createFakeBrowser(options?: {
  listStatuses?: number[];
  cdpErrors?: Set<string>;
  /** Include a `devtoolsFrontendUrl` (the Live View link) on listed targets. */
  liveTargets?: boolean;
}) {
  const requests: BrowserRequest[] = [];
  const sockets: FakeCdpSocket[] = [];
  let created = 0;
  const listStatuses = [...(options?.listStatuses ?? [])];

  const browser = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const upgrade = headers.get("Upgrade") === "websocket";
      requests.push({ url, method, upgrade });

      if (upgrade) {
        const socket = new FakeCdpSocket(options?.cdpErrors);
        sockets.push(socket);
        const sessionId =
          url.match(/\/browser\/(session-[^/?]+)/)?.[1] ?? "session-upgraded";
        const response = new Response(null, {
          headers: { "cf-browser-session-id": sessionId }
        });
        Object.defineProperty(response, "webSocket", { value: socket });
        return response;
      }

      if (method === "POST") {
        created++;
        return Response.json({ sessionId: `session-${created}` });
      }

      if (url.endsWith("/json/protocol")) {
        return Response.json({
          domains: [
            {
              domain: "Page",
              commands: [{ name: "navigate" }, { name: "enable" }],
              events: [{ name: "loadEventFired" }]
            }
          ]
        });
      }

      if (url.endsWith("/json/list")) {
        const status = listStatuses.shift();
        if (status) return new Response(null, { status });
        const sessionId =
          url.match(/\/browser\/(session-[^/?]+)/)?.[1] ?? "session";
        return Response.json([
          {
            id: "target-1",
            type: "page",
            ...(options?.liveTargets
              ? {
                  url: "https://example.com/",
                  devtoolsFrontendUrl: `https://live.browser.run/ui/inspector?wss=live.browser.run/api/devtools/browser/${sessionId}/page/target-1?jwt=token`
                }
              : {})
          }
        ]);
      }

      if (method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      return new Response(null, { status: 204 });
    },
    connect: () => {
      throw new Error("connect is not implemented in this test Fetcher");
    }
  } satisfies Fetcher;

  return { browser, requests, sockets };
}

const fakeCtx = {} as ExecutionContext;

function deletesFor(requests: BrowserRequest[], sessionId: string) {
  return requests.filter(
    (request) => request.method === "DELETE" && request.url.includes(sessionId)
  );
}

describe("BrowserConnector", () => {
  it("is named cdp and validates its options", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });
    expect(connector.name()).toBe("cdp");

    expect(
      () =>
        new BrowserConnector(fakeCtx, { browser } as unknown as {
          browser: Fetcher;
          store: BrowserSessionStore;
        })
    ).toThrow("store");
    expect(
      () => new BrowserConnector(fakeCtx, {} as unknown as { cdpUrl: string })
    ).toThrow("'browser'");
  });

  it("marks reads as reexecute and exposes session tools only for reuse/dynamic", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();

    const oneShot = new BrowserConnector(fakeCtx, { browser, store });
    const oneShotDesc = await oneShot.describe();
    expect(Object.keys(oneShotDesc.descriptors).sort()).toEqual([
      "attachToTarget",
      "clearDebugLog",
      "getDebugLog",
      "getLiveViewUrl",
      "send",
      "spec"
    ]);
    expect(oneShotDesc.annotations?.spec).toEqual({ replay: "reexecute" });
    expect(oneShotDesc.annotations?.getDebugLog).toEqual({
      replay: "reexecute"
    });
    expect(oneShotDesc.annotations?.getLiveViewUrl).toEqual({
      replay: "reexecute"
    });
    expect(oneShotDesc.annotations?.send).toBeUndefined();
    expect(oneShotDesc.instructions).toContain("sequentially");

    const dynamic = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { mode: "dynamic" }
    });
    const dynamicDesc = await dynamic.describe();
    expect(Object.keys(dynamicDesc.descriptors)).toEqual(
      expect.arrayContaining([
        "startSession",
        "sessionInfo",
        "closeSession",
        "resetSession"
      ])
    );
    expect(dynamicDesc.annotations?.sessionInfo).toEqual({
      replay: "reexecute"
    });
  });

  it("requires an execution context for session-bound tools", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await expect(
      connector.executeTool("send", { method: "Browser.getVersion" })
    ).rejects.toThrow("execution context");
  });

  it("creates one session per execution and stores it under cdp:exec:<id>", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    const first = await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    expect(first).toEqual({ echo: "Browser.getVersion" });
    expect(store.sessions.get("cdp:exec:exec-a")?.sessionId).toBe("session-1");

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-b" }
    );
    expect(store.sessions.get("cdp:exec:exec-b")?.sessionId).toBe("session-2");
    expect(
      requests.filter((request) => request.method === "POST")
    ).toHaveLength(2);

    // A second send on the same execution reuses the cached socket.
    const upgradesBefore = requests.filter((r) => r.upgrade).length;
    await connector.executeTool(
      "send",
      { method: "Target.getTargets" },
      { executionId: "exec-a" }
    );
    expect(requests.filter((r) => r.upgrade)).toHaveLength(upgradesBefore);
  });

  it("disconnects sockets on pass end but keeps the session for resume", async () => {
    const { browser, requests, sockets } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    await connector.onPassEnd("exec-a", "paused");
    expect(sockets[0].closeCount).toBe(1);
    expect(store.sessions.get("cdp:exec:exec-a")?.sessionId).toBe("session-1");
    expect(deletesFor(requests, "session-1")).toHaveLength(0);

    // Resume pass: reconnects to the same stored session, no new POST.
    await connector.executeTool(
      "send",
      { method: "Target.getTargets" },
      { executionId: "exec-a" }
    );
    expect(
      requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    expect(
      requests.some(
        (request) => request.upgrade && request.url.includes("session-1")
      )
    ).toBe(true);
  });

  it("returns a stable attach handle and re-attaches after a reconnect", async () => {
    const { browser, sockets } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    const { sessionId: handle } = (await connector.executeTool(
      "attachToTarget",
      { targetId: "target-1" },
      { executionId: "exec-a" }
    )) as { sessionId: string };
    expect(handle).toBe("target:target-1");

    await connector.executeTool(
      "send",
      { method: "Page.enable", sessionId: handle },
      { executionId: "exec-a" }
    );
    const firstSocket = sockets[0];
    expect(
      firstSocket.sent.some((m) => m.method === "Target.attachToTarget")
    ).toBe(true);
    const pageEnable = firstSocket.sent.find(
      (m) => m.method === "Page.enable"
    ) as { sessionId?: string };
    expect(pageEnable.sessionId).toMatch(/^cdp-session-/);

    // Pass ends — socket dropped. The handle must keep working on the next
    // pass by re-attaching on the fresh socket.
    await connector.onPassEnd("exec-a", "paused");
    await connector.executeTool(
      "send",
      { method: "Runtime.evaluate", sessionId: handle },
      { executionId: "exec-a" }
    );
    const secondSocket = sockets[1];
    expect(
      secondSocket.sent.some((m) => m.method === "Target.attachToTarget")
    ).toBe(true);
    const evaluate = secondSocket.sent.find(
      (m) => m.method === "Runtime.evaluate"
    ) as { sessionId?: string };
    expect(evaluate.sessionId).toMatch(/^cdp-session-/);
    expect(evaluate.sessionId).not.toBe(pageEnable.sessionId);

    // Raw CDP session ids pass through untouched.
    await connector.executeTool(
      "send",
      { method: "DOM.enable", sessionId: "raw-cdp-id" },
      { executionId: "exec-a" }
    );
    const dom = secondSocket.sent.find((m) => m.method === "DOM.enable") as {
      sessionId?: string;
    };
    expect(dom.sessionId).toBe("raw-cdp-id");
  });

  it("never holds the session-store lock across Browser Rendering calls", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    const lockedDuringFetch: string[] = [];
    const wrapped = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        lockedDuringFetch.push(...store.heldKeys);
        return browser.fetch(input, init);
      },
      connect: browser.connect
    } satisfies Fetcher;

    const connector = new BrowserConnector(fakeCtx, {
      browser: wrapped,
      store,
      session: { mode: "reuse", key: "main" }
    });

    // Create path (no stored session yet), then validate path (existing
    // session probed for liveness), then terminal disposal.
    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    await connector.onPassEnd("exec-a", "paused");
    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    await connector.disposeExecution("exec-a", "completed");

    expect(lockedDuringFetch).toEqual([]);
  });

  it("deletes the redundant session when concurrent creates race for one key", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const sharedOptions = {
      browser,
      store,
      session: { mode: "reuse", key: "main" } as const
    };
    // Two connectors sharing one store race to create the shared session.
    const c1 = new BrowserConnector(fakeCtx, sharedOptions);
    const c2 = new BrowserConnector(fakeCtx, sharedOptions);

    await Promise.all([
      c1.executeTool(
        "send",
        { method: "Browser.getVersion" },
        { executionId: "exec-a" }
      ),
      c2.executeTool(
        "send",
        { method: "Browser.getVersion" },
        { executionId: "exec-b" }
      )
    ]);

    // Both created a session, one commit won, the loser's was deleted.
    const creates = requests.filter((r) => r.method === "POST" && !r.upgrade);
    const deletes = requests.filter((r) => r.method === "DELETE");
    expect(creates.length).toBe(2);
    expect(deletes.length).toBe(1);
    expect(store.sessions.size).toBe(1);
    const winner = [...store.sessions.values()][0];
    expect(deletes[0].url).not.toContain(winner.sessionId);
  });

  it("explains the attachToTarget fix when a page-scoped send lacks a sessionId", async () => {
    const { browser } = createFakeBrowser({
      cdpErrors: new Set(["Page.enable"])
    });
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await expect(
      connector.executeTool(
        "send",
        { method: "Page.enable" },
        { executionId: "exec-a" }
      )
    ).rejects.toThrow(
      "Page-scoped commands need a sessionId: const { sessionId } = await cdp.attachToTarget({ targetId })"
    );
  });

  it("explains that CDP events cannot be sent as commands", async () => {
    const { browser } = createFakeBrowser({
      cdpErrors: new Set(["Page.loadEventFired"])
    });
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await expect(
      connector.executeTool(
        "send",
        { method: "Page.loadEventFired", sessionId: "raw-cdp-id" },
        { executionId: "exec-a" }
      )
    ).rejects.toThrow("is a CDP *event*, not a command");
  });

  it("fails with a clear error when the session expired across a pause", async () => {
    const { browser } = createFakeBrowser({ listStatuses: [404] });
    const store = new MemorySessionStore();
    store.set("cdp:exec:exec-a", {
      sessionId: "session-gone",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await expect(
      connector.executeTool(
        "send",
        { method: "Browser.getVersion" },
        { executionId: "exec-a" }
      )
    ).rejects.toThrow("expired or was swept while this execution was paused");
    expect(store.sessions.has("cdp:exec:exec-a")).toBe(false);
  });

  it("disposes one-shot sessions exactly once (idempotent)", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    await connector.disposeExecution("exec-a", "completed");
    await connector.disposeExecution("exec-a", "completed");

    expect(store.sessions.has("cdp:exec:exec-a")).toBe(false);
    expect(deletesFor(requests, "session-1")).toHaveLength(1);
  });

  it("promotes a dynamic session via startSession so dispose keeps it", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { mode: "dynamic" }
    });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    const info = (await connector.executeTool(
      "startSession",
      {},
      { executionId: "exec-a" }
    )) as { sessionId: string };
    expect(info.sessionId).toBe("session-1");
    expect(store.sessions.get("cdp:reuse:default")?.sessionId).toBe(
      "session-1"
    );

    await connector.disposeExecution("exec-a", "completed");
    expect(store.sessions.has("cdp:exec:exec-a")).toBe(false);
    expect(store.sessions.get("cdp:reuse:default")?.sessionId).toBe(
      "session-1"
    );
    expect(deletesFor(requests, "session-1")).toHaveLength(0);

    // A later execution reuses the promoted session — no new POST.
    await connector.executeTool(
      "send",
      { method: "Target.getTargets" },
      { executionId: "exec-b" }
    );
    expect(
      requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);
    // exec-b has no per-execution entry: it rides the shared session.
    expect(store.sessions.has("cdp:exec:exec-b")).toBe(false);
    await connector.disposeExecution("exec-b", "completed");
    expect(deletesFor(requests, "session-1")).toHaveLength(0);
  });

  it("disposes un-promoted dynamic sessions on terminal", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { mode: "dynamic" }
    });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    await connector.disposeExecution("exec-a", "error");

    expect(store.sessions.has("cdp:exec:exec-a")).toBe(false);
    expect(deletesFor(requests, "session-1")).toHaveLength(1);
  });

  it("shares one stored session across executions in reuse mode", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { mode: "reuse", key: "team" }
    });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-b" }
    );

    expect(store.sessions.get("cdp:reuse:team")?.sessionId).toBe("session-1");
    expect(
      requests.filter((request) => request.method === "POST")
    ).toHaveLength(1);

    await connector.disposeExecution("exec-a", "completed");
    await connector.disposeExecution("exec-b", "completed");
    expect(store.sessions.get("cdp:reuse:team")?.sessionId).toBe("session-1");
    expect(deletesFor(requests, "session-1")).toHaveLength(0);
  });

  it("sweeps stale reuse and exec entries, keeping fresh ones", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    store.set("cdp:reuse:default", {
      sessionId: "session-shared",
      createdAt: now - 3_600_000,
      updatedAt: now - 3_600_000
    });
    // Exec entries use the much longer 24h default — an hour-old paused run
    // must NOT be swept, only one idle past the paused TTL.
    store.set("cdp:exec:exec-stale", {
      sessionId: "session-stale",
      createdAt: now - dayMs - 3_600_000,
      updatedAt: now - dayMs - 3_600_000
    });
    store.set("cdp:exec:exec-paused", {
      sessionId: "session-paused",
      createdAt: now - 3_600_000,
      updatedAt: now - 3_600_000
    });
    const connector = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { mode: "dynamic", keepAliveMs: 120_000 }
    });

    const result = await connector.sweep();
    const sweptKeys = result.swept.map((entry) => entry.key).sort();
    expect(sweptKeys).toEqual(["cdp:exec:exec-stale", "cdp:reuse:default"]);
    expect(store.sessions.has("cdp:exec:exec-paused")).toBe(true);
    expect(deletesFor(requests, "session-shared")).toHaveLength(1);
    expect(deletesFor(requests, "session-stale")).toHaveLength(1);
    expect(deletesFor(requests, "session-paused")).toHaveLength(0);

    // The swept exec entry stays behind as a tombstone (so a resume fails
    // loudly) and is not re-swept.
    expect(store.sessions.get("cdp:exec:exec-stale")?.closedAt).toBeDefined();
    expect((await connector.sweep()).swept).toEqual([]);

    // An aged tombstone is eventually deleted without another session DELETE.
    store.set("cdp:exec:exec-stale", {
      ...store.sessions.get("cdp:exec:exec-stale")!,
      closedAt: now - dayMs - 1
    });
    expect((await connector.sweep()).swept).toEqual([]);
    expect(store.sessions.has("cdp:exec:exec-stale")).toBe(false);
    expect(deletesFor(requests, "session-stale")).toHaveLength(1);
  });

  it("fails loudly when resuming an execution whose session was swept", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    await connector.onPassEnd("exec-a", "paused");

    // Age the entry past the exec threshold, then sweep.
    const stored = store.sessions.get("cdp:exec:exec-a")!;
    store.set("cdp:exec:exec-a", {
      ...stored,
      updatedAt: Date.now() - 25 * 60 * 60 * 1000
    });
    const result = await connector.sweep();
    expect(result.swept.map((entry) => entry.key)).toEqual(["cdp:exec:exec-a"]);

    // The resume does NOT silently get a fresh browser — it fails clearly.
    await expect(
      connector.executeTool(
        "send",
        { method: "Target.getTargets" },
        { executionId: "exec-a" }
      )
    ).rejects.toThrow("expired or was swept");
    expect(store.sessions.has("cdp:exec:exec-a")).toBe(false);
  });

  it("touches the exec entry on use so active runs stay out of sweep range", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    // Simulate a long-running execution whose entry has gone stale.
    const stored = store.sessions.get("cdp:exec:exec-a")!;
    store.set("cdp:exec:exec-a", {
      ...stored,
      updatedAt: Date.now() - 2 * 60 * 60 * 1000
    });

    await connector.executeTool(
      "send",
      { method: "Target.getTargets" },
      { executionId: "exec-a" }
    );
    const touched = store.sessions.get("cdp:exec:exec-a")!;
    expect(Date.now() - touched.updatedAt).toBeLessThan(60_000);
  });

  it("dedupes concurrent socket connects for the same execution", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await Promise.all([
      connector.executeTool(
        "send",
        { method: "Browser.getVersion" },
        { executionId: "exec-a" }
      ),
      connector.executeTool(
        "send",
        { method: "Target.getTargets" },
        { executionId: "exec-a" }
      )
    ]);

    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(requests.filter((r) => r.upgrade)).toHaveLength(1);
  });

  it("reports and closes the shared session via host-side helpers", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { mode: "reuse" }
    });

    expect(await connector.sessionInfo()).toBeUndefined();

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );
    const info = await connector.sessionInfo();
    expect(info?.sessionId).toBe("session-1");
    expect(info?.targets).toEqual([{ id: "target-1", type: "page" }]);

    await connector.closeSession();
    expect(store.sessions.has("cdp:reuse:default")).toBe(false);
    expect(deletesFor(requests, "session-1")).toHaveLength(1);
  });

  it("builds a Live View URL for the current execution's tab", async () => {
    const { browser } = createFakeBrowser({ liveTargets: true });
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    const result = (await connector.executeTool(
      "getLiveViewUrl",
      {},
      { executionId: "exec-a" }
    )) as { url: string; targetId: string; expiresInMs: number };

    expect(result.targetId).toBe("target-1");
    expect(result.url).toContain("live.browser.run");
    expect(result.url).toContain("session-1");
    expect(result.expiresInMs).toBeGreaterThan(0);
  });

  it("rewrites the Live View mode query param when asked", async () => {
    const { browser } = createFakeBrowser({ liveTargets: true });
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    const result = (await connector.executeTool(
      "getLiveViewUrl",
      { mode: "devtools" },
      { executionId: "exec-a" }
    )) as { url: string };

    expect(new URL(result.url).searchParams.get("mode")).toBe("devtools");
  });

  it("errors clearly when the requested Live View target is missing", async () => {
    const { browser } = createFakeBrowser({ liveTargets: true });
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, { browser, store });

    await expect(
      connector.executeTool(
        "getLiveViewUrl",
        { targetId: "nope" },
        { executionId: "exec-a" }
      )
    ).rejects.toThrow("No target nope found");
  });

  it("exposes shared-session Live View URLs via the host helper", async () => {
    const { browser } = createFakeBrowser({ liveTargets: true });
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { mode: "reuse" }
    });

    expect(await connector.liveView()).toBeUndefined();

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );

    const view = await connector.liveView({ mode: "tab" });
    expect(view?.sessionId).toBe("session-1");
    expect(view?.targets).toHaveLength(1);
    expect(view?.targets[0].targetId).toBe("target-1");
    expect(view?.targets[0].pageUrl).toBe("https://example.com/");
    expect(new URL(view!.targets[0].url).searchParams.get("mode")).toBe("tab");
  });

  it("enables session recording on the create request when opted in", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { mode: "reuse", recording: true }
    });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );

    const create = requests.find((request) => request.method === "POST");
    expect(create).toBeDefined();
    expect(new URL(create!.url).searchParams.get("recording")).toBe("true");
  });

  it("enables session recording on one-shot (default mode) creates too", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { recording: true }
    });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );

    const create = requests.find((request) => request.method === "POST");
    expect(create).toBeDefined();
    expect(new URL(create!.url).searchParams.get("recording")).toBe("true");
  });

  it("omits the recording param when not opted in", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const connector = new BrowserConnector(fakeCtx, {
      browser,
      store,
      session: { mode: "reuse" }
    });

    await connector.executeTool(
      "send",
      { method: "Browser.getVersion" },
      { executionId: "exec-a" }
    );

    const create = requests.find((request) => request.method === "POST");
    expect(create).toBeDefined();
    expect(new URL(create!.url).searchParams.has("recording")).toBe(false);
  });
});

describe("getBrowserRecording", () => {
  it("fetches the recording from the REST API with bearer auth", async () => {
    let seenUrl = "";
    let seenAuth: string | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get("Authorization");
      return Response.json({
        sessionId: "sess-1",
        duration: 4380,
        events: { "target-1": [{ type: 4 }], "target-2": [] }
      });
    }) as typeof fetch;

    const recording = await getBrowserRecording({
      accountId: "acct-123",
      apiToken: "tok-abc",
      sessionId: "sess-1",
      fetchImpl
    });

    expect(seenUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/browser-rendering/recording/sess-1"
    );
    expect(seenAuth).toBe("Bearer tok-abc");
    expect(recording.duration).toBe(4380);
    expect(Object.keys(recording.events)).toEqual(["target-1", "target-2"]);
  });

  it("unwraps a v4 result envelope when present", async () => {
    const fetchImpl = (async () =>
      Response.json({
        success: true,
        result: { sessionId: "sess-2", duration: 10, events: {} }
      })) as typeof fetch;

    const recording = await getBrowserRecording({
      accountId: "a",
      apiToken: "t",
      sessionId: "sess-2",
      fetchImpl
    });

    expect(recording.sessionId).toBe("sess-2");
    expect(recording.duration).toBe(10);
  });

  it("throws a BrowserRenderingError on a non-ok response", async () => {
    const fetchImpl = (async () =>
      new Response("not found", { status: 404 })) as typeof fetch;

    await expect(
      getBrowserRecording({
        accountId: "a",
        apiToken: "t",
        sessionId: "missing",
        fetchImpl
      })
    ).rejects.toThrow(/404/);
  });
});
