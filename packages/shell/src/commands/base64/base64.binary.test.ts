import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("base64 with binary data", () => {
  describe("binary file encoding", () => {
    it("should encode binary file with high bytes", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff])
        }
      });

      const result = await env.exec("base64 /binary.bin");
      expect(result.exitCode).toBe(0);
      // Verify it produces valid base64 output
      expect(result.stdout.trim()).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it("should encode and decode file with null bytes", async () => {
      const env = new Bash({
        files: {
          "/nulls.bin": new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43])
        }
      });

      await env.exec("base64 /nulls.bin > /encoded.txt");
      const decodeResult = await env.exec("base64 -d /encoded.txt");

      expect(decodeResult.stdout).toBe("A\0B\0C");
    });

    it("should encode and decode file with all byte values", async () => {
      const env = new Bash({
        files: {
          "/allbytes.bin": new Uint8Array(
            Array.from({ length: 256 }, (_, i) => i)
          )
        }
      });

      await env.exec("base64 /allbytes.bin > /encoded.txt");
      const decodeResult = await env.exec("base64 -d /encoded.txt");

      expect(decodeResult.stdout.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(decodeResult.stdout.charCodeAt(i)).toBe(i);
      }
    });
  });

  describe("binary stdin piping", () => {
    it("should encode binary data from stdin", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x90, 0xab])
        }
      });

      const result = await env.exec("cat /binary.bin | base64");
      // Verify it encodes without error
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
    });

    it("should round-trip binary data through stdin", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x90, 0xab, 0xcd])
        }
      });

      await env.exec("cat /binary.bin | base64 > /encoded.txt");
      const result = await env.exec("base64 -d /encoded.txt");

      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0xff);
      expect(result.stdout.charCodeAt(2)).toBe(0x90);
      expect(result.stdout.charCodeAt(3)).toBe(0xab);
      expect(result.stdout.charCodeAt(4)).toBe(0xcd);
    });

    it("should decode base64 from stdin", async () => {
      const env = new Bash({
        files: {
          // "Hello" in base64
          "/encoded.txt": "SGVsbG8=\n"
        }
      });

      const result = await env.exec("cat /encoded.txt | base64 -d");
      expect(result.stdout).toBe("Hello");
    });

    it("should decode valid base64 from stdin", async () => {
      const env = new Bash({
        files: {
          // "ABC" in base64
          "/encoded.txt": "QUJD\n"
        }
      });

      const result = await env.exec("cat /encoded.txt | base64 -d");
      expect(result.stdout).toBe("ABC");
    });
  });

  describe("round-trip integrity", () => {
    it("should round-trip text content", async () => {
      const env = new Bash({
        files: {
          "/data.txt": "Hello World 123"
        }
      });

      await env.exec("base64 /data.txt > /encoded.txt");
      const result = await env.exec("base64 -d /encoded.txt");

      expect(result.stdout).toBe("Hello World 123");
    });

    it("should round-trip via stdin", async () => {
      const env = new Bash({
        files: {
          "/data.txt": "test content"
        }
      });

      await env.exec("cat /data.txt | base64 > /encoded.txt");
      const result = await env.exec("base64 -d /encoded.txt");

      expect(result.stdout).toBe("test content");
    });

    it("should handle large binary files (1MB+)", async () => {
      // Create a 1MB binary file with all byte values repeated
      const size = 1024 * 1024; // 1MB
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = i % 256;
      }

      const env = new Bash({
        files: {
          "/large.bin": data
        }
      });

      // Encode the large file
      await env.exec("base64 /large.bin > /encoded.txt");

      // Decode it back
      await env.exec("base64 -d /encoded.txt > /decoded.bin");

      // Verify the decoded file matches the original
      const decoded = await env.fs.readFileBuffer(
        env.fs.resolvePath("/", "/decoded.bin")
      );

      expect(decoded.length).toBe(size);
      // Check first, middle, and last bytes
      expect(decoded[0]).toBe(0);
      expect(decoded[255]).toBe(255);
      expect(decoded[size / 2]).toBe((size / 2) % 256);
      expect(decoded[size - 1]).toBe((size - 1) % 256);

      // Verify a sample of bytes throughout the file
      for (let i = 0; i < size; i += 10000) {
        expect(decoded[i]).toBe(i % 256);
      }
    });

    it("should handle large files via pipe", async () => {
      // Create a 512KB binary file
      const size = 512 * 1024;
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        data[i] = (i * 7) % 256; // Different pattern
      }

      const env = new Bash({
        files: {
          "/medium.bin": data
        }
      });

      // Round-trip through pipe
      await env.exec("cat /medium.bin | base64 | base64 -d > /output.bin");

      // Verify the output matches the original
      const output = await env.fs.readFileBuffer(
        env.fs.resolvePath("/", "/output.bin")
      );

      expect(output.length).toBe(size);
      // Check a sample of bytes
      for (let i = 0; i < size; i += 5000) {
        expect(output[i]).toBe((i * 7) % 256);
      }
    });
  });
});
