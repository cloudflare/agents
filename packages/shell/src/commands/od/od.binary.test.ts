import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("od with binary data", () => {
  describe("binary file dump", () => {
    it("should dump binary file with high bytes", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff])
        }
      });

      const result = await env.exec("od /binary.bin");

      expect(result.exitCode).toBe(0);
      // od outputs octal by default
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stdout).toContain("0000000"); // address
    });

    it("should dump binary file with null bytes", async () => {
      const env = new Bash({
        files: {
          "/nulls.bin": new Uint8Array([0x00, 0x00, 0x41, 0x42])
        }
      });

      const result = await env.exec("od -c /nulls.bin");

      expect(result.exitCode).toBe(0);
      // od -c shows characters, \0 for null
      expect(result.stdout).toContain("\\0");
      expect(result.stdout).toContain("A");
      expect(result.stdout).toContain("B");
    });

    it("should dump all byte values with default format", async () => {
      const env = new Bash({
        files: {
          "/allbytes.bin": new Uint8Array(
            Array.from({ length: 16 }, (_, i) => i * 16)
          )
        }
      });

      const result = await env.exec("od /allbytes.bin");

      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });
  });

  describe("binary stdin dump", () => {
    it("should dump binary data from stdin", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x90, 0xab])
        }
      });

      const result = await env.exec("cat /binary.bin | od");

      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("should dump piped binary with character format", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x41, 0x42, 0x43, 0x44]) // ABCD
        }
      });

      const result = await env.exec("cat /binary.bin | od -c");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("A");
      expect(result.stdout).toContain("B");
      expect(result.stdout).toContain("C");
      expect(result.stdout).toContain("D");
    });
  });
});
