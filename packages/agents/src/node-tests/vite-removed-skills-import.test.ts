import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { build } from "vite";
import agents from "../vite";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agents-vite-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function bundle(source: string): Promise<void> {
  const entry = join(dir, "entry.js");
  await writeFile(entry, source);
  await build({
    root: dir,
    configFile: false,
    logLevel: "silent",
    plugins: [agents()],
    build: {
      write: false,
      lib: { entry, formats: ["es"], fileName: "entry" }
    }
  });
}

describe("agents vite plugin", () => {
  it("explains that the agents:skills import was removed", async () => {
    for (const specifier of ["agents:skills", "agents:skills/product"]) {
      await expect(
        bundle(`import skills from "${specifier}";\nconsole.log(skills);\n`),
        specifier
      ).rejects.toThrow(
        /"agents:skills" import has been removed.*skills\.workspace\(this\.workspace\)/
      );
    }
  });

  it("still builds code that does not import agents:skills", async () => {
    await expect(bundle("console.log('ok');\n")).resolves.toBeUndefined();
  });
});
