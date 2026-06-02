import { describe, expect, it } from "vitest";
import { createBrowserProvider, createBrowserTools } from "../tools/browser";

describe("createBrowserTools", () => {
  it("returns a ToolSet with browser_execute", () => {
    const tools = createBrowserTools({
      browser: {} as Fetcher,
      loader: {} as WorkerLoader
    });

    expect(tools).toHaveProperty("browser_execute");
    expect(Object.keys(tools)).toHaveLength(1);
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

    expect(tools).toHaveProperty("browser_execute");
  });

  it("accepts optional timeout", () => {
    const tools = createBrowserTools({
      browser: {} as Fetcher,
      loader: {} as WorkerLoader,
      timeout: 60_000
    });

    expect(tools).toHaveProperty("browser_execute");
  });

  it("creates a cdp code mode provider", async () => {
    const provider = createBrowserProvider({
      browser: {} as Fetcher,
      timeout: 60_000
    });

    expect(provider.name).toBe("cdp");
    expect(provider.types).toContain("declare const cdp");
    expect(provider.types).toContain("spec:");
    expect(provider.types).toContain("send:");
    expect(provider.tools).toHaveProperty("spec");

    const runtime = await provider.createRuntime?.();
    expect(runtime?.fns).toHaveProperty("send");
    expect(runtime?.fns).toHaveProperty("attachToTarget");
    expect(runtime?.fns).toHaveProperty("getDebugLog");
    expect(runtime?.fns).toHaveProperty("clearDebugLog");
  });

  it("accepts cdpUrl connection options for the provider", () => {
    const provider = createBrowserProvider({
      cdpUrl: "http://localhost:9222",
      cdpHeaders: { authorization: "Bearer test" }
    });

    expect(provider.name).toBe("cdp");
    expect(provider.types).toContain("declare const cdp");
  });

  it("defers browser configuration errors until provider tools are called", async () => {
    const provider = createBrowserProvider(
      {} as Parameters<typeof createBrowserProvider>[0]
    );
    const runtime = await provider.createRuntime?.();

    await expect(runtime?.fns.send("Browser.getVersion")).rejects.toThrow(
      "Either 'browser' (Fetcher binding) or 'cdpUrl' must be provided"
    );
  });
});
