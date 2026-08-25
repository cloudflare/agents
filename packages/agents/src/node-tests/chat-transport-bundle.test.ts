import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("agents/chat/transport bundle", () => {
  it("has a public export with no React runtime dependency", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve("package.json"), "utf8")
    ) as {
      exports: Record<string, unknown>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };

    expect(packageJson.exports["./chat/transport"]).toEqual({
      types: "./dist/chat/transport.d.ts",
      import: "./dist/chat/transport.js",
      require: "./dist/chat/transport.js"
    });
    expect(packageJson.peerDependenciesMeta.react?.optional).toBe(true);

    const result = await build({
      stdin: {
        contents: `
          import { WebSocketChatTransport } from "agents/chat/transport";
          console.log(WebSocketChatTransport);
        `,
        resolveDir: resolve("."),
        sourcefile: "framework-neutral-chat.ts"
      },
      bundle: true,
      format: "esm",
      metafile: true,
      platform: "browser",
      target: "es2021",
      write: false
    });
    const inputs = Object.keys(result.metafile!.inputs).join("\n");

    expect(inputs).toContain("dist/chat/transport.js");
    expect(inputs).not.toContain("@ai-sdk/react");
    expect(inputs).not.toMatch(/(^|[/+])react([/@+]|$)/);
  });
});
