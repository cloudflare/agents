import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestBrowserAgent } from "./agents/browser";
import {
  type BrowserHarnessObject,
  createFakeBrowserBinding
} from "./capabilities/browser";
import { withCapabilityHarness } from "./shared/capability-harness";
import { BrowserSessions } from "../browser/capability";
import {
  BROWSER_SESSION_KEEP_ALIVE_MAX_MS,
  namedBrowserSessionKey
} from "../browser/session-core";
import type {
  BrowserSessionStore,
  StoredBrowserSession
} from "../browser/session-manager";

/** The Durable Object storage key the auto-supplied store writes `name` to. */
function durableKey(name: string): string {
  return `browser-session:${namedBrowserSessionKey(name)}`;
}

/** A minimal custom store — enough to prove the capability honors one. */
function createMemoryStore(): BrowserSessionStore & {
  sessions: Map<string, StoredBrowserSession>;
} {
  const sessions = new Map<string, StoredBrowserSession>();
  return {
    sessions,
    async acquireLock() {
      return { release: () => {} };
    },
    async get(key) {
      return sessions.get(key);
    },
    async set(key, session) {
      sessions.set(key, session);
    },
    async delete(key) {
      sessions.delete(key);
    },
    async list(prefix) {
      const result = new Map<string, StoredBrowserSession>();
      for (const [key, session] of sessions) {
        if (key.startsWith(prefix)) result.set(key, session);
      }
      return result;
    }
  };
}

/** Rewrite the stored entry for `name` with backdated timestamps. */
async function backdateStoredSession(
  storage: DurableObjectStorage,
  name: string,
  patch: Partial<StoredBrowserSession>
): Promise<void> {
  const stored = await storage.get<StoredBrowserSession>(durableKey(name));
  if (!stored) throw new Error(`no stored session named ${name}`);
  await storage.put(durableKey(name), { ...stored, ...patch });
}

describe("BrowserSessions capability", () => {
  it("auto-supplies a Durable Object store over the host's storage", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const { capability } = install(new BrowserSessions({ browser }));

      const resolved = await capability.resolve();
      expect(resolved.name).toBe("default");
      expect(resolved.restarted).toBe(false);

      const stored = await storage.get<StoredBrowserSession>(
        durableKey("default")
      );
      expect(stored?.sessionId).toBe(resolved.sessionId);
    });
  });

  it("honors a custom store instead of the auto-supplied one", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const store = createMemoryStore();
      const { capability } = install(new BrowserSessions({ browser, store }));

      const resolved = await capability.resolve("scraper");
      expect(store.sessions.get(namedBrowserSessionKey("scraper"))).toEqual(
        expect.objectContaining({ sessionId: resolved.sessionId })
      );
      expect(await storage.get(durableKey("scraper"))).toBeUndefined();
    });
  });

  it("reapplies durable creation options on every create", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const binding = createFakeBrowserBinding();
      const { capability } = install(
        new BrowserSessions({
          browser: binding.browser,
          create: {
            recording: true,
            guardrails: { allowedDomains: ["example.com", "*.example.com"] }
          }
        })
      );

      const first = await capability.resolve();
      binding.kill(first.sessionId);
      const second = await capability.resolve();
      expect(second.restarted).toBe(true);

      const acquires = binding.requests.filter(
        (request) => request.method === "POST" && !request.upgrade
      );
      expect(acquires).toHaveLength(2);
      for (const acquire of acquires) {
        expect(acquire.url).toContain("recording=true");
        expect(acquire.body).toEqual({
          guardrails: { allowedDomains: ["example.com", "*.example.com"] }
        });
      }
    });
  });

  it("lists named sessions with live/expired status and host-only ids", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const { capability } = install(new BrowserSessions({ browser }));

      await capability.resolve("checkout");
      await capability.resolve("idle");
      await capability.resolve("scraper");
      await capability.close("scraper");
      // Quiet for a full keep_alive window: the platform has likely
      // reclaimed it, though the record stays until its next resolve.
      const quietSince = Date.now() - BROWSER_SESSION_KEEP_ALIVE_MAX_MS;
      await backdateStoredSession(storage, "idle", {
        createdAt: quietSince,
        updatedAt: quietSince
      });

      const views = await capability.sessions();
      // Closed sessions are gone, not listed.
      expect(views.map(({ name, status }) => ({ name, status }))).toEqual([
        { name: "checkout", status: "live" },
        { name: "idle", status: "expired" }
      ]);
      for (const view of views) {
        expect(view.sessionId).toMatch(/^session-/);
        expect(view.createdAt).toBeGreaterThan(0);
        expect(view.updatedAt).toBeGreaterThanOrEqual(view.createdAt);
      }
    });
  });

  it("mints Live View URLs fresh on every call, never persisting them", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const binding = createFakeBrowserBinding();
      const { capability } = install(
        new BrowserSessions({ browser: binding.browser })
      );
      const resolved = await capability.resolve("checkout");

      const first = await capability.liveView("checkout");
      expect(first?.sessionId).toBe(resolved.sessionId);
      expect(first?.expiresInMs).toBe(5 * 60 * 1000);
      expect(first?.targets).toHaveLength(1);
      expect(first?.targets[0].url).toContain("live.browser.run");

      // A second mint re-lists targets and gets a fresh URL — nothing cached.
      const second = await capability.liveView("checkout");
      expect(second?.targets[0].url).not.toBe(first?.targets[0].url);

      const devtools = await capability.liveView("checkout", {
        mode: "devtools"
      });
      expect(
        new URL(devtools?.targets[0].url ?? "").searchParams.get("mode")
      ).toBe("devtools");
    });
  });

  it("returns undefined Live View for unknown, closed, or dead sessions", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const binding = createFakeBrowserBinding();
      const { capability } = install(
        new BrowserSessions({ browser: binding.browser })
      );

      expect(await capability.liveView("never-created")).toBeUndefined();

      const resolved = await capability.resolve("checkout");
      binding.kill(resolved.sessionId);
      expect(await capability.liveView("checkout")).toBeUndefined();

      const replacement = await capability.resolve("checkout");
      expect(replacement.restarted).toBe(true);
      await capability.close("checkout");
      expect(await capability.liveView("checkout")).toBeUndefined();
    });
  });

  it("treats minting a live view as activity", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const { capability } = install(new BrowserSessions({ browser }));
      await capability.resolve("checkout");
      // Quiet past the keep-alive window on record, but still alive — e.g.
      // a human already driving it through an earlier Live View link.
      await backdateStoredSession(storage, "checkout", {
        updatedAt: Date.now() - BROWSER_SESSION_KEEP_ALIVE_MAX_MS
      });
      expect((await capability.sessions())[0].status).toBe("expired");

      expect(await capability.liveView("checkout")).toBeDefined();
      expect((await capability.sessions())[0].status).toBe("live");

      // Minting never resurrects a closed session.
      await capability.close("checkout");
      expect(await capability.liveView("checkout")).toBeUndefined();
      expect(await storage.get(durableKey("checkout"))).toBeUndefined();
    });
  });

  it("reports the session gone when a close wins during live view minting", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { browser } = createFakeBrowserBinding();
      const inner = createMemoryStore();
      const key = namedBrowserSessionKey("checkout");
      // After liveView's initial read, a concurrent close retires the entry
      // — exactly the interleaving a network-yielding target listing allows.
      let closeWinsAfterNextRead = false;
      const store: BrowserSessionStore = {
        ...inner,
        get: async (k) => {
          const value = await inner.get(k);
          if (closeWinsAfterNextRead) {
            closeWinsAfterNextRead = false;
            inner.sessions.delete(key);
          }
          return value;
        }
      };
      const { capability } = install(new BrowserSessions({ browser, store }));
      await capability.resolve("checkout");

      closeWinsAfterNextRead = true;
      // The listed targets predate the close — links minted from them could
      // never connect. The lost touch must surface as "session gone".
      expect(await capability.liveView("checkout")).toBeUndefined();
      expect(inner.sessions.has(key)).toBe(false);
    });
  });
});

