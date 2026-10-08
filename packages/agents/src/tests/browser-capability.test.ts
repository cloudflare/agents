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
  DEFAULT_BROWSER_SCOPE,
  namedBrowserSessionKey
} from "../browser/browser";
import type {
  ListableBrowserSessionStore,
  StoredBrowserSession
} from "../browser/session-store";

/** The Durable Object storage key the auto-supplied store writes `name` to. */
function durableKey(name: string): string {
  return `browser-session:${namedBrowserSessionKey(name)}`;
}

/** A minimal custom store — enough to prove the capability honors one. */
function createMemoryStore(): ListableBrowserSessionStore & {
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
      const store: ListableBrowserSessionStore = {
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

describe("browserTool over a Browser", () => {
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
        const first = await instance.browserTool().execute({ code }, {});
        expect(first.status).toBe("completed");
        expect(first.status === "completed" && first.result).toEqual({
          result: { value: "evaluated in target-session-1-2" }
        });
        expect(first.restarted).toBeUndefined();

        // The active tab is saved on the default scope's record.
        const stored = await state.storage.get<StoredBrowserSession>(
          `browser-session:browser:scope:7:default:${DEFAULT_BROWSER_SCOPE}`
        );
        expect(stored?.activeTargetId).toBe("target-session-1-2");

        // A tool rebuilt next turn reuses the same browser.
        const second = await instance.browserTool().execute({ code }, {});
        expect(second.status).toBe("completed");
        const creates = instance.browserRequests.filter(
          (request) => request.method === "POST" && !request.upgrade
        );
        expect(creates).toHaveLength(1);
      }
    );
  });

  it("gives each scope its own tab in the shared browser", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      const a = await instance.browserTool("a").execute({ code }, {});
      const b = await instance.browserTool("b").execute({ code }, {});
      const again = await instance.browserTool("a").execute({ code }, {});

      expect(a.status === "completed" && a.result).toEqual({
        result: { value: "evaluated in target-session-1-2" }
      });
      expect(b.status === "completed" && b.result).toEqual({
        result: { value: "evaluated in target-session-1-3" }
      });
      expect(again.status === "completed" && again.result).toEqual({
        result: { value: "evaluated in target-session-1-2" }
      });
    });
  });

  it("runs one scope's calls one at a time, and different scopes together", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());
    const waitCode = (ms: number) => `async () => cdp.send({
      method: "Runtime.evaluate",
      params: { expression: "wait:${ms}" },
      sessionId: "active"
    })`;

    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      // Create the browser first, so neither run below races to create it.
      await instance.browserTool().execute({ code }, {});

      // Tools built separately (a turn each, say) still share the queue.
      await Promise.all([
        instance.browserTool("a").execute({ code: waitCode(40) }, {}),
        instance.browserTool("a").execute({ code: waitCode(41) }, {})
      ]);
      expect(instance.browserEvents.splice(0)).toEqual([
        "start wait:40",
        "end wait:40",
        "start wait:41",
        "end wait:41"
      ]);

      await Promise.all([
        instance.browserTool("b").execute({ code: waitCode(40) }, {}),
        instance.browserTool("c").execute({ code: waitCode(41) }, {})
      ]);
      expect(instance.browserEvents.slice(0, 2).sort()).toEqual([
        "start wait:40",
        "start wait:41"
      ]);
    });
  });

  it("still runs the code after a restart and tells the model", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      const tool = instance.browserTool();
      await tool.execute({ code }, {});
      instance.killBrowserSession("session-1");

      const output = await tool.execute({ code }, {});
      expect(output.status).toBe("completed");
      expect(output.status === "completed" && output.result).toEqual({
        result: { value: "evaluated in target-session-2-2" }
      });
      expect(output.restarted).toBe(true);
      expect(output.notice).toMatch(/restarted/);

      const modelOutput = tool.toModelOutput({ output });
      expect(modelOutput.type).toBe("json");
      expect(modelOutput.value).toMatchObject({
        restarted: true,
        notice: expect.stringMatching(/navigate again/)
      });
      expect(modelOutput.value).not.toHaveProperty("calls");
    });
  });

  it("describes cdp and its rules without codemode's generic text", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      const { description } = instance.browserTool();
      // No discovery pass needed: the rules are right there.
      expect(description).toContain('sessionId: "active"');
      expect(description).toContain("returnByValue: true");
      expect(description).toContain("document.readyState");
      expect(description).toContain("times out after 60s");
      // None of codemode's generic text, which doesn't fit this tool.
      expect(description).not.toContain("codemode.search");
      expect(description).not.toContain("paused");
      expect(description).not.toContain("Snippets");
      expect(description).not.toContain("file or workspace");
    });
  });

  it("explains how to take a smaller screenshot when one is too large", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      const capture = (bytes: number) =>
        instance.browserTool().execute(
          {
            code: `async () => (await cdp.send({ method: "Page.captureScreenshot", params: { fakeBytes: ${bytes} }, sessionId: "active" })).data.length`
          },
          {}
        );

      const small = await capture(500_000);
      expect(small.status === "completed" && small.result).toBe(500_000);

      const large = await capture(1_500_000);
      expect(large.status).toBe("error");
      expect(large.status === "error" && large.error).toMatch(
        /1\.5 MB.*viewport.*jpeg/s
      );

      // The data alone fits, but the stored result ({"data":"..."}) doesn't.
      const nearLimit = await capture(999_995);
      expect(nearLimit.status === "error" && nearLimit.error).toMatch(
        /viewport.*jpeg/s
      );
    });
  });
});

describe("TanStack AI browserTool over a Browser", () => {
  const code = `async () => cdp.send({
    method: "Runtime.evaluate",
    params: { expression: "document.title" },
    sessionId: "active"
  })`;

  it("is named browser unless the host picks a name", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      expect(instance.tanStackBrowserTool().name).toBe("browser");
      expect(instance.tanStackBrowserTool("web").name).toBe("web");
      expect(instance.tanStackBrowserTool().description).toContain("`cdp`");
      // The model is told screenshots can't come back, not that the user sees them.
      expect(instance.tanStackBrowserTool().description).toContain(
        "can't return images"
      );
      expect(instance.tanStackBrowserTool().description).not.toContain(
        "The user sees the image"
      );
    });
  });

  it("drives the same persistent browser and returns what the model sees", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      const first = await instance.tanStackBrowserTool().execute?.({ code });
      expect(first).toMatchObject({
        status: "completed",
        result: { result: { value: "evaluated in target-session-1-2" } }
      });
      // The durable call log stays out of the model's context.
      expect(first).not.toHaveProperty("calls");

      instance.killBrowserSession("session-1");
      const second = await instance.tanStackBrowserTool().execute?.({ code });
      expect(second).toMatchObject({
        status: "completed",
        result: { result: { value: "evaluated in target-session-2-2" } },
        restarted: true,
        notice: expect.stringMatching(/navigate again/)
      });
    });
  });

  it("says a screenshot was left out and keeps the browser report", async () => {
    const stub = env.TestBrowserAgent.getByName(crypto.randomUUID());

    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      const tool = instance.tanStackBrowserTool();
      await tool.execute?.({ code });
      instance.killBrowserSession("session-1");

      const output = await tool.execute?.({
        code: `async () => {
          await cdp.send({ method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "active" });
          return { type: "browser_screenshot", mediaType: "image/png", data: "aGVsbG8=" };
        }`
      });
      expect(output).toMatchObject({
        status: "completed",
        result: expect.stringMatching(/neither you nor the user can see it/),
        restarted: true
      });
      expect(JSON.stringify(output)).not.toContain("aGVsbG8=");
    });
  });
});
