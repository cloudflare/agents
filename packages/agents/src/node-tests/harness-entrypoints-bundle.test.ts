import { build } from "esbuild";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function inputs(entrypoint: string, symbol: string): Promise<string> {
  const result = await build({
    stdin: {
      contents: `import { ${symbol} } from ${JSON.stringify(entrypoint)}; console.log(${symbol});`,
      resolveDir: resolve("."),
      sourcefile: `${symbol}.ts`
    },
    bundle: true,
    conditions: ["workerd", "worker", "browser", "import"],
    external: ["cloudflare:*"],
    format: "esm",
    metafile: true,
    platform: "node",
    target: "es2021",
    write: false
  });
  return Object.keys(result.metafile?.inputs ?? {}).join("\n");
}

describe("harness entrypoint isolation", () => {
  it("keeps Pi and OpenCode out of the root entrypoint", async () => {
    const bundled = await inputs("agents", "Agent");

    expect(bundled).not.toContain("@earendil-works");
    expect(bundled).not.toContain("@opencode");
  });

  it("keeps native runtimes out of agents/driver", async () => {
    const bundled = await inputs("agents/driver", "HarnessDriver");

    expect(bundled).toContain("dist/driver/index.js");
    expect(bundled).not.toContain("@earendil-works");
    expect(bundled).not.toContain("@opencode");
  });

  it("keeps OpenCode out of agents/pi", async () => {
    const bundled = await inputs("agents/pi", "PiHarness");

    expect(bundled).toContain("@earendil-works");
    expect(bundled).not.toContain("@opencode");
  });

  it("keeps Pi and React out of agents/opencode", async () => {
    const bundled = await inputs("agents/opencode", "OpenCodeHarness");

    expect(bundled).toContain("@opencode");
    expect(bundled).not.toContain("@earendil-works");
    expect(bundled).not.toMatch(/(^|[/+])react([/@+]|$)/m);
  });
});
