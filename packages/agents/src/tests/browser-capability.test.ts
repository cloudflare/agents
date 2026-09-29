import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestBrowserAgent } from "./agents/browser";
import {
  type BrowserHarnessObject,
  createFakeBrowserBinding
} from "./capabilities/browser";
import { withCapabilityHarness } from "./shared/capability-harness";
import {
  BROWSER_SESSION_KEEP_ALIVE_MAX_MS,
  Browser,
  browserRun,
  namedBrowserSessionKey
} from "../browser/browser";
import type {
  BrowserSessionStore,
  StoredBrowserSession
} from "../browser/session-store";

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

describe("Browser capability", () => {
  it("auto-supplies a Durable Object store over the host's storage", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const { capability } = install(
        new Browser({ provider: browserRun(browser) })
      );

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
      const { capability } = install(
        new Browser({ provider: browserRun(browser), name: "scraper", store })
      );

      const resolved = await capability.resolve();
      expect(store.sessions.get(namedBrowserSessionKey("scraper"))).toEqual(
        expect.objectContaining({ sessionId: resolved.sessionId })
      );
      expect(await storage.get(durableKey("scraper"))).toBeUndefined();
    });
  });

  it("reapplies Browser Run options on every create", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const binding = createFakeBrowserBinding();
      const { capability } = install(
        new Browser({
          provider: browserRun(binding.browser, {
            recording: true,
            guardrails: { allowedDomains: ["example.com", "*.example.com"] }
          })
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

  it("runs several named browsers side by side on one object", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const provider = browserRun(browser);
      const research = new Browser({ provider, name: "research" });
      const checkout = new Browser({ provider, name: "checkout" });
      const { lifecycle } = install(research);
      lifecycle.use(checkout);

      const a = await research.resolve();
      const b = await checkout.resolve();
      expect(a.sessionId).not.toBe(b.sessionId);

      // Closing one leaves the other untouched.
      expect(await checkout.close()).toBe(true);
      expect(await storage.get(durableKey("checkout"))).toBeUndefined();
      expect((await research.resolve()).sessionId).toBe(a.sessionId);

      // Two Browsers with one name would share a record — Lifecycle refuses.
      expect(() =>
        lifecycle.use(new Browser({ provider, name: "research" }))
      ).toThrow(/already installed/);
    });
  });

  it("mints Live View URLs fresh on every call, never persisting them", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const binding = createFakeBrowserBinding();
      const { capability } = install(
        new Browser({ provider: browserRun(binding.browser) })
      );
      const resolved = await capability.resolve();

      const first = await capability.liveView();
      expect(first?.sessionId).toBe(resolved.sessionId);
      expect(first?.expiresInMs).toBe(5 * 60 * 1000);
      expect(first?.targets).toHaveLength(1);
      expect(first?.targets[0].url).toContain("live.browser.run");

      // A second mint re-lists targets and gets a fresh URL — nothing cached.
      const second = await capability.liveView();
      expect(second?.targets[0].url).not.toBe(first?.targets[0].url);

      const devtools = await capability.liveView({ mode: "devtools" });
      expect(
        new URL(devtools?.targets[0].url ?? "").searchParams.get("mode")
      ).toBe("devtools");
    });
  });

  it("returns undefined Live View for a never-created, closed, or dead browser", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const binding = createFakeBrowserBinding();
      const { capability } = install(
        new Browser({ provider: browserRun(binding.browser) })
      );

      expect(await capability.liveView()).toBeUndefined();

      const resolved = await capability.resolve();
      binding.kill(resolved.sessionId);
      expect(await capability.liveView()).toBeUndefined();

      const replacement = await capability.resolve();
      expect(replacement.restarted).toBe(true);
      await capability.close();
      expect(await capability.liveView()).toBeUndefined();
    });
  });

  it("treats minting a live view as activity", async () => {
    await withCapabilityHarness(async ({ storage, install }) => {
      const { browser } = createFakeBrowserBinding();
      const { capability } = install(
        new Browser({ provider: browserRun(browser) })
      );
      await capability.resolve();
      // Quiet past the keep-alive window on record, but still alive — e.g.
      // a human already driving it through an earlier Live View link.
      const quietSince = Date.now() - BROWSER_SESSION_KEEP_ALIVE_MAX_MS;
      await backdateStoredSession(storage, "default", {
        updatedAt: quietSince
      });

      expect(await capability.liveView()).toBeDefined();
      const stored = await storage.get<StoredBrowserSession>(
        durableKey("default")
      );
      expect(stored?.updatedAt).toBeGreaterThan(quietSince);

      // Minting never resurrects a closed browser.
      await capability.close();
      expect(await capability.liveView()).toBeUndefined();
      expect(await storage.get(durableKey("default"))).toBeUndefined();
    });
  });

  it("reports the browser gone when a close wins during live view minting", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const { browser } = createFakeBrowserBinding();
      const inner = createMemoryStore();
      const key = namedBrowserSessionKey("default");
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
      const { capability } = install(
        new Browser({ provider: browserRun(browser), store })
      );
      await capability.resolve();

      closeWinsAfterNextRead = true;
      // The listed targets predate the close — links minted from them could
      // never connect. The lost touch must surface as "browser gone".
      expect(await capability.liveView()).toBeUndefined();
      expect(inner.sessions.has(key)).toBe(false);
    });
  });
});

describe("Browser on a Durable Object", () => {
  it("schedules nothing — the platform's keep_alive reclaims idle browsers", async () => {
    const stub = env.BrowserHarnessObject.getByName(crypto.randomUUID());

    await runInDurableObject(
      stub,
      async (instance: BrowserHarnessObject, state) => {
        await instance.lifecycle.start();
        await instance.browser.resolve();
        const { cdp } = await instance.browser.connect();
        cdp.close();
        await instance.browser.close();

        expect(instance.lifecycle.jobs.list()).toEqual([]);
        expect(await state.storage.getAlarm()).toBeNull();
      }
    );
  });
});

describe("Browser on an Agent subclass", () => {
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
      }
    );
  });
});
