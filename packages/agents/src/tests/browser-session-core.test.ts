import { describe, expect, it } from "vitest";
import {
  BROWSER_SESSION_KEEP_ALIVE_MAX_MS,
  DEFAULT_BROWSER_SESSION_NAME,
  NamedBrowserSessions,
  namedBrowserSessionKey,
  openOneShotBrowserSession
} from "../browser/session-core";
import type { OneShotBrowserSessionOptions } from "../browser/session-core";
import type {
  BrowserSessionLock,
  BrowserSessionStore,
  StoredBrowserSession
} from "../browser/session-manager";

class MemorySessionStore implements BrowserSessionStore {
  sessions = new Map<string, StoredBrowserSession>();
  /** Keys whose lock is currently held — locks must never span network calls. */
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

  async get(key: string) {
    return this.sessions.get(key);
  }
  async set(key: string, session: StoredBrowserSession) {
    this.sessions.set(key, session);
  }
  async delete(key: string) {
    this.sessions.delete(key);
  }
  async list(prefix: string) {
    const result = new Map<string, StoredBrowserSession>();
    for (const [key, session] of this.sessions) {
      if (key.startsWith(prefix)) result.set(key, session);
    }
    return result;
  }
}

/** A CDP WebSocket stub that acks accept/close — enough for connect tests. */
class FakeSocket {
  closeCount = 0;
  #listeners = new Map<string, Array<(event: unknown) => void>>();
  accept(): void {}
  send(_data: string): void {}
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }
  close(): void {
    this.closeCount++;
    this.emit("close");
  }
  /** Fire listeners without a caller-side close — peer closure / errors. */
  emit(type: string, event: unknown = {}): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(event);
  }
}

interface RecordedRequest {
  url: string;
  method: string;
  upgrade: boolean;
  body?: unknown;
}

function createFakeBrowser(options?: {
  /** Statuses to return (once each) from /json/list liveness probes. */
  listStatuses?: number[];
  /** Statuses to return (once each) from session DELETE calls. */
  deleteStatuses?: number[];
  /** Upgrade requests return a response with no WebSocket. */
  failUpgrades?: boolean;
  /** Statuses to return (once each, no WebSocket) from upgrade requests. */
  upgradeStatuses?: number[];
  /** Awaited before each session create responds — for race orchestration. */
  onCreate?: () => Promise<void> | void;
  /** Called on every fetch — for lock-discipline assertions. */
  onFetch?: () => void;
}) {
  const requests: RecordedRequest[] = [];
  const sockets: FakeSocket[] = [];
  let created = 0;
  const listStatuses = [...(options?.listStatuses ?? [])];
  const deleteStatuses = [...(options?.deleteStatuses ?? [])];
  const upgradeStatuses = [...(options?.upgradeStatuses ?? [])];

  const browser = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      options?.onFetch?.();
      const url = String(input);
      const method = init?.method ?? "GET";
      const upgrade = new Headers(init?.headers).get("Upgrade") === "websocket";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ url, method, upgrade, body });

      if (upgrade) {
        if (options?.failUpgrades) return new Response(null, { status: 502 });
        const upgradeStatus = upgradeStatuses.shift();
        if (upgradeStatus) return new Response(null, { status: upgradeStatus });
        const socket = new FakeSocket();
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
        await options?.onCreate?.();
        created++;
        return Response.json({ sessionId: `session-${created}` });
      }
      if (method === "DELETE") {
        const status = deleteStatuses.shift();
        return new Response(null, { status: status ?? 204 });
      }
      if (url.endsWith("/json/list")) {
        const status = listStatuses.shift();
        if (status) return new Response(null, { status });
        return Response.json([{ id: "target-1", type: "page" }]);
      }
      return new Response(null, { status: 204 });
    }
  };

  return { browser, requests, sockets };
}

function creates(requests: RecordedRequest[]) {
  return requests.filter((r) => r.method === "POST" && !r.upgrade);
}
function deletes(requests: RecordedRequest[], sessionId?: string) {
  return requests.filter(
    (r) => r.method === "DELETE" && (!sessionId || r.url.includes(sessionId))
  );
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(condition()).toBe(true);
}

