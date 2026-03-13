import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";
import {
  createArchive,
  createXzCompressedArchive,
  createZstdCompressedArchive,
  parseXzCompressedArchive,
  parseZstdCompressedArchive
} from "./archive";

describe("tar security hardening", () => {
  it("blocks parent-traversal entries on extract by default", async () => {
    const env = new Bash();
    const archive = await createArchive([
      { name: "../escaped.txt", content: "escape-attempt" }
    ]);
    await env.fs.writeFile("/attack.tar", archive);

    const result = await env.exec(
      "mkdir /safe && tar -xf /attack.tar -C /safe"
    );

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("tar: ../escaped.txt: Path contains '..'\n");
    expect(result.exitCode).toBe(2);
    expect(await env.fs.exists("/escaped.txt")).toBe(false);
    expect(await env.fs.exists("/safe/escaped.txt")).toBe(false);
  });

  it("strips leading slash from archive entries by default", async () => {
    const env = new Bash();
    const archive = await createArchive([{ name: "/abs.txt", content: "abs" }]);
    await env.fs.writeFile("/abs.tar", archive);

    const result = await env.exec("mkdir /safe && tar -xf /abs.tar -C /safe");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await env.fs.exists("/safe/abs.txt")).toBe(true);
    expect(await env.fs.exists("/abs.txt")).toBe(false);
  });

  it("allows absolute archive extraction with -P/--absolute-names", async () => {
    const env = new Bash();
    const archive = await createArchive([{ name: "/abs.txt", content: "abs" }]);
    await env.fs.writeFile("/abs.tar", archive);

    const result = await env.exec("mkdir /safe && tar -xPf /abs.tar -C /safe");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(await env.fs.exists("/abs.txt")).toBe(true);
    expect(await env.fs.exists("/safe/abs.txt")).toBe(false);
  });

  it("blocks unsafe symlink targets by default", async () => {
    const env = new Bash();
    const archive = await createArchive([
      { name: "link.txt", isSymlink: true, linkTarget: "../outside" }
    ]);
    await env.fs.writeFile("/link.tar", archive);

    const result = await env.exec("mkdir /safe && tar -xf /link.tar -C /safe");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("tar: link.txt: unsafe symlink target\n");
    expect(result.exitCode).toBe(2);
    expect(await env.fs.exists("/safe/link.txt")).toBe(false);
  });

  it("blocks xz encode and decode (requires native addons)", async () => {
    const env = new Bash({
      files: {
        "/payload.bin": new Uint8Array([
          0x00, 0x01, 0x02, 0x03, 0x7f, 0x80, 0xff, 0xfe
        ])
      }
    });

    // Encode (create) should be blocked
    const createResult = await env.exec(
      "tar -cJf /payload.tar.xz /payload.bin"
    );
    expect(createResult.stderr).toContain("not supported");
    expect(createResult.exitCode).not.toBe(0);
  });

  // Direct unit tests for archive-level native codec gates
  it("createXzCompressedArchive rejects (requires native addons)", async () => {
    const entries = [{ name: "test.txt", content: "data" }];
    await expect(createXzCompressedArchive(entries)).rejects.toThrow(
      "not supported"
    );
  });

  it("createZstdCompressedArchive rejects (requires native addons)", async () => {
    const entries = [{ name: "test.txt", content: "data" }];
    await expect(createZstdCompressedArchive(entries)).rejects.toThrow(
      "not supported"
    );
  });

  it("parseXzCompressedArchive rejects (requires native addons)", async () => {
    const result = await parseXzCompressedArchive(new Uint8Array([1, 2, 3]));
    expect(result.entries).toEqual([]);
    expect(result.error).toContain("not supported");
  });

  it("parseZstdCompressedArchive rejects (requires native addons)", async () => {
    const result = await parseZstdCompressedArchive(new Uint8Array([1, 2, 3]));
    expect(result.entries).toEqual([]);
    expect(result.error).toContain("not supported");
  });
});
