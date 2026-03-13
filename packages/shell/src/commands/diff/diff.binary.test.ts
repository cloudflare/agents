import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("diff with binary data", () => {
  describe("binary file comparison", () => {
    it("should detect identical binary files", async () => {
      const env = new Bash({
        files: {
          "/a.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff]),
          "/b.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff])
        }
      });

      const result = await env.exec("diff /a.bin /b.bin");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("should handle files with null bytes - identical", async () => {
      const env = new Bash({
        files: {
          "/a.bin": new Uint8Array([0x41, 0x00, 0x42]),
          "/b.bin": new Uint8Array([0x41, 0x00, 0x42])
        }
      });

      const result = await env.exec("diff /a.bin /b.bin");

      expect(result.exitCode).toBe(0);
    });

    it("should detect difference in files with null bytes", async () => {
      const env = new Bash({
        files: {
          "/a.bin": new Uint8Array([0x41, 0x00, 0x42]),
          "/b.bin": new Uint8Array([0x41, 0x00, 0x43])
        }
      });

      const result = await env.exec("diff /a.bin /b.bin");

      expect(result.exitCode).toBe(1);
    });

    it("should detect difference in text files with high bytes", async () => {
      const env = new Bash({
        files: {
          // Single line of text with high bytes
          "/a.txt": "hello\x80world\n",
          "/b.txt": "hello\x81world\n"
        }
      });

      const result = await env.exec("diff /a.txt /b.txt");

      expect(result.exitCode).toBe(1);
    });
  });

  describe("binary stdin comparison", () => {
    it("should detect difference with binary stdin", async () => {
      const env = new Bash({
        files: {
          "/a.bin": new Uint8Array([0x80, 0x91, 0xa0]),
          "/b.bin": new Uint8Array([0x80, 0x90, 0xa0])
        }
      });

      const result = await env.exec("cat /a.bin | diff - /b.bin");

      expect(result.exitCode).toBe(1);
    });
  });
});
