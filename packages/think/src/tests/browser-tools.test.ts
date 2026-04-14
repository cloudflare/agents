import { describe, expect, it } from "vitest";
import { createBrowserTools } from "../tools/browser";

describe("createBrowserTools", () => {
  it("returns a ToolSet with browser_search and browser_execute", () => {
    const tools = createBrowserTools({
      // Both are required at construction time but not validated until invoked
      browser: {} as Fetcher,
      loader: {} as WorkerLoader
    });

    expect(tools).toHaveProperty("browser_search");
    expect(tools).toHaveProperty("browser_execute");
    expect(Object.keys(tools)).toHaveLength(2);
  });

  it("browser_search tool has the correct schema shape", () => {
    const tools = createBrowserTools({
      browser: {} as Fetcher,
      loader: {} as WorkerLoader
    });

    const search = tools.browser_search;
    expect(search).toBeDefined();
    expect(typeof search.execute).toBe("function");
  });

  it("browser_execute tool has the correct schema shape", () => {
    const tools = createBrowserTools({
      browser: {} as Fetcher,
      loader: {} as WorkerLoader
    });

    const execute = tools.browser_execute;
    expect(execute).toBeDefined();
    expect(typeof execute.execute).toBe("function");
  });

  it("accepts cdpUrl instead of browser binding", () => {
    const tools = createBrowserTools({
      cdpUrl: "http://localhost:9222",
      loader: {} as WorkerLoader
    });

    expect(tools).toHaveProperty("browser_search");
    expect(tools).toHaveProperty("browser_execute");
  });

  it("accepts optional timeout", () => {
    const tools = createBrowserTools({
      browser: {} as Fetcher,
      loader: {} as WorkerLoader,
      timeout: 60_000
    });

    expect(tools).toHaveProperty("browser_search");
    expect(tools).toHaveProperty("browser_execute");
  });
});