describe("BrowserSessions on a Durable Object", () => {
  it("schedules nothing — the platform's keep_alive reclaims idle browsers", async () => {
    const stub = env.BrowserHarnessObject.getByName(crypto.randomUUID());

    await runInDurableObject(
      stub,
      async (instance: BrowserHarnessObject, state) => {
        await instance.lifecycle.start();
        await instance.browser.resolve("checkout");
        const { cdp } = await instance.browser.connect("research");
        cdp.close();
        await instance.browser.close("checkout");

        expect(instance.lifecycle.jobs.list()).toEqual([]);
        expect(await state.storage.getAlarm()).toBeNull();
      }
    );
  });
});

describe("BrowserSessions on an Agent subclass", () => {
  it("installs through the Agent's Lifecycle with the auto-supplied store", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(
      stub,
      async (instance: TestBrowserAgent, state) => {
        const resolved = await instance.browser.resolve();
        expect(resolved.restarted).toBe(false);

        const stored = await state.storage.get<StoredBrowserSession>(
          durableKey("default")
        );
        expect(stored?.sessionId).toBe(resolved.sessionId);

        const views = await instance.browser.sessions();
        expect(views).toEqual([
          expect.objectContaining({ name: "default", status: "live" })
        ]);
      }
    );
  });
});

describe("createBrowserExecuteTool over BrowserSessions", () => {
  const code = `async () => cdp.send({
    method: "Runtime.evaluate",
    params: { expression: "document.title" },
    sessionId: "active"
  })`;

  it("runs model code in the host's persistent browser", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(
      stub,
      async (instance: TestBrowserAgent, state) => {
        const tool = instance.browserExecuteTool();
        const first = (await tool.execute({ code }, {})) as {
          status: string;
          result: unknown;
          restarted?: boolean;
        };
        expect(first.status).toBe("completed");
        expect(first.result).toEqual({
          result: { value: "evaluated in target-session-1" }
        });
        expect(first.restarted).toBeUndefined();

        // The active tab is saved on the named session's record.
        const stored = await state.storage.get<StoredBrowserSession>(
          durableKey("default")
        );
        expect(stored?.activeTargetId).toBe("target-session-1");

        // A tool rebuilt next turn reuses the same browser.
        const second = (await instance
          .browserExecuteTool()
          .execute({ code }, {})) as { status: string };
        expect(second.status).toBe("completed");
        const creates = instance.browserRequests.filter(
          (request) => request.method === "POST" && !request.upgrade
        );
        expect(creates).toHaveLength(1);
      }
    );
  });

  it("still runs the code after a restart and tells the model", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      const tool = instance.browserExecuteTool();
      await tool.execute({ code }, {});
      instance.killBrowserSession("session-1");

      const output = (await tool.execute({ code }, {})) as {
        status: string;
        result: unknown;
        restarted?: boolean;
        notice?: string;
      };
      expect(output.status).toBe("completed");
      expect(output.result).toEqual({
        result: { value: "evaluated in target-session-2" }
      });
      expect(output.restarted).toBe(true);
      expect(output.notice).toMatch(/restarted/);

      const modelOutput = tool.toModelOutput({ output }) as {
        value: { restarted?: boolean; notice?: string; calls?: unknown };
      };
      expect(modelOutput.value.restarted).toBe(true);
      expect(modelOutput.value.notice).toMatch(/navigate again/);
      expect(modelOutput.value.calls).toBeUndefined();
    });
  });
});