describe("NamedBrowserSessions.resolve", () => {
  it("creates on first use, pins keep_alive to the platform max, restarted: false", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    const resolved = await sessions.resolve();

    expect(resolved.name).toBe(DEFAULT_BROWSER_SESSION_NAME);
    expect(resolved.sessionId).toBe("session-1");
    // First use: nothing existed before, so nothing was lost.
    expect(resolved.restarted).toBe(false);

    const [create] = creates(requests);
    expect(create.url).toContain(
      `keep_alive=${BROWSER_SESSION_KEEP_ALIVE_MAX_MS}`
    );

    // The record lives under the named keyspace; sessionId stays internal.
    const stored = store.sessions.get(namedBrowserSessionKey("default"));
    expect(stored?.sessionId).toBe("session-1");
  });

  it("reattaches to a live session without creating", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    const first = await sessions.resolve("checkout");
    const second = await sessions.resolve("checkout");

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.restarted).toBe(false);
    expect(creates(requests)).toHaveLength(1);
    // Reattach freshens the record so the host sees activity.
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it("recreates a dead session and reports restarted: true", async () => {
    // First probe of the stored session fails: expired upstream (410).
    const { browser, requests } = createFakeBrowser({ listStatuses: [410] });
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    const first = await sessions.resolve();
    const second = await sessions.resolve();

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.restarted).toBe(true);
    expect(creates(requests)).toHaveLength(2);
  });

  it("keeps sessions separate per name", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    const a = await sessions.resolve("research");
    const b = await sessions.resolve("checkout");

    expect(a.sessionId).not.toBe(b.sessionId);
    expect(creates(requests)).toHaveLength(2);
    expect(store.sessions.has(namedBrowserSessionKey("research"))).toBe(true);
    expect(store.sessions.has(namedBrowserSessionKey("checkout"))).toBe(true);
  });

  it("reapplies durable creation options on every create", async () => {
    // The stored session dies once, forcing a second create.
    const { browser, requests } = createFakeBrowser({ listStatuses: [404] });
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({
      browser,
      store,
      create: {
        keepAliveMs: 30_000,
        recording: true,
        guardrails: { allowedDomains: ["example.com", "*.example.com"] }
      }
    });

    await sessions.resolve();
    await sessions.resolve(); // dead — recreated

    const all = creates(requests);
    expect(all).toHaveLength(2);
    for (const create of all) {
      expect(create.url).toContain("keep_alive=30000");
      expect(create.url).toContain("recording=true");
      // Guardrails ride the POST body, per the Browser Run REST contract.
      expect(create.body).toEqual({
        guardrails: { allowedDomains: ["example.com", "*.example.com"] }
      });
    }
  });

  it("never holds the store lock across Browser Run calls", async () => {
    const store = new MemorySessionStore();
    const violations: string[] = [];
    const { browser } = createFakeBrowser({
      listStatuses: [410],
      onFetch: () => {
        if (store.heldKeys.size > 0) {
          violations.push([...store.heldKeys].join(","));
        }
      }
    });
    const sessions = new NamedBrowserSessions({ browser, store });

    await sessions.resolve();
    await sessions.resolve(); // probe + recreate path
    await sessions.close("default");

    expect(violations).toEqual([]);
  });

  it("reports restarted: true to every resolver racing a dead-session recovery", async () => {
    let releaseCreates!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCreates = resolve;
    });
    let createCalls = 0;
    const { browser, requests } = createFakeBrowser({
      listStatuses: [404],
      // Hold every replacement create open so both resolvers are mid-recovery
      // at once — the window where the restart evidence used to vanish.
      onCreate: () => {
        createCalls++;
        return createCalls > 1 ? gate : undefined;
      }
    });
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    await sessions.resolve("checkout"); // session-1, later found dead

    const a = sessions.resolve("checkout");
    await waitUntil(() => createCalls === 2); // A detected death, is creating
    const b = sessions.resolve("checkout");
    await waitUntil(() => createCalls === 3); // B joined the recovery
    releaseCreates();

    const [first, second] = await Promise.all([a, b]);
    expect(first.sessionId).toBe(second.sessionId); // first-commit-wins
    expect(deletes(requests)).toHaveLength(1); // the redundant browser died
    // Both resolvers lost the prior browser's state — both must say so.
    expect(first.restarted).toBe(true);
    expect(second.restarted).toBe(true);
  });

  it("reports restarted: true when the name is used and closed during its create", async () => {
    let releaseFirstCreate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    let createCalls = 0;
    const { browser } = createFakeBrowser({
      // Hold A's create open; later creates respond immediately.
      onCreate: () => {
        createCalls++;
        return createCalls === 1 ? gate : undefined;
      }
    });
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    // A finds the name unused and starts creating…
    const a = sessions.resolve("checkout");
    await waitUntil(() => createCalls === 1);
    // …while B uses the name and closes it, emptying the key again.
    const b = await sessions.resolve("checkout");
    expect(b.restarted).toBe(false);
    expect(await sessions.close("checkout")).toBe(true);
    releaseFirstCreate();

    // The name already lost B's browser, so A's commit is a restart.
    const resolved = await a;
    expect(resolved.sessionId).not.toBe(b.sessionId);
    expect(resolved.restarted).toBe(true);
  });
});

