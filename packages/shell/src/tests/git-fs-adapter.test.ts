/**
 * Unit tests for the git fs adapter (createGitFs).
 *
 * Uses InMemoryFs so these run without a Durable Object or network access.
 */

import { describe, expect, it } from "vitest";
import { InMemoryFs } from "../fs/in-memory-fs";
import { createGitFs } from "../git/fs-adapter";

function setup() {
  const fs = new InMemoryFs();
  const gitFs = createGitFs(fs).promises;
  return { fs, gitFs };
}

describe("createGitFs", () => {
  describe("unlink", () => {
    it("deletes an existing file", async () => {
      const { fs, gitFs } = setup();
      await fs.writeFile("/file.txt", "content");
      await gitFs.unlink("/file.txt");
      await expect(fs.exists("/file.txt")).resolves.toBe(false);
    });

    it("throws with code ENOENT for missing files", async () => {
      const { gitFs } = setup();
      try {
        await gitFs.unlink("/nonexistent.txt");
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error & { code: string }).code).toBe("ENOENT");
      }
    });
  });
});
