import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("tar with binary data", () => {
  describe("binary file content", () => {
    it("should archive and extract binary file with high bytes", async () => {
      const env = new Bash({
        files: {
          "/src/binary.bin": new Uint8Array([0x80, 0x90, 0xa0, 0xb0, 0xff])
        }
      });

      await env.exec("tar -cf /archive.tar -C /src binary.bin");
      await env.exec("tar -xf /archive.tar -C /dest");

      const result = await env.exec("cat /dest/binary.bin");
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0x90);
      expect(result.stdout.charCodeAt(2)).toBe(0xa0);
      expect(result.stdout.charCodeAt(3)).toBe(0xb0);
      expect(result.stdout.charCodeAt(4)).toBe(0xff);
    });

    it("should archive and extract file with null bytes", async () => {
      const env = new Bash({
        files: {
          "/src/nulls.bin": new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43])
        }
      });

      await env.exec("tar -cf /archive.tar -C /src nulls.bin");
      await env.exec("tar -xf /archive.tar -C /dest");

      const result = await env.exec("cat /dest/nulls.bin");
      expect(result.stdout).toBe("A\0B\0C");
    });

    it("should archive and extract file with all byte values", async () => {
      const env = new Bash({
        files: {
          "/src/allbytes.bin": new Uint8Array(
            Array.from({ length: 256 }, (_, i) => i)
          )
        }
      });

      await env.exec("tar -cf /archive.tar -C /src allbytes.bin");
      await env.exec("tar -xf /archive.tar -C /dest");

      const result = await env.exec("cat /dest/allbytes.bin");
      expect(result.stdout.length).toBe(256);
      for (let i = 0; i < 256; i++) {
        expect(result.stdout.charCodeAt(i)).toBe(i);
      }
    });
  });

  describe("binary stdin piping", () => {
    it("should list archive piped through cat", async () => {
      const env = new Bash({
        files: {
          "/src/file.txt": "content"
        }
      });

      await env.exec("tar -cf /archive.tar -C /src file.txt");
      const result = await env.exec("cat /archive.tar | tar -t");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("file.txt");
    });

    it("should extract archive piped through cat", async () => {
      const env = new Bash({
        files: {
          "/src/data.txt": "hello world"
        }
      });

      await env.exec("tar -cf /archive.tar -C /src data.txt");
      await env.exec("cat /archive.tar | tar -x -C /dest");

      const result = await env.exec("cat /dest/data.txt");
      expect(result.stdout).toBe("hello world");
    });

    it("should handle gzip archive piped through cat", async () => {
      const env = new Bash({
        files: {
          "/src/file.txt": "compressed content"
        }
      });

      await env.exec("tar -czf /archive.tar.gz -C /src file.txt");
      await env.exec("cat /archive.tar.gz | tar -xz -C /dest");

      const result = await env.exec("cat /dest/file.txt");
      expect(result.stdout).toBe("compressed content");
    });

    it("should reject bzip2 compression (requires native addons)", async () => {
      const env = new Bash({
        files: {
          "/src/file.txt": "bzip2 content"
        }
      });

      const result = await env.exec(
        "tar -cjf /archive.tar.bz2 -C /src file.txt"
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not supported");
    });

    it("should reject xz compression (requires native addons)", async () => {
      const env = new Bash({
        files: {
          "/src/file.txt": "xz content"
        }
      });

      const result = await env.exec(
        "tar -cJf /archive.tar.xz -C /src file.txt"
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not supported");
    });

    it("should reject zstd compression (requires native addons)", async () => {
      const env = new Bash({
        files: {
          "/src/file.txt": "zstd content"
        }
      });

      const result = await env.exec(
        "tar --zstd -cf /archive.tar.zst -C /src file.txt"
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not supported");
    });
  });

  describe("UTF-8 content", () => {
    it("should archive and extract UTF-8 text", async () => {
      const env = new Bash({
        files: {
          "/src/unicode.txt": "Hello World"
        }
      });

      await env.exec("tar -cf /archive.tar -C /src unicode.txt");
      await env.exec("tar -xf /archive.tar -C /dest");

      const result = await env.exec("cat /dest/unicode.txt");
      expect(result.stdout).toBe("Hello World");
    });

    it("should archive and extract with gzip", async () => {
      const env = new Bash({
        files: {
          "/src/data.txt": "compressed data"
        }
      });

      await env.exec("tar -czf /archive.tar.gz -C /src data.txt");
      await env.exec("tar -xzf /archive.tar.gz -C /dest");

      const result = await env.exec("cat /dest/data.txt");
      expect(result.stdout).toBe("compressed data");
    });

    it("should handle filenames with special characters", async () => {
      const env = new Bash({
        files: {
          "/src/file-name_123.txt": "special filename"
        }
      });

      await env.exec("tar -cf /archive.tar -C /src file-name_123.txt");
      const listResult = await env.exec("tar -tf /archive.tar");

      expect(listResult.stdout).toContain("file-name_123.txt");
    });
  });
});
