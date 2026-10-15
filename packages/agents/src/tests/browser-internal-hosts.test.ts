import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { TestBrowserAgent } from "./agents/browser";
import type {
  InternalHostsNoMethodObject,
  InternalHostsPlainObject
} from "./capabilities/browser";
import { namedBrowserSessionKey } from "../browser/browser";
import { browserRun } from "../browser/providers/browser-run";
import {
  fetcherRoute,
  MAX_INTERNAL_HOSTS,
  type InternalHostRouterLoopback
} from "../browser/internal-hosts";
import type { StoredBrowserSession } from "../browser/session-store";

const router = (() => {
  throw new Error("not called");
}) as unknown as InternalHostRouterLoopback;
const binding = { fetch: () => Promise.resolve(new Response()) };
const fetch = async () => new Response("ok");

function agent() {
  return env.TestBrowserAgent.getByName(crypto.randomUUID());
}

describe("browserRun internalHosts validation", () => {
  it("rejects more hostnames than Browser Run allows", () => {
    const hosts = Object.fromEntries(
      Array.from({ length: MAX_INTERNAL_HOSTS + 1 }, (_, i) => [
        `h${i}.internal`,
        { fetch }
      ])
    );
    expect(() =>
      browserRun(binding, { internalHosts: { router, hosts } })
    ).toThrow(/at most 8/);
  });

  it.each([
    ["http://a.internal", /scheme/],
    ["a.internal:8080", /port/],
    ["a.internal/x", /path/],
    ["A.internal", /lowercase/],
    ["10.0.0.1", /IP/],
    ["localhost", /localhost/],
    ["-bad.internal", /valid/]
  ])("rejects %s", (host, message) => {
    expect(() =>
      browserRun(binding, {
        internalHosts: { router, hosts: { [host]: { fetch } } }
      })
    ).toThrow(message);
  });

  it("needs a router for fetch hosts", () => {
    expect(() =>
      browserRun(binding, {
        internalHosts: { hosts: { "a.internal": { fetch } } }
      })
    ).toThrow(/InternalHostRouter/);
  });

  it("takes exactly one of fetch or fetcher", () => {
    expect(() =>
      browserRun(binding, {
        internalHosts: {
          router,
          hosts: {
            "a.internal": {
              fetch,
              fetcher: binding as unknown as Fetcher
            } as never
          }
        }
      })
    ).toThrow(/exactly one/);
  });

  it("needs a router-free config for fetcher-only hosts", () => {
    expect(() =>
      browserRun(binding, {
        internalHosts: {
          hosts: { "a.internal": { fetcher: binding as unknown as Fetcher } }
        }
      })
    ).not.toThrow();
  });
});

describe("fetcherRoute", () => {
  it("passes a service binding through", () => {
    expect(fetcherRoute(binding as unknown as Fetcher)).toBe(binding);
  });

  it("calls a ctx.exports entrypoint loopback to get a Fetcher", () => {
    const fetcher = { fetch } as unknown as Fetcher;
    const calls: unknown[] = [];
    const loopback = (init: unknown) => {
      calls.push(init);
      return fetcher;
    };
    expect(fetcherRoute(loopback as unknown as Fetcher)).toBe(fetcher);
    expect(calls).toEqual([{ props: {} }]);
  });
});

describe("Browser internal hosts", () => {
  it("starts the browser with one route per hostname", async () => {
    await runInDurableObject(agent(), async (instance: TestBrowserAgent) => {
      await instance.internalResolve();
      expect(instance.internalRouteHosts().sort()).toEqual([
        "broken.internal",
        "echo.internal"
      ]);
    });
  });

  it("serves a fixed host from the agent, through the router", async () => {
    const stub = agent();
    await runInDurableObject(stub, async (instance: TestBrowserAgent) => {
      const response = await instance.internalHostFetch(
        "http://echo.internal/page?x=1",
        { method: "POST", body: "hi" }
      );
      expect(response).toMatchObject({
        status: 200,
        text: `echo POST /page from ${instance.name}`
      });
      expect(instance.internalRequests).toEqual([
        "http://echo.internal/page?x=1"
      ]);
    });
  });

  it("turns a throwing fetch into a 502 with the reason", async () => {
    await runInDurableObject(agent(), async (instance: TestBrowserAgent) => {
      const response = await instance.internalHostFetch(
        "http://broken.internal/"
      );
      expect(response.status).toBe(502);
      expect(response.text).toBe("broken.internal: dev server not listening");
    });
  });

  it("replaces a browser started with other hostnames", async () => {
    await runInDurableObject(
      agent(),
      async (instance: TestBrowserAgent, state) => {
        const first = await instance.internalResolve();
        const key = `browser-session:${namedBrowserSessionKey("internal")}`;
        const stored = await state.storage.get<StoredBrowserSession>(key);
        expect(stored?.internalHosts).toBe(
          "broken.internal=fetch,echo.internal=fetch"
        );
        await state.storage.put(key, { ...stored, internalHosts: "old=fetch" });

        const second = await instance.internalResolve();
        expect(second).toEqual({
          sessionId: expect.not.stringMatching(first.sessionId),
          restarted: true
        });
        expect(instance.internalAcquired).toHaveLength(2);
      }
    );
  });
});

describe("Browser internal hosts on a plain Durable Object", () => {
  it("serves a host through the object's own fetchInternalHost()", async () => {
    const name = crypto.randomUUID();
    await runInDurableObject(
      env.InternalHostsPlainObject.getByName(name),
      async (instance: InternalHostsPlainObject) => {
        expect(
          await instance.fetchThroughRoute("http://echo.internal/page")
        ).toEqual({ status: 200, text: `echo /page from ${name}` });
      }
    );
  });

  it("answers 502 when the message names another browser", async () => {
    await runInDurableObject(
      env.InternalHostsPlainObject.getByName(crypto.randomUUID()),
      async (instance: InternalHostsPlainObject) => {
        const response = await instance.browser.fetchInternalHost({
          browser: "other",
          host: "echo.internal",
          request: new Request("http://echo.internal/")
        });
        expect(response.status).toBe(502);
        expect(await response.text()).toBe(
          'echo.internal belongs to browser "other", but was passed to browser "internal"'
        );
      }
    );
  });

  it("says what to add when fetchInternalHost() is missing", async () => {
    await runInDurableObject(
      env.InternalHostsNoMethodObject.getByName(crypto.randomUUID()),
      async (instance: InternalHostsNoMethodObject) => {
        expect(
          await instance.fetchThroughRoute("http://echo.internal/")
        ).toEqual({
          status: 502,
          text: "echo.internal: InternalHostsNoMethodObject has no fetchInternalHost() method. Agent has it built in; on a plain Durable Object add: fetchInternalHost(message) { return this.browser.fetchInternalHost(message); }"
        });
      }
    );
  });
});
