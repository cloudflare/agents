import { describe, expect, it } from "vitest";
import {
  createArchive,
  createCompressedArchive,
  createBzip2CompressedArchive,
  createXzCompressedArchive,
  createZstdCompressedArchive,
  parseArchive,
  parseCompressedArchive,
  parseBzip2CompressedArchive,
  parseXzCompressedArchive,
  parseZstdCompressedArchive,
  isGzipCompressed,
  isBzip2Compressed,
  isXzCompressed,
  isZstdCompressed
} from "./archive";
import type { TarCreateEntry } from "./archive";

describe("tar archive pure JS implementation", () => {
  // ── createArchive / parseArchive round-trip ───────────────────────

  describe("createArchive + parseArchive", () => {
    it("should round-trip a single file", async () => {
      const entries: TarCreateEntry[] = [
        { name: "hello.txt", content: "Hello, World!" }
      ];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe("hello.txt");
      expect(result.entries[0].type).toBe("file");
      expect(new TextDecoder().decode(result.entries[0].content)).toBe(
        "Hello, World!"
      );
    });

    it("should round-trip multiple files", async () => {
      const entries: TarCreateEntry[] = [
        { name: "a.txt", content: "aaa" },
        { name: "b.txt", content: "bbb" },
        { name: "c.txt", content: "ccc" }
      ];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(3);
      expect(result.entries.map((e) => e.name)).toEqual([
        "a.txt",
        "b.txt",
        "c.txt"
      ]);
    });

    it("should round-trip an empty file", async () => {
      const entries: TarCreateEntry[] = [{ name: "empty.txt", content: "" }];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].size).toBe(0);
      expect(result.entries[0].content.length).toBe(0);
    });

    it("should round-trip a directory entry", async () => {
      const entries: TarCreateEntry[] = [
        { name: "mydir", isDirectory: true },
        { name: "mydir/file.txt", content: "inside" }
      ];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].name).toBe("mydir/");
      expect(result.entries[0].type).toBe("directory");
      expect(result.entries[1].name).toBe("mydir/file.txt");
      expect(result.entries[1].type).toBe("file");
    });

    it("should round-trip a symlink entry", async () => {
      const entries: TarCreateEntry[] = [
        { name: "link.txt", isSymlink: true, linkTarget: "target.txt" }
      ];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].type).toBe("symlink");
      expect(result.entries[0].linkTarget).toBe("target.txt");
      expect(result.entries[0].size).toBe(0);
    });

    it("should preserve file permissions", async () => {
      const entries: TarCreateEntry[] = [
        { name: "exec.sh", content: "#!/bin/sh", mode: 0o755 },
        { name: "readonly.txt", content: "data", mode: 0o444 }
      ];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.entries[0].mode).toBe(0o755);
      expect(result.entries[1].mode).toBe(0o444);
    });

    it("should use default permissions", async () => {
      const archive = await createArchive([
        { name: "file.txt", content: "data" },
        { name: "dir/", isDirectory: true }
      ]);
      const result = await parseArchive(archive);
      expect(result.entries[0].mode).toBe(0o644);
      expect(result.entries[1].mode).toBe(0o755);
    });

    it("should round-trip binary content (Uint8Array)", async () => {
      const binary = new Uint8Array([0, 1, 127, 128, 254, 255]);
      const archive = await createArchive([
        { name: "binary.bin", content: binary }
      ]);
      const result = await parseArchive(archive);
      expect(result.entries[0].content).toEqual(binary);
    });

    it("should round-trip large content", async () => {
      const content = "x".repeat(10000);
      const archive = await createArchive([{ name: "large.txt", content }]);
      const result = await parseArchive(archive);
      expect(new TextDecoder().decode(result.entries[0].content)).toBe(content);
    });

    it("should preserve mtime", async () => {
      const mtime = new Date("2024-01-15T12:00:00Z");
      const archive = await createArchive([
        { name: "dated.txt", content: "data", mtime }
      ]);
      const result = await parseArchive(archive);
      // mtime is stored as seconds, so we lose sub-second precision
      expect(result.entries[0].mtime.getTime()).toBe(
        Math.floor(mtime.getTime() / 1000) * 1000
      );
    });

    it("should preserve uid/gid", async () => {
      const archive = await createArchive([
        { name: "owned.txt", content: "data", uid: 1000, gid: 1000 }
      ]);
      const result = await parseArchive(archive);
      expect(result.entries[0].uid).toBe(1000);
      expect(result.entries[0].gid).toBe(1000);
    });
  });

  // ── parseArchive edge cases ───────────────────────────────────────

  describe("parseArchive edge cases", () => {
    it("should reject data that is too small", async () => {
      const result = await parseArchive(new Uint8Array(100));
      expect(result.error).toContain("Invalid tar archive format");
    });

    it("should reject data not aligned to 512-byte blocks", async () => {
      const result = await parseArchive(new Uint8Array(513));
      expect(result.error).toContain("Invalid tar archive format");
    });

    it("should handle an empty archive (all zero blocks)", async () => {
      const result = await parseArchive(new Uint8Array(1024));
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(0);
    });

    it("should reject archive larger than 100MB", async () => {
      // We won't allocate 100MB — just test the guard by checking
      // the error message construction
      const huge = new Uint8Array(100 * 1024 * 1024 + 512);
      const result = await parseArchive(huge);
      expect(result.error).toContain("too large");
    });
  });

  // ── Gzip compression (CompressionStream) ──────────────────────────

  describe("gzip compression", () => {
    it("should round-trip through createCompressedArchive / parseCompressedArchive", async () => {
      const entries: TarCreateEntry[] = [
        { name: "gz.txt", content: "gzip compressed data" }
      ];
      const compressed = await createCompressedArchive(entries);
      // Should start with gzip magic bytes
      expect(isGzipCompressed(compressed)).toBe(true);

      const result = await parseCompressedArchive(compressed);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(1);
      expect(new TextDecoder().decode(result.entries[0].content)).toBe(
        "gzip compressed data"
      );
    });

    it("should produce smaller output for compressible data", async () => {
      const content = "a".repeat(10000);
      const entries: TarCreateEntry[] = [{ name: "compressible.txt", content }];
      const uncompressed = await createArchive(entries);
      const compressed = await createCompressedArchive(entries);
      expect(compressed.length).toBeLessThan(uncompressed.length);
    });

    it("should handle multiple files in compressed archive", async () => {
      const entries: TarCreateEntry[] = [
        { name: "dir/", isDirectory: true },
        { name: "dir/a.txt", content: "aaa" },
        { name: "dir/b.txt", content: "bbb" }
      ];
      const compressed = await createCompressedArchive(entries);
      const result = await parseCompressedArchive(compressed);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(3);
    });

    it("should return error for invalid gzip data", async () => {
      const badData = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
      const result = await parseCompressedArchive(badData);
      expect(result.error).toContain("Decompression failed");
    });
  });

  // ── Magic byte detection ──────────────────────────────────────────

  describe("compression detection", () => {
    it("should detect gzip magic bytes", () => {
      expect(isGzipCompressed(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
      expect(isGzipCompressed(new Uint8Array([0x1f, 0x8b]))).toBe(true);
      expect(isGzipCompressed(new Uint8Array([0x1f]))).toBe(false);
      expect(isGzipCompressed(new Uint8Array([0x00, 0x8b]))).toBe(false);
    });

    it("should detect bzip2 magic bytes", () => {
      expect(isBzip2Compressed(new Uint8Array([0x42, 0x5a, 0x68, 0x39]))).toBe(
        true
      );
      expect(isBzip2Compressed(new Uint8Array([0x42, 0x5a]))).toBe(false);
      expect(isBzip2Compressed(new Uint8Array([0x00, 0x5a, 0x68]))).toBe(false);
    });

    it("should detect xz magic bytes", () => {
      expect(
        isXzCompressed(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))
      ).toBe(true);
      expect(
        isXzCompressed(new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a]))
      ).toBe(false);
      expect(isXzCompressed(new Uint8Array([0x00]))).toBe(false);
    });

    it("should detect zstd magic bytes", () => {
      expect(isZstdCompressed(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))).toBe(
        true
      );
      expect(isZstdCompressed(new Uint8Array([0x28, 0xb5, 0x2f]))).toBe(false);
      expect(isZstdCompressed(new Uint8Array([0x00, 0xb5, 0x2f, 0xfd]))).toBe(
        false
      );
    });

    it("should return false for empty data", () => {
      const empty = new Uint8Array(0);
      expect(isGzipCompressed(empty)).toBe(false);
      expect(isBzip2Compressed(empty)).toBe(false);
      expect(isXzCompressed(empty)).toBe(false);
      expect(isZstdCompressed(empty)).toBe(false);
    });
  });

  // ── Unsupported compression formats ───────────────────────────────

  describe("unsupported compression", () => {
    it("createBzip2CompressedArchive throws", async () => {
      await expect(
        createBzip2CompressedArchive([{ name: "t.txt", content: "d" }])
      ).rejects.toThrow("not supported");
    });

    it("createXzCompressedArchive throws", async () => {
      await expect(
        createXzCompressedArchive([{ name: "t.txt", content: "d" }])
      ).rejects.toThrow("not supported");
    });

    it("createZstdCompressedArchive throws", async () => {
      await expect(
        createZstdCompressedArchive([{ name: "t.txt", content: "d" }])
      ).rejects.toThrow("not supported");
    });

    it("parseBzip2CompressedArchive returns error", async () => {
      const result = await parseBzip2CompressedArchive(new Uint8Array([1]));
      expect(result.entries).toEqual([]);
      expect(result.error).toContain("not supported");
    });

    it("parseXzCompressedArchive returns error", async () => {
      const result = await parseXzCompressedArchive(new Uint8Array([1]));
      expect(result.entries).toEqual([]);
      expect(result.error).toContain("not supported");
    });

    it("parseZstdCompressedArchive returns error", async () => {
      const result = await parseZstdCompressedArchive(new Uint8Array([1]));
      expect(result.entries).toEqual([]);
      expect(result.error).toContain("not supported");
    });
  });

  // ── PAX extended headers (long filenames) ──────────────────────────

  describe("PAX extended headers", () => {
    it("should round-trip a filename longer than 99 chars", async () => {
      const longName = "dir/" + "a".repeat(150) + ".txt";
      const entries: TarCreateEntry[] = [
        { name: longName, content: "long name content" }
      ];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe(longName);
      expect(new TextDecoder().decode(result.entries[0].content)).toBe(
        "long name content"
      );
    });

    it("should round-trip a symlink with long target", async () => {
      const longTarget = "dir/" + "b".repeat(150) + ".txt";
      const entries: TarCreateEntry[] = [
        { name: "link.txt", isSymlink: true, linkTarget: longTarget }
      ];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].type).toBe("symlink");
      expect(result.entries[0].linkTarget).toBe(longTarget);
    });

    it("should round-trip both long name and long link target", async () => {
      const longName = "x".repeat(120) + ".link";
      const longTarget = "y".repeat(120) + ".txt";
      const entries: TarCreateEntry[] = [
        { name: longName, isSymlink: true, linkTarget: longTarget }
      ];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.entries[0].name).toBe(longName);
      expect(result.entries[0].linkTarget).toBe(longTarget);
    });

    it("should not emit PAX for names <= 99 chars", async () => {
      const shortName = "a".repeat(99);
      const archive = await createArchive([{ name: shortName, content: "x" }]);
      // Without PAX: header (512) + body (512) + end (1024) = 2048
      // With PAX: would be larger due to extra PAX header block
      expect(archive.length).toBe(2048);
    });

    it("should emit PAX for names > 99 chars", async () => {
      const longName = "a".repeat(100);
      const archive = await createArchive([{ name: longName, content: "x" }]);
      // With PAX: PAX header (512) + PAX body (512) + entry header (512) + body (512) + end (1024) = 3072
      expect(archive.length).toBeGreaterThan(2048);
    });

    it("should handle long directory name", async () => {
      const longDir = "d".repeat(150) + "/";
      const entries: TarCreateEntry[] = [{ name: longDir, isDirectory: true }];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.entries[0].name).toBe(longDir);
      expect(result.entries[0].type).toBe("directory");
    });

    it("should round-trip mixed short and long names", async () => {
      const entries: TarCreateEntry[] = [
        { name: "short.txt", content: "short" },
        { name: "a".repeat(200) + ".txt", content: "long" },
        { name: "another-short.txt", content: "also short" }
      ];
      const archive = await createArchive(entries);
      const result = await parseArchive(archive);
      expect(result.entries).toHaveLength(3);
      expect(result.entries[0].name).toBe("short.txt");
      expect(result.entries[1].name).toBe("a".repeat(200) + ".txt");
      expect(result.entries[2].name).toBe("another-short.txt");
    });

    it("should round-trip long names through gzip compression", async () => {
      const longName = "compressed/" + "z".repeat(200) + ".dat";
      const entries: TarCreateEntry[] = [
        { name: longName, content: "compressed long name" }
      ];
      const compressed = await createCompressedArchive(entries);
      const result = await parseCompressedArchive(compressed);
      expect(result.error).toBeUndefined();
      expect(result.entries[0].name).toBe(longName);
    });
  });

  // ── USTAR header format ───────────────────────────────────────────

  describe("USTAR header format", () => {
    it("should produce valid USTAR magic in header", async () => {
      const archive = await createArchive([{ name: "test.txt", content: "x" }]);
      // USTAR magic at offset 257: "ustar"
      const magic = new TextDecoder().decode(archive.subarray(257, 262));
      expect(magic).toBe("ustar");
    });

    it("should write correct checksum", async () => {
      const archive = await createArchive([
        { name: "checksum.txt", content: "verify" }
      ]);
      // Verify by re-parsing (parse validates structure implicitly)
      const result = await parseArchive(archive);
      expect(result.error).toBeUndefined();
      expect(result.entries).toHaveLength(1);
    });

    it("should end with two zero blocks", async () => {
      const archive = await createArchive([{ name: "end.txt", content: "x" }]);
      const endBlocks = archive.subarray(archive.length - 1024);
      expect(endBlocks.every((b) => b === 0)).toBe(true);
    });

    it("should pad file content to 512-byte boundary", async () => {
      const archive = await createArchive([
        { name: "pad.txt", content: "short" }
      ]);
      // Header (512) + padded content (512) + 2 end blocks (1024) = 2048
      expect(archive.length).toBe(2048);
    });

    it("should handle content exactly at block boundary", async () => {
      const content = "x".repeat(512);
      const archive = await createArchive([{ name: "exact.txt", content }]);
      // Header (512) + content (512) + 2 end blocks (1024) = 2048
      expect(archive.length).toBe(2048);
    });

    it("should handle content just over block boundary", async () => {
      const content = "x".repeat(513);
      const archive = await createArchive([{ name: "over.txt", content }]);
      // Header (512) + padded content (1024) + 2 end blocks (1024) = 2560
      expect(archive.length).toBe(2560);
    });
  });
});
