import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BrowserToolsHost } from "./worker";

function host() {
  const id = env.BrowserToolsHost.idFromName("browser-tools");
  return env.BrowserToolsHost.get(id) as DurableObjectStub<BrowserToolsHost>;
}

describe("createBrowserTools", () => {
  it("returns browser_execute plus the default Quick Action tools when a binding is present", async () => {
    const tools = await host().toolsWithBinding();

    expect(tools.keys).toEqual([
      "browser_execute",
      "browser_extract",
      "browser_links",
      "browser_markdown",
      "browser_scrape"
    ]);
    expect(tools.hasExecute).toBe(true);
    // The runtime tool description lists the cdp connector namespace.
    expect(tools.description).toContain("`cdp`");
  });

  it("omits Quick Action tools when quickActions is false", async () => {
    await expect(host().toolsWithoutQuickActions()).resolves.toMatchObject({
      keys: ["browser_execute"]
    });
  });

  it("accepts cdpUrl instead of browser binding (Quick Actions skipped without a binding)", async () => {
    await expect(host().toolsWithCdpUrl()).resolves.toMatchObject({
      keys: ["browser_execute"]
    });
  });

  it("accepts optional timeout and session mode", async () => {
    await expect(host().toolsWithOptions()).resolves.toMatchObject({
      keys: expect.arrayContaining(["browser_execute"])
    });
  });

  it("requires a browser binding or cdpUrl", async () => {
    await expect(host().missingBrowserOrCdpUrlError()).resolves.toContain(
      "must be provided"
    );
  });

  it("exposes the runtime handle and connector via createBrowserRuntime", async () => {
    await expect(host().runtimeShape()).resolves.toEqual({
      connectorName: "cdp",
      runtimeApprove: "function",
      runtimeExpirePaused: "function",
      connectorSweep: "function",
      hasExecute: true
    });
  });
});
