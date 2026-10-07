import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "../../protocol";
import { FileMirror } from "../file-mirror";

function home() {
  return mkdtemp(join(tmpdir(), "mirror-"));
}

/** Write a file under `root`, creating its directories. */
async function put(root: string, path: string, content: string | Buffer) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

describe("FileMirror", () => {
  it("ships new files whole, then only what they gained", async () => {
    const root = await home();
    const mirror = new FileMirror(root, ["state"]);
    await mirror.restore([]);
    await put(root, "state/nested/log.jsonl", "a\n");
    const first = await mirror.collect();
    expect(first).toEqual([
      {
        kind: "file",
        path: "state/nested/log.jsonl",
        offset: 0,
        data: Buffer.from("a\n").toString("base64")
      }
    ]);
    expect(await mirror.collect()).toEqual([]);
    await appendFile(join(root, "state", "nested", "log.jsonl"), "b\n");
    expect(await mirror.collect()).toMatchObject([
      { offset: 2, data: Buffer.from("b\n").toString("base64") }
    ]);
  });

  it("ships a shrunk file whole, and splits large changes into pieces", async () => {
    const root = await home();
    const mirror = new FileMirror(root, ["state"]);
    await mirror.restore([]);
    const file = join(root, "state", "big");
    await put(root, "state/big", Buffer.alloc(300 * 1024, 1));
    const pieces = await mirror.collect();
    expect(pieces.map((p) => p.offset)).toEqual([0, 128 * 1024, 256 * 1024]);
    await writeFile(file, "small");
    expect(await mirror.collect()).toMatchObject([{ offset: 0 }]);
  });

  it("restores entries into an empty home, replacing what was there", async () => {
    const source = await home();
    const out = new FileMirror(source, ["state"]);
    await out.restore([]);
    const file = join(source, "state", "nested", "log.jsonl");
    await put(source, "state/nested/log.jsonl", "one\n");
    const entries: JsonValue[] = [...(await out.collect())];
    await appendFile(file, "two\n");
    entries.push(...(await out.collect()));

    const target = await home();
    await put(target, "state/stale", "old");
    const back = new FileMirror(target, ["state"]);
    await back.restore([...entries, { kind: "state", values: {} }]);
    expect(
      await readFile(join(target, "state", "nested", "log.jsonl"), "utf8")
    ).toBe("one\ntwo\n");
    await expect(readFile(join(target, "state", "stale"))).rejects.toThrow();
    // Restored bytes are not shipped again.
    expect(await back.collect()).toEqual([]);
  });

  it("ignores entries that would escape the home", async () => {
    const root = await home();
    const mirror = new FileMirror(root, ["state"]);
    await mirror.restore([
      { kind: "file", path: "../escape", offset: 0, data: "eA==" }
    ]);
    await expect(readFile(join(root, "..", "escape"))).rejects.toThrow();
  });
});
