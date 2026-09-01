import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("pi package entries", () => {
  it("ship a self-contained runtime without build-only aliases", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve("package.json"), "utf8")
    ) as { exports: Record<string, unknown> };
    expect(packageJson.exports["./harness"]).toEqual({
      types: "./dist/harness/index.d.ts",
      import: "./dist/harness/index.js",
      require: "./dist/harness/index.js"
    });
    expect(packageJson.exports["./providers/pi"]).toEqual({
      types: "./dist/providers/pi/index.d.ts",
      import: "./dist/providers/pi/index.js",
      require: "./dist/providers/pi/index.js"
    });

    const result = await build({
      stdin: {
        contents: `
          import { PiHarness } from "agents/harness";
          import { createWorkersAI } from "agents/providers/pi";
          console.log(PiHarness, createWorkersAI);
        `,
        resolveDir: resolve("."),
        sourcefile: "pi-harness-consumer.ts"
      },
      bundle: true,
      external: ["agents/lifecycle"],
      format: "esm",
      metafile: true,
      platform: "browser",
      target: "es2021",
      write: false
    });
    const inputs = Object.keys(result.metafile!.inputs).join("\n");
    const output = result.outputFiles.map((file) => file.text).join("\n");

    expect(inputs).toContain("dist/harness/index.js");
    expect(inputs).toContain("dist/providers/pi/index.js");
    expect(inputs).not.toContain("pi-agent-core-dev");
    expect(inputs).not.toContain("pi-ai-dev");
    expect(inputs).not.toContain("pi-sqlite-dev");
    expect(output).not.toMatch(/from\s+["']node:/);
    expect(output).not.toContain("createRequire");
  });
});
