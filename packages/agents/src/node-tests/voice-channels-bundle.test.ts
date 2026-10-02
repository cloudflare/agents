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

describe("Voice and Channels bundle isolation", () => {
  it("keeps Voice and Channels out of the main agents entry", async () => {
    const inputs = await bundledInputs("src/index.ts");
    expect(inputs).not.toContain("src/voice/");
    expect(inputs).not.toContain("src/experimental/channels/");
  });

  it("keeps the Voice types entry dependency-light", async () => {
    const inputs = await bundledInputs("src/voice/types.ts");
    expect(inputs).not.toContain("partysocket");
    expect(inputs).not.toMatch(/(^|[/+])react([/@+]|$)/);
    expect(inputs).not.toContain("src/voice/client.ts");
    expect(inputs).not.toContain("src/voice/index.ts");
  });

  it("keeps React out of the framework-neutral Voice client", async () => {
    const inputs = await bundledInputs("src/voice/client.ts");
    expect(inputs).toContain("partysocket");
    expect(inputs).not.toMatch(/(^|[/+])react([/@+]|$)/);
    expect(inputs).not.toContain("src/voice/react.tsx");
    expect(inputs).not.toContain("src/voice/index.ts");
  });

  it("keeps individual Channels and AI frameworks out of Channels core", async () => {
    const inputs = await bundledInputs("src/experimental/channels/index.ts");
    expect(inputs).not.toContain("postal-mime");
    expect(inputs).not.toMatch(/node_modules[/+](ai|@tanstack)/);
    for (const channel of ["slack", "telegram", "email"]) {
      expect(inputs).not.toContain(`src/experimental/channels/${channel}/`);
    }
    // The gateway reads the Web Channel's identity header, nothing more.
    expect(inputs).not.toContain("src/experimental/channels/web/channel.ts");
    expect(inputs).not.toContain("src/voice/");
  });

  it("confines MIME parsing to the Channels email entry", async () => {
    const inputs = await bundledInputs(
      "src/experimental/channels/email/index.ts"
    );
    expect(inputs).toContain("postal-mime");
    expect(inputs).not.toContain("src/experimental/channels/slack/");
    expect(inputs).not.toContain("src/experimental/channels/telegram/");
  });
});
