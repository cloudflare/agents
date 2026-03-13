import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("gzip with binary data", () => {
  describe("binary file compression", () => {
    it("should compress and decompress binary file with high bytes", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff])
        }
      });

      await env.exec("gzip -k /binary.bin");
      await env.exec("rm /binary.bin");
      await env.exec("gunzip /binary.bin.gz");

      const result = await env.exec("cat /binary.bin");
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0x90);
      expect(result.stdout.charCodeAt(2)).toBe(0xa0);
      expect(result.stdout.charCodeAt(3)).toBe(0xb0);
      expect(result.stdout.charCodeAt(4)).toBe(0xff);
    });

    it("should compress and decompress file with null bytes", async () => {
      const env = new Bash({
        files: {
          "/nulls.bin": new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43])
        }
      });

      await env.exec("gzip -k /nulls.bin");
      await env.exec("rm /nulls.bin");
      await env.exec("gunzip /nulls.bin.gz");

      const result = await env.exec("cat /nulls.bin");
      expect(result.stdout).toBe("A\0B\0C");
    });

    it("should compress and decompress file with all byte values", async () => {
      const env = new Bash({
        files: {
          "/allbytes.bin": new Uint8Array(
            Array.from({ length: 256 }, (_, i) => i)
          )
        }
      });

      await env.exec("gzip -k /allbytes.bin");
      await env.exec("rm /allbytes.bin");
      await env.exec("gunzip /allbytes.bin.gz");

      const result = await env.exec("cat /allbytes.bin");
      expect(result.stdout.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(result.stdout.charCodeAt(i)).toBe(i);
      }
    });
  });

  describe("binary stdin piping", () => {
    it("should compress from stdin and output to stdout", async () => {
      const env = new Bash({
        files: {
          "/data.txt": "test data for compression"
        }
      });

      // Compress via stdin, save to file, then decompress
      await env.exec("cat /data.txt | gzip -c > /compressed.gz");
      const result = await env.exec("gunzip -c /compressed.gz");

      expect(result.stdout).toBe("test data for compression");
    });

    it("should decompress from stdin", async () => {
      const env = new Bash({
        files: {
          "/data.txt": "original content"
        }
      });

      await env.exec("gzip -k /data.txt");
      const result = await env.exec("cat /data.txt.gz | gunzip");

      expect(result.stdout).toBe("original content");
    });

    it("should handle piped binary data with high bytes", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x90, 0xab])
        }
      });

      await env.exec("gzip -c /binary.bin > /binary.bin.gz");
      const result = await env.exec("cat /binary.bin.gz | gunzip -c");

      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0xff);
      expect(result.stdout.charCodeAt(2)).toBe(0x90);
      expect(result.stdout.charCodeAt(3)).toBe(0xab);
    });

    it("should handle zcat with piped input", async () => {
      const env = new Bash({
        files: {
          "/data.txt": "zcat test content"
        }
      });

      await env.exec("gzip -k /data.txt");
      const result = await env.exec("cat /data.txt.gz | zcat");

      expect(result.stdout).toBe("zcat test content");
    });
  });

  describe("UTF-8 content", () => {
    it("should compress and decompress UTF-8 text", async () => {
      const original = "Hello 中文 日本語 한국어 🎉";
      const env = new Bash({
        files: {
          "/unicode.txt": original
        }
      });

      await env.exec("gzip -c /unicode.txt > /unicode.txt.gz");
      const result = await env.exec("gunzip -c /unicode.txt.gz");

      expect(result.stdout).toBe(original);
    });

    it("should handle UTF-8 via stdin pipe", async () => {
      const original = "Привет мир 你好世界";
      const env = new Bash({
        files: {
          "/unicode.txt": original
        }
      });

      await env.exec("cat /unicode.txt | gzip -c > /compressed.gz");
      const result = await env.exec("gunzip -c /compressed.gz");

      expect(result.stdout).toBe(original);
    });

    it("should preserve UTF-8 multi-byte sequences", async () => {
      const original = "🚀🎉🔥💯";
      const env = new Bash({
        files: {
          "/emoji.txt": original
        }
      });

      await env.exec("gzip -c /emoji.txt > /emoji.txt.gz");
      const result = await env.exec("gunzip -c /emoji.txt.gz");

      expect(result.stdout).toBe(original);
    });
  });
});
