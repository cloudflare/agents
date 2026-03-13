import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("redirections with binary data", () => {
  describe("basic redirection >", () => {
    it("should preserve binary data when redirecting to file", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff])
        }
      });

      await env.exec("cat /binary.bin > /output.bin");
      const result = await env.exec("cat /output.bin");

      expect(result.stdout.length).toBe(5);
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0x90);
      expect(result.stdout.charCodeAt(2)).toBe(0xa0);
      expect(result.stdout.charCodeAt(3)).toBe(0xb0);
      expect(result.stdout.charCodeAt(4)).toBe(0xff);
    });

    it("should preserve null bytes when redirecting to file", async () => {
      const env = new Bash({
        files: {
          "/nulls.bin": new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43])
        }
      });

      await env.exec("cat /nulls.bin > /output.bin");
      const result = await env.exec("cat /output.bin");

      expect(result.stdout).toBe("A\0B\0C");
    });

    it("should preserve all byte values when redirecting to file", async () => {
      const env = new Bash({
        files: {
          "/allbytes.bin": new Uint8Array(
            Array.from({ length: 256 }, (_, i) => i)
          )
        }
      });

      await env.exec("cat /allbytes.bin > /output.bin");
      const result = await env.exec("cat /output.bin");

      expect(result.stdout.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(result.stdout.charCodeAt(i)).toBe(i);
      }
    });
  });

  describe("append redirection >>", () => {
    it("should preserve binary data when appending to file", async () => {
      const env = new Bash({
        files: {
          "/a.bin": new Uint8Array([0x80, 0x90]),
          "/b.bin": new Uint8Array([0xa0, 0xb0])
        }
      });

      await env.exec("cat /a.bin > /output.bin");
      await env.exec("cat /b.bin >> /output.bin");
      const result = await env.exec("cat /output.bin");

      expect(result.stdout.length).toBe(4);
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0x90);
      expect(result.stdout.charCodeAt(2)).toBe(0xa0);
      expect(result.stdout.charCodeAt(3)).toBe(0xb0);
    });
  });

  describe("pipe with redirection", () => {
    it("should preserve binary data through pipe and redirection", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x90, 0xab])
        }
      });

      await env.exec("cat /binary.bin | cat > /output.bin");
      const result = await env.exec("cat /output.bin");

      expect(result.stdout.length).toBe(4);
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0xff);
      expect(result.stdout.charCodeAt(2)).toBe(0x90);
      expect(result.stdout.charCodeAt(3)).toBe(0xab);
    });

    it("should preserve binary data through multiple pipes", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x00, 0x90])
        }
      });

      await env.exec("cat /binary.bin | cat | cat > /output.bin");
      const result = await env.exec("cat /output.bin");

      expect(result.stdout.length).toBe(4);
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0xff);
      expect(result.stdout.charCodeAt(2)).toBe(0x00);
      expect(result.stdout.charCodeAt(3)).toBe(0x90);
    });
  });

  describe("combined redirections &>", () => {
    it("should preserve binary stdout when using &>", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0x90, 0xa0])
        }
      });

      await env.exec("cat /binary.bin &> /output.bin");
      const result = await env.exec("cat /output.bin");

      expect(result.stdout.length).toBe(3);
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0x90);
      expect(result.stdout.charCodeAt(2)).toBe(0xa0);
    });
  });

  describe("gzip/gunzip through redirections", () => {
    it("should preserve binary data through gzip -c redirection", async () => {
      const env = new Bash({
        files: {
          "/data.txt": "test data for compression"
        }
      });

      await env.exec("gzip -c /data.txt > /compressed.gz");
      const result = await env.exec("gunzip -c /compressed.gz");

      expect(result.stdout).toBe("test data for compression");
    });

    it("should preserve binary data through stdin gzip pipe redirection", async () => {
      const env = new Bash({
        files: {
          "/data.txt": "piped compression test"
        }
      });

      await env.exec("cat /data.txt | gzip -c > /compressed.gz");
      const result = await env.exec("gunzip -c /compressed.gz");

      expect(result.stdout).toBe("piped compression test");
    });

    it("should handle binary file through gzip redirection", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x80, 0xff, 0x00, 0x90, 0xab])
        }
      });

      await env.exec("gzip -c /binary.bin > /binary.bin.gz");
      const result = await env.exec("gunzip -c /binary.bin.gz");

      expect(result.stdout.length).toBe(5);
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0xff);
      expect(result.stdout.charCodeAt(2)).toBe(0x00);
      expect(result.stdout.charCodeAt(3)).toBe(0x90);
      expect(result.stdout.charCodeAt(4)).toBe(0xab);
    });
  });

  describe("UTF-8 text through redirections", () => {
    it("should preserve Latin-1 range characters (Ü Ö Ä) via readFileBuffer", async () => {
      const env = new Bash({});

      await env.exec('echo "Ü Ö Ä" > /test.txt');
      const buffer = await env.fs.readFileBuffer("/test.txt");
      const decoded = new TextDecoder().decode(buffer);

      expect(decoded).toBe("Ü Ö Ä\n");
    });

    it("should preserve French accented characters via readFileBuffer", async () => {
      const env = new Bash({});

      await env.exec('echo "café résumé" > /test.txt');
      const buffer = await env.fs.readFileBuffer("/test.txt");
      const decoded = new TextDecoder().decode(buffer);

      expect(decoded).toBe("café résumé\n");
    });

    it("should produce correct UTF-8 bytes for German umlauts", async () => {
      const env = new Bash({});

      await env.exec('echo "Ü" > /test.txt');
      const buffer = await env.fs.readFileBuffer("/test.txt");

      // Ü in UTF-8 is [0xC3, 0x9C], plus newline [0x0A]
      expect(Array.from(buffer)).toEqual([0xc3, 0x9c, 0x0a]);
    });

    it("should preserve UTF-8 text through cat roundtrip", async () => {
      const env = new Bash({});

      await env.exec('echo "Ü Ö Ä ü ö ä ß" > /test.txt');
      const result = await env.exec("cat /test.txt");

      expect(result.stdout).toBe("Ü Ö Ä ü ö ä ß\n");
    });
  });
});
