import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("checksum commands with binary data", () => {
  describe("md5sum", () => {
    it("should compute md5sum of binary file with high bytes", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff])
        }
      });

      const result = await env.exec("md5sum /binary.bin");
      expect(result.exitCode).toBe(0);
      // The hash should be consistent for the same input
      expect(result.stdout).toMatch(/^[a-f0-9]{32}\s+/);
      expect(result.stdout).toContain("binary.bin");
    });

    it("should compute md5sum of file with null bytes", async () => {
      const env = new Bash({
        files: {
          "/nulls.bin": new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43])
        }
      });

      const result = await env.exec("md5sum /nulls.bin");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{32}\s+/);
      expect(result.stdout).toContain("nulls.bin");
    });

    it("should compute md5sum from stdin with binary data", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x90, 0xab])
        }
      });

      const result = await env.exec("cat /binary.bin | md5sum");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{32}\s+/);
    });

    it("should produce same hash for same binary content", async () => {
      const env = new Bash({
        files: {
          "/a.bin": new Uint8Array([0x80, 0x90, 0xa0]),
          "/b.bin": new Uint8Array([0x80, 0x90, 0xa0])
        }
      });

      const resultA = await env.exec("md5sum /a.bin");
      const resultB = await env.exec("md5sum /b.bin");

      const hashA = resultA.stdout.split(/\s+/)[0];
      const hashB = resultB.stdout.split(/\s+/)[0];
      expect(hashA).toBe(hashB);
    });
  });

  describe("sha256sum", () => {
    it("should compute sha256sum of binary file", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff])
        }
      });

      const result = await env.exec("sha256sum /binary.bin");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{64}\s+/);
      expect(result.stdout).toContain("binary.bin");
    });

    it("should compute sha256sum from stdin", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x90, 0xab])
        }
      });

      const result = await env.exec("cat /binary.bin | sha256sum");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{64}\s+/);
    });

    it("should handle all byte values", async () => {
      const env = new Bash({
        files: {
          "/allbytes.bin": new Uint8Array(
            Array.from({ length: 256 }, (_, i) => i)
          )
        }
      });

      const result = await env.exec("sha256sum /allbytes.bin");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{64}\s+/);
      expect(result.stdout).toContain("allbytes.bin");
    });
  });

  describe("sha1sum", () => {
    it("should compute sha1sum of binary file", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff])
        }
      });

      const result = await env.exec("sha1sum /binary.bin");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{40}\s+/);
      expect(result.stdout).toContain("binary.bin");
    });

    it("should compute sha1sum from stdin", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x90, 0xab])
        }
      });

      const result = await env.exec("cat /binary.bin | sha1sum");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{40}\s+/);
    });
  });

  describe("UTF-8 content", () => {
    it("should compute md5sum of UTF-8 file", async () => {
      const env = new Bash({
        files: {
          "/unicode.txt": "Hello 中文 日本語"
        }
      });

      const result = await env.exec("md5sum /unicode.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{32}\s+/);
      expect(result.stdout).toContain("unicode.txt");
    });

    it("should compute sha256sum of UTF-8 from stdin", async () => {
      const env = new Bash({
        files: {
          "/unicode.txt": "🚀🎉🔥"
        }
      });

      const result = await env.exec("cat /unicode.txt | sha256sum");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^[a-f0-9]{64}\s+/);
    });

    it("should produce same hash for same UTF-8 content", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "Привет мир",
          "/b.txt": "Привет мир"
        }
      });

      const resultA = await env.exec("md5sum /a.txt");
      const resultB = await env.exec("md5sum /b.txt");

      const hashA = resultA.stdout.split(/\s+/)[0];
      const hashB = resultB.stdout.split(/\s+/)[0];
      expect(hashA).toBe(hashB);
    });
  });

  describe("check mode with binary files", () => {
    it("should verify binary file checksum", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0])
        }
      });

      await env.exec("md5sum /binary.bin > /checksums.txt");
      const result = await env.exec("md5sum -c /checksums.txt");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    });

    it("should detect modified binary file", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0])
        }
      });

      await env.exec("md5sum /binary.bin > /checksums.txt");
      // Modify the file
      await env.exec("printf '\\x81\\x90\\xa0' > /binary.bin");
      const result = await env.exec("md5sum -c /checksums.txt");

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("FAILED");
    });
  });
});
