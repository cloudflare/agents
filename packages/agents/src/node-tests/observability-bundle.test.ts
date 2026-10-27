import { build } from "esbuild";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function bundledInputs(entryPoint: string): Promise<string> {
  const result = await build({
    entryPoints: [resolve(entryPoint)],
    bundle: true,
    conditions: ["workerd", "worker", "browser", "import", "module"],
    external: ["cloudflare:*"],
    format: "esm",
    metafile: true,
    platform: "node",
    target: "es2021",
    write: false
  });
  return Object.keys(result.metafile!.inputs).join("\n");
}

describe("OpenTelemetry bridge bundle isolation", () => {
  it("keeps the bridge and @opentelemetry/api out of the main agents entry", async () => {
    const inputs = await bundledInputs("src/index.ts");
    expect(inputs).not.toContain("src/observability/otel/");
    expect(inputs).not.toContain("@opentelemetry");
  });

  it("ships the bridge from agents/observability", async () => {
    const inputs = await bundledInputs("src/observability/index.ts");
    expect(inputs).toContain("src/observability/otel/bridge.ts");
  });
});
