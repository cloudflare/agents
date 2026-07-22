import { build } from "esbuild";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("agents/mcp/server bundle", () => {
  it("does not retain legacy, client, or Agent runtime modules", async () => {
    const result = await build({
      entryPoints: [resolve("src/mcp/server.ts")],
      bundle: true,
      conditions: ["workerd", "browser", "import", "module"],
      external: ["cloudflare:*"],
      format: "esm",
      metafile: true,
      minify: true,
      platform: "node",
      target: "es2021",
      write: false
    });
    const inputs = Object.keys(result.metafile!.inputs).join("\n");

    expect(inputs).not.toContain("@modelcontextprotocol+sdk@");
    expect(inputs).not.toContain("@modelcontextprotocol+client@");
    expect(inputs).not.toContain("partyserver");
    expect(inputs).not.toContain("partysocket");
    expect(inputs).not.toContain("src/mcp/worker-transport.ts");
    expect(inputs).not.toContain("src/mcp/handler-legacy.ts");
    expect(inputs).not.toContain("src/mcp/index.ts");
  });
});
