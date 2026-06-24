import { describe, expect, it } from "vitest";
import { createBrowserRuntime, createBrowserTools } from "../tools/browser";

// Shape-only tests: nothing here executes against the facet, storage, or the
// browser binding — those paths are exercised by the agents browser e2e
// suite. The facet stub satisfies the runtime's eager `ctx.facets.get`, and
// the export mirrors a Worker entry that re-exports CodemodeRuntime.
const fakeCtx = {
  storage: {},
  facets: { get: () => ({}) },
  exports: { CodemodeRuntime: class MockCodemodeRuntime {} }
} as unknown as DurableObjectState;

describe("createBrowserTools", () => {
  it("returns browser_execute plus the default Quick Action tools when a binding is present", () => {
    const tools = createBrowserTools({
      ctx: fakeCtx,
      browser: {} as Fetcher,
      loader: {} as WorkerLoader
    });

    expect(Object.keys(tools).sort()).toEqual([
      "browser_execute",
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape"
    ]);
    expect(typeof tools.browser_execute.execute).toBe("function");
    // The runtime tool description lists the cdp connector namespace.
    expect(tools.browser_execute.description).toContain("`cdp`");
  });

  it("omits Quick Action tools when quickActions is false", () => {
    const tools = createBrowserTools({
      ctx: fakeCtx,
      browser: {} as Fetcher,
      loader: {} as WorkerLoader,
      quickActions: false
    });

    expect(Object.keys(tools)).toEqual(["browser_execute"]);
  });

  it("accepts cdpUrl instead of browser binding (Quick Actions skipped without a binding)", () => {
    const tools = createBrowserTools({
      ctx: fakeCtx,
      cdpUrl: "http://localhost:9222",
      loader: {} as WorkerLoader
    });

    expect(Object.keys(tools)).toEqual(["browser_execute"]);
  });

  it("accepts optional timeout and session mode", () => {
    const tools = createBrowserTools({
      ctx: fakeCtx,
      browser: {} as Fetcher,
      loader: {} as WorkerLoader,
      timeout: 60_000,
      session: { mode: "dynamic" }
    });

    expect(tools).toHaveProperty("browser_execute");
  });

  it("requires a browser binding or cdpUrl", () => {
    expect(() =>
      createBrowserTools({
        ctx: fakeCtx,
        loader: {} as WorkerLoader
      })
    ).toThrow("must be provided");
  });

  it("exposes the runtime handle and connector via createBrowserRuntime", () => {
    const { runtime, connector, tools } = createBrowserRuntime({
      ctx: fakeCtx,
      browser: {} as Fetcher,
      loader: {} as WorkerLoader
    });

    expect(connector.name()).toBe("cdp");
    expect(typeof runtime.approve).toBe("function");
    expect(typeof runtime.expirePaused).toBe("function");
    expect(typeof connector.sweep).toBe("function");
    expect(tools).toHaveProperty("browser_execute");
  });
});
