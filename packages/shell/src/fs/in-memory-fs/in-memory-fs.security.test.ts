/**
 * Security tests for InMemoryFs symlink handling
 *
 * InMemoryFs is inherently safe from real-filesystem escape attacks,
 * but must handle symlink loops, path traversal via symlinks, and
 * ensure consistent behavior across all operations.
 */

import { describe, expect, it } from "vitest";
import { InMemoryFs } from "./in-memory-fs";

describe("InMemoryFs Security - Symlink Handling", () => {
  describe("circular symlink protection", () => {
    it("should handle self-referential symlinks", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/self", "/self");
      await expect(fs.readFile("/self")).rejects.toThrow("ELOOP");
    });

    it("should handle mutual circular symlinks", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/link2", "/link1");
      await fs.symlink("/link1", "/link2");
      await expect(fs.readFile("/link1")).rejects.toThrow("ELOOP");
      await expect(fs.readFile("/link2")).rejects.toThrow("ELOOP");
    });

    it("should handle circular symlinks via stat", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/link2", "/link1");
      await fs.symlink("/link1", "/link2");
      await expect(fs.stat("/link1")).rejects.toThrow("ELOOP");
    });

    it("should handle circular symlinks via exists", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/link2", "/link1");
      await fs.symlink("/link1", "/link2");
      // exists should return false for circular symlinks, not hang
      expect(await fs.exists("/link1")).toBe(false);
    });

    it("should handle three-way circular symlinks", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/b", "/a");
      await fs.symlink("/c", "/b");
      await fs.symlink("/a", "/c");
      await expect(fs.readFile("/a")).rejects.toThrow("ELOOP");
    });

    it("should handle circular symlinks via realpath", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/link2", "/link1");
      await fs.symlink("/link1", "/link2");
      await expect(fs.realpath("/link1")).rejects.toThrow("ELOOP");
    });
  });

  describe("symlink path traversal", () => {
    it("should follow symlink to valid file", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "content"
      });
      await fs.symlink("/target.txt", "/link");

      const content = await fs.readFile("/link");
      expect(content).toBe("content");
    });

    it("should follow relative symlink to valid file", async () => {
      const fs = new InMemoryFs({
        "/dir/target.txt": "content"
      });
      await fs.symlink("target.txt", "/dir/link");

      const content = await fs.readFile("/dir/link");
      expect(content).toBe("content");
    });

    it("should follow symlink with .. that stays within filesystem", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "root content"
      });
      await fs.mkdir("/subdir");
      await fs.symlink("../target.txt", "/subdir/link");

      const content = await fs.readFile("/subdir/link");
      expect(content).toBe("root content");
    });

    it("should handle symlink pointing to non-existent target", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/nonexistent", "/broken-link");

      await expect(fs.readFile("/broken-link")).rejects.toThrow("ENOENT");
    });

    it("should handle chained symlinks", async () => {
      const fs = new InMemoryFs({
        "/real.txt": "real content"
      });
      await fs.symlink("/real.txt", "/link1");
      await fs.symlink("/link1", "/link2");
      await fs.symlink("/link2", "/link3");

      const content = await fs.readFile("/link3");
      expect(content).toBe("real content");
    });

    it("should handle symlink to directory", async () => {
      const fs = new InMemoryFs({
        "/real-dir/file.txt": "nested"
      });
      await fs.symlink("/real-dir", "/dir-link");

      const entries = await fs.readdir("/dir-link");
      expect(entries).toContain("file.txt");
    });

    it("should handle symlink with excessive .. at root", async () => {
      const fs = new InMemoryFs({
        "/file.txt": "content"
      });
      await fs.symlink("../../../file.txt", "/link");

      // Excessive .. should normalize to root
      const content = await fs.readFile("/link");
      expect(content).toBe("content");
    });
  });

  describe("readlink behavior", () => {
    it("should return absolute target as stored", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/target/path", "/link");

      const target = await fs.readlink("/link");
      expect(target).toBe("/target/path");
    });

    it("should return relative target as stored", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("../other/file", "/dir/link");

      const target = await fs.readlink("/dir/link");
      expect(target).toBe("../other/file");
    });

    it("should throw EINVAL for non-symlink", async () => {
      const fs = new InMemoryFs({
        "/regular.txt": "content"
      });

      await expect(fs.readlink("/regular.txt")).rejects.toThrow("EINVAL");
    });

    it("should throw ENOENT for non-existent path", async () => {
      const fs = new InMemoryFs();

      await expect(fs.readlink("/nonexistent")).rejects.toThrow("ENOENT");
    });
  });

  describe("lstat vs stat on symlinks", () => {
    it("should not follow final symlink with lstat", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "content"
      });
      await fs.symlink("/target.txt", "/link");

      const stat = await fs.lstat("/link");
      expect(stat.isSymbolicLink).toBe(true);
      expect(stat.isFile).toBe(false);
    });

    it("should follow final symlink with stat", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "content"
      });
      await fs.symlink("/target.txt", "/link");

      const stat = await fs.stat("/link");
      expect(stat.isSymbolicLink).toBe(false);
      expect(stat.isFile).toBe(true);
    });

    it("should follow intermediate symlinks with lstat", async () => {
      const fs = new InMemoryFs({
        "/real-dir/file.txt": "content"
      });
      await fs.symlink("/real-dir", "/dir-link");

      const stat = await fs.lstat("/dir-link/file.txt");
      // The intermediate symlink /dir-link should be followed,
      // and we should get the stat of the final file
      expect(stat.isFile).toBe(true);
    });
  });

  describe("symlink + write operations", () => {
    it("should overwrite symlink with file on writeFile", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "original"
      });
      await fs.symlink("/target.txt", "/link");

      // InMemoryFs writeFile replaces the symlink entry with a file
      await fs.writeFile("/link", "modified");

      // /link is now a regular file, /target.txt unchanged
      const viaLink = await fs.readFile("/link");
      const viaDirect = await fs.readFile("/target.txt");
      expect(viaLink).toBe("modified");
      expect(viaDirect).toBe("original");
    });

    it("should overwrite symlink with file on appendFile", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "hello"
      });
      await fs.symlink("/target.txt", "/link");

      // appendFile replaces the symlink with a new file entry
      await fs.appendFile("/link", " world");

      // /link is now a regular file with only the appended content
      const content = await fs.readFile("/link");
      expect(content).toBe(" world");
      // /target.txt unchanged
      const original = await fs.readFile("/target.txt");
      expect(original).toBe("hello");
    });
  });

  describe("symlink + rm operations", () => {
    it("should remove the symlink itself, not the target", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "content"
      });
      await fs.symlink("/target.txt", "/link");

      await fs.rm("/link");

      expect(await fs.exists("/target.txt")).toBe(true);
      expect(await fs.exists("/link")).toBe(false);
    });
  });

  describe("path normalization edge cases", () => {
    it("should handle path with only dots and slashes", async () => {
      const fs = new InMemoryFs({
        "/file.txt": "content"
      });

      const content = await fs.readFile("/./file.txt");
      expect(content).toBe("content");
    });

    it("should handle excessive parent traversal via ..", async () => {
      const fs = new InMemoryFs({
        "/file.txt": "content"
      });

      // Should normalize to /file.txt
      const content = await fs.readFile("/a/b/c/../../../file.txt");
      expect(content).toBe("content");
    });

    it("should handle null bytes in path", async () => {
      const fs = new InMemoryFs();
      await expect(fs.readFile("/file\x00.txt")).rejects.toThrow("null byte");
    });

    it("should handle null bytes in symlink operations", async () => {
      const fs = new InMemoryFs();
      await expect(fs.symlink("/target", "/link\x00")).rejects.toThrow(
        "null byte"
      );
      await expect(fs.readlink("/link\x00")).rejects.toThrow("null byte");
    });
  });

  describe("realpath security", () => {
    it("should resolve symlinks to canonical path", async () => {
      const fs = new InMemoryFs({
        "/real/target.txt": "content"
      });
      await fs.symlink("/real/target.txt", "/link");

      const resolved = await fs.realpath("/link");
      expect(resolved).toBe("/real/target.txt");
    });

    it("should resolve chained symlinks", async () => {
      const fs = new InMemoryFs({
        "/final.txt": "content"
      });
      await fs.symlink("/final.txt", "/mid");
      await fs.symlink("/mid", "/start");

      const resolved = await fs.realpath("/start");
      expect(resolved).toBe("/final.txt");
    });

    it("should throw for broken symlink chain", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/nonexistent", "/broken");

      await expect(fs.realpath("/broken")).rejects.toThrow("ENOENT");
    });

    it("should throw ELOOP for circular symlinks in realpath", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/b", "/a");
      await fs.symlink("/a", "/b");

      await expect(fs.realpath("/a")).rejects.toThrow("ELOOP");
    });
  });

  describe("concurrent symlink operations", () => {
    it("should handle concurrent reads through symlinks", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "content"
      });
      await fs.symlink("/target.txt", "/link");

      const results = await Promise.all(
        Array(50)
          .fill(null)
          .map(() => fs.readFile("/link"))
      );

      expect(results.every((r) => r === "content")).toBe(true);
    });

    it("should handle concurrent circular symlink access", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/b", "/a");
      await fs.symlink("/a", "/b");

      const results = await Promise.all(
        Array(20)
          .fill(null)
          .map(() => fs.readFile("/a").catch(() => "blocked"))
      );

      expect(results.every((r) => r === "blocked")).toBe(true);
    });
  });

  describe("cp data integrity", () => {
    it("should deep copy file content (not share buffer reference)", async () => {
      const fs = new InMemoryFs();
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await fs.writeFile("/original.bin", data);

      await fs.cp("/original.bin", "/copy.bin");

      // Modify the original
      await fs.writeFile("/original.bin", new Uint8Array([9, 9, 9]));

      // Copy should still have original content
      const copyContent = await fs.readFileBuffer("/copy.bin");
      expect(copyContent).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it("should copy symlinks during cp", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "content"
      });
      await fs.symlink("/target.txt", "/link");

      await fs.cp("/link", "/link-copy");

      // The copy should be a symlink too
      const stat = await fs.lstat("/link-copy");
      expect(stat.isSymbolicLink).toBe(true);
    });
  });

  describe("base64 encoding with large files", () => {
    it("should handle base64 read of large in-memory file without crashing", async () => {
      const fs = new InMemoryFs();
      const largeContent = "x".repeat(200_000);
      await fs.writeFile("/large.txt", largeContent);

      // Should NOT throw RangeError from String.fromCharCode spread
      const result = await fs.readFile("/large.txt", "base64");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);

      // Verify round-trip
      await fs.writeFile("/decoded.txt", result, "base64");
      const roundTrip = await fs.readFile("/decoded.txt");
      expect(roundTrip).toBe(largeContent);
    });
  });

  describe("error message safety", () => {
    it("should not contain implementation details in ENOENT errors", async () => {
      const fs = new InMemoryFs();
      try {
        await fs.readFile("/missing");
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toContain("ENOENT");
        expect(msg).toContain("/missing");
      }
    });
  });

  describe("empty and whitespace paths", () => {
    it("should treat empty path as root", async () => {
      const fs = new InMemoryFs({
        "/file.txt": "content"
      });
      // Empty path should normalize to /
      const stat = await fs.stat("");
      expect(stat.isDirectory).toBe(true);
    });

    it("should handle whitespace-only filenames", async () => {
      const fs = new InMemoryFs();
      await fs.writeFile("/ ", "space file");
      const content = await fs.readFile("/ ");
      expect(content).toBe("space file");
    });
  });

  describe("test -c character device detection", () => {
    it("should not identify non-device path ending in /dev/null as char device", async () => {
      const fsInstance = new InMemoryFs({
        "/fake/dev/null": "not a device"
      });
      const { Bash } = await import("../../Shell.js");
      const env = new Bash({ fs: fsInstance });
      const result = await env.exec(
        "test -c /fake/dev/null && echo yes || echo no"
      );
      expect(result.stdout.trim()).toBe("no");
    });
  });

  describe("cp preserves symlinks correctly", () => {
    it("should cp symlink as symlink, not follow it", async () => {
      const fs = new InMemoryFs({
        "/dir/target.txt": "target content"
      });
      await fs.symlink("/dir/target.txt", "/dir/link");

      await fs.cp("/dir/link", "/dir/link-copy");

      // Verify the copy is a symlink
      const stat = await fs.lstat("/dir/link-copy");
      expect(stat.isSymbolicLink).toBe(true);

      // Verify it points to the same target
      const target = await fs.readlink("/dir/link-copy");
      expect(target).toBe("/dir/target.txt");
    });

    it("should cp -r directory containing symlinks", async () => {
      const fs = new InMemoryFs({
        "/src/file.txt": "content"
      });
      await fs.symlink("/src/file.txt", "/src/link");

      await fs.cp("/src", "/dest", { recursive: true });

      // File should be copied
      expect(await fs.readFile("/dest/file.txt")).toBe("content");

      // Symlink should be copied as symlink
      const stat = await fs.lstat("/dest/link");
      expect(stat.isSymbolicLink).toBe(true);
    });
  });

  describe("rm on symlinks", () => {
    it("should remove symlink without removing target", async () => {
      const fs = new InMemoryFs({
        "/target.txt": "content"
      });
      await fs.symlink("/target.txt", "/link");

      await fs.rm("/link");

      expect(await fs.exists("/target.txt")).toBe(true);
      expect(await fs.exists("/link")).toBe(false);
    });

    it("should handle rm of broken symlink", async () => {
      const fs = new InMemoryFs();
      await fs.symlink("/nonexistent", "/broken-link");

      await fs.rm("/broken-link");
      expect(await fs.exists("/broken-link")).toBe(false);
    });
  });

  describe("link (hard link) behavior", () => {
    it("should not hard link directories", async () => {
      const fs = new InMemoryFs();
      await fs.mkdir("/dir");

      await expect(fs.link("/dir", "/dir-link")).rejects.toThrow("EPERM");
    });

    it("should not hard link non-existent files", async () => {
      const fs = new InMemoryFs();

      await expect(fs.link("/missing", "/link")).rejects.toThrow("ENOENT");
    });
  });
});