describe("NamedBrowserSessions.close", () => {
  it("retires the record and deletes the Browser Run session", async () => {
    const { browser, requests } = createFakeBrowser();
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    await sessions.resolve();
    const closed = await sessions.close("default");

    expect(closed).toBe(true);
    expect(deletes(requests, "session-1")).toHaveLength(1);
    expect(store.sessions.has(namedBrowserSessionKey("default"))).toBe(false);

    // The next resolve is the loud-mortality path.
    const resolved = await sessions.resolve();
    expect(resolved.restarted).toBe(true);
  });

  it("keeps restart evidence out of the named-session keyspace", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    await sessions.resolve("checkout");
    await sessions.close("checkout");

    // Listing named sessions yields only names that own a browser…
    expect(await store.list(namedBrowserSessionKey(""))).toEqual(new Map());
    // …yet the closed name still remembers it once had one.
    expect((await sessions.resolve("checkout")).restarted).toBe(true);
    // A never-used name is still first use.
    expect((await sessions.resolve("fresh")).restarted).toBe(false);
  });

  it("retires the record even when the platform delete fails — keep-alive reclaims it", async () => {
    const { browser, requests } = createFakeBrowser({ deleteStatuses: [500] });
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    await sessions.resolve();

    // The delete is best-effort: the retired record is the durable outcome,
    // and the pinned keep_alive reclaims the unreachable browser within 600s.
    expect(await sessions.close("default")).toBe(true);
    expect(store.sessions.has(namedBrowserSessionKey("default"))).toBe(false);
    expect(deletes(requests, "session-1")).toHaveLength(1);

    // Closing again is a no-op — the closure already happened.
    expect(await sessions.close("default")).toBe(false);
  });

  it("returns false when there is nothing to close", async () => {
    const { browser } = createFakeBrowser();
    const sessions = new NamedBrowserSessions({
      browser,
      store: new MemorySessionStore()
    });
    expect(await sessions.close("missing")).toBe(false);
  });
});

describe("NamedBrowserSessions.connect", () => {
  it("attaches a CDP socket to the resolved session by name", async () => {
    const { browser, requests, sockets } = createFakeBrowser();
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    const { cdp, sessionId, restarted } = await sessions.connect();

    expect(sessionId).toBe("session-1");
    expect(restarted).toBe(false);
    expect(requests.some((r) => r.upgrade)).toBe(true);
    expect(sockets).toHaveLength(1);

    // Closing the socket must NOT delete the named session — it outlives
    // connections by design.
    cdp.close();
    expect(deletes(requests, "session-1")).toHaveLength(0);
  });

  it("replaces a browser that expires between the probe and the upgrade", async () => {
    // The first upgrade finds the just-resolved browser gone (410).
    const { browser, requests } = createFakeBrowser({ upgradeStatuses: [410] });
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({ browser, store });

    const connected = await sessions.connect("checkout");

    expect(connected.restarted).toBe(true);
    expect(connected.sessionId).toBe("session-2");
    expect(
      store.sessions.get(namedBrowserSessionKey("checkout"))?.sessionId
    ).toBe("session-2");
    expect(creates(requests)).toHaveLength(2);
  });

  it("does not retry upgrade failures other than 404/410", async () => {
    const { browser } = createFakeBrowser({ upgradeStatuses: [502] });
    const sessions = new NamedBrowserSessions({
      browser,
      store: new MemorySessionStore()
    });

    await expect(sessions.connect()).rejects.toThrow(/\(502\)/);
  });

  it("CDP activity refreshes the record's updatedAt", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({
      browser,
      store,
      touchIntervalMs: 0
    });
    const { cdp } = await sessions.connect("work");

    // Pretend the last resolve happened ages ago — from here on, only CDP
    // traffic proves the browser is in use.
    const key = namedBrowserSessionKey("work");
    const stale = {
      ...store.sessions.get(key)!,
      updatedAt: Date.now() - BROWSER_SESSION_KEEP_ALIVE_MAX_MS * 2
    };
    store.sessions.set(key, stale);

    cdp
      .send("Page.navigate", { url: "https://example.com" }, { timeoutMs: 50 })
      .catch(() => {});
    await waitUntil(
      () => store.sessions.get(key)!.updatedAt !== stale.updatedAt
    );
  });

  it("throttles activity touches to the configured interval", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    // Default 60s interval: a send right after connect must not write.
    const sessions = new NamedBrowserSessions({ browser, store });
    const { cdp } = await sessions.connect("work");

    const key = namedBrowserSessionKey("work");
    const before = store.sessions.get(key)!;

    cdp.send("Page.navigate", {}, { timeoutMs: 50 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.sessions.get(key)).toEqual(before);
  });

  it("derives the touch interval from a short keep-alive window", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    // Short keep-alive, default 60s touch interval: the touch cadence must
    // tighten itself, or a busy browser's record could look older than the
    // window the platform reclaims idle browsers after.
    const sessions = new NamedBrowserSessions({
      browser,
      store,
      create: { keepAliveMs: 200 }
    });
    const { cdp } = await sessions.connect("work");

    const key = namedBrowserSessionKey("work");
    const stale = {
      ...store.sessions.get(key)!,
      updatedAt: Date.now() - 150
    };
    store.sessions.set(key, stale);

    // Past the derived interval (keepAliveMs / 2 = 100ms) but well inside
    // the 60s default: this send must refresh the record.
    await new Promise((resolve) => setTimeout(resolve, 120));
    cdp.send("Page.navigate", {}, { timeoutMs: 50 }).catch(() => {});
    await waitUntil(
      () => store.sessions.get(key)!.updatedAt !== stale.updatedAt
    );
  });

  it("a late activity touch cannot resurrect a closed session", async () => {
    const { browser } = createFakeBrowser();
    const store = new MemorySessionStore();
    const sessions = new NamedBrowserSessions({
      browser,
      store,
      touchIntervalMs: 0
    });
    const { cdp } = await sessions.connect("work");

    await sessions.close("work");
    const key = namedBrowserSessionKey("work");
    expect(store.sessions.has(key)).toBe(false);

    cdp.send("Page.navigate", {}, { timeoutMs: 50 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.sessions.has(key)).toBe(false);
  });
});

