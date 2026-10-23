import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// `@modelcontextprotocol/sdk` (v1) and `@modelcontextprotocol/server` (v2) are
// optional peers. Only the legacy `agents/mcp` barrel, `agents/mcp/server`,
// `agents/x402`, and `agents/experimental/webmcp` may load them. Entries that
// most apps import must bundle without either package installed.
const entries = {
  agents: "src/index.ts",
  "agents/mcp/client": "src/mcp/client/index.ts",
  "agents/client": "src/client.ts",
  "agents/react": "src/react.tsx"
};

describe("optional MCP peers", () => {
  it("are marked optional in package.json", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve("package.json"), "utf8")
    ) as {
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };

    expect(
      packageJson.peerDependenciesMeta["@modelcontextprotocol/sdk"]?.optional
    ).toBe(true);
    expect(
      packageJson.peerDependenciesMeta["@modelcontextprotocol/server"]?.optional
    ).toBe(true);
  });

  for (const [name, entry] of Object.entries(entries)) {
    it(`${name} does not load @modelcontextprotocol/sdk or /server`, async () => {
      const result = await build({
        entryPoints: [resolve(entry)],
        bundle: true,
        conditions: ["workerd", "browser", "import", "module"],
        external: ["cloudflare:*", "node:*"],
        format: "esm",
        metafile: true,
        platform: "node",
        target: "es2022",
        write: false,
        logLevel: "silent"
      });
      const inputs = Object.keys(result.metafile!.inputs).join("\n");

      expect(inputs).not.toContain("@modelcontextprotocol+sdk@");
      expect(inputs).not.toContain("@modelcontextprotocol+server@");
      expect(inputs).not.toContain("src/mcp/rpc-server.ts");
      expect(inputs).not.toContain("src/mcp/server/legacy-agent.ts");
    });
  }
});
