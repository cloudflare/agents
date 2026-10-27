import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build, type Rolldown } from "vite";
import agents from "../vite";

const SOURCE = `// A comment with an em dash — and an arrow →
export const dash = "a — b";
export const template = \`x → \${dash}\`;
export const emoji = "🙂";
export const pattern = /[—→]/u;
export const latin1 = "café";
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agents-latin1-"));
  await writeFile(join(dir, "entry.js"), SOURCE);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function buildEntry(
  ssr: boolean,
  options?: Parameters<typeof agents>[0]
): Promise<string> {
  const result = await build({
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins: [agents(options)],
    build: {
      ssr,
      write: false,
      minify: false,
      rollupOptions: {
        input: join(dir, "entry.js"),
        output: { format: "es" },
        preserveEntrySignatures: "strict"
      }
    }
  });
  const outputs = (
    Array.isArray(result) ? result : [result]
  ) as Rolldown.RolldownOutput[];
  const chunk = outputs[0].output.find((output) => output.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("no chunk built");
  return chunk.code;
}

async function evaluate(code: string): Promise<Record<string, unknown>> {
  const file = join(dir, `out-${Date.now()}.mjs`);
  await writeFile(file, code);
  return (await import(file)) as Record<string, unknown>;
}

describe("agents vite plugin: non-Latin-1 escaping", () => {
  it("leaves no character above U+00FF in server chunks", async () => {
    const code = await buildEntry(true);
    expect(code).not.toMatch(/[\u0100-\uffff]/);
    expect(code).toContain("café");
  });

  it("keeps string, template and regex values", async () => {
    const module = await evaluate(await buildEntry(true));
    expect(module.dash).toBe("a — b");
    expect(module.template).toBe("x → a — b");
    expect(module.emoji).toBe("🙂");
    expect((module.pattern as RegExp).test("→")).toBe(true);
    expect(module.latin1).toBe("café");
  });

  it("leaves client chunks alone", async () => {
    const code = await buildEntry(false);
    expect(code).toContain("—");
  });

  it("can be turned off", async () => {
    const code = await buildEntry(true, { escapeNonLatin1: false });
    expect(code).toContain("—");
  });
});