describe("openOneShotBrowserSession", () => {
  it("creates, connects, and deletes on close — no store involved", async () => {
    const { browser, requests, sockets } = createFakeBrowser();

    const cdp = await openOneShotBrowserSession(browser, {
      guardrails: { allowedDomains: ["example.com"] }
    });

    const [create] = creates(requests);
    expect(create.body).toEqual({
      guardrails: { allowedDomains: ["example.com"] }
    });
    expect(requests.some((r) => r.upgrade)).toBe(true);
    expect(deletes(requests)).toHaveLength(0);

    cdp.close();
    // One-shot means create-and-close: the platform session dies with it.
    await Promise.resolve(); // let the fire-and-forget delete run
    expect(deletes(requests, "session-1")).toHaveLength(1);
    expect(sockets[0].closeCount).toBeGreaterThan(0);
  });

  it("deletes the session when the peer closes the socket", async () => {
    const { browser, requests, sockets } = createFakeBrowser();

    await openOneShotBrowserSession(browser);
    expect(deletes(requests)).toHaveLength(0);

    // The platform hung up — no caller-side close() ever runs. Cleanup
    // must still fire on the terminal socket event.
    sockets[0].emit("close");
    await waitUntil(() => deletes(requests, "session-1").length === 1);
  });

  it("runs delete-on-close exactly once across close() and socket teardown", async () => {
    const { browser, requests, sockets } = createFakeBrowser();

    const cdp = await openOneShotBrowserSession(browser);
    cdp.close(); // FakeSocket.close() also fires the socket's close event
    sockets[0].emit("close"); // and a straggler event must not re-fire it

    await waitUntil(() => deletes(requests, "session-1").length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deletes(requests, "session-1")).toHaveLength(1);
  });

  it("deletes the created session when attachment fails — no leak", async () => {
    const { browser, requests } = createFakeBrowser({ failUpgrades: true });

    await expect(openOneShotBrowserSession(browser)).rejects.toThrow(
      /WebSocket/
    );

    // The allocated session never got its delete-on-close owner — it must
    // be reclaimed on the failure path, not left to expire.
    expect(creates(requests)).toHaveLength(1);
    expect(deletes(requests, "session-1")).toHaveLength(1);
  });

  it("rejects Chromium-only options smuggled onto kitesurf", async () => {
    const { browser, requests } = createFakeBrowser();

    // The options union forbids these at the type level — the casts simulate
    // plain-JS callers smuggling Chromium-only options past the compiler.
    for (const smuggled of [
      { guardrails: { allowedDomains: ["example.com"] } },
      { keepAliveMs: 30_000 },
      { recording: true }
    ]) {
      await expect(
        openOneShotBrowserSession(browser, {
          browser: "kitesurf",
          ...smuggled
        } as OneShotBrowserSessionOptions)
      ).rejects.toThrow(
        "Kitesurf does not support guardrails, keepAliveMs, or recording"
      );
    }

    // Rejected before any platform work — nothing was created.
    expect(creates(requests)).toHaveLength(0);
  });
});
