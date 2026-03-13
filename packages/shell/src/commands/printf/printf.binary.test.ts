import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("printf with binary data", () => {
  describe("hex escape sequences", () => {
    it("should output binary bytes via hex escapes", async () => {
      const env = new Bash();

      const result = await env.exec("printf '\\x80\\x90\\xa0\\xb0\\xff'");

      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(5);
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0x90);
      expect(result.stdout.charCodeAt(2)).toBe(0xa0);
      expect(result.stdout.charCodeAt(3)).toBe(0xb0);
      expect(result.stdout.charCodeAt(4)).toBe(0xff);
    });

    it("should output null bytes via hex escapes", async () => {
      const env = new Bash();

      const result = await env.exec("printf 'A\\x00B\\x00C'");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("A\0B\0C");
    });

    it("should redirect binary hex output to file", async () => {
      const env = new Bash();

      await env.exec("printf '\\x80\\xff\\x90' > /binary.bin");
      const result = await env.exec("cat /binary.bin");

      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0xff);
      expect(result.stdout.charCodeAt(2)).toBe(0x90);
    });
  });

  describe("octal escape sequences", () => {
    it("should output binary bytes via octal escapes", async () => {
      const env = new Bash();

      const result = await env.exec("printf '\\200\\220\\240'");

      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(3);
      expect(result.stdout.charCodeAt(0)).toBe(0o200); // 128
      expect(result.stdout.charCodeAt(1)).toBe(0o220); // 144
      expect(result.stdout.charCodeAt(2)).toBe(0o240); // 160
    });

    it("should redirect binary octal output to file", async () => {
      const env = new Bash();

      await env.exec("printf '\\200\\377' > /binary.bin");
      const result = await env.exec("cat /binary.bin");

      expect(result.stdout.charCodeAt(0)).toBe(0o200); // 128
      expect(result.stdout.charCodeAt(1)).toBe(0o377); // 255
    });
  });

  describe("round-trip through pipe", () => {
    it("should preserve binary data through cat pipe", async () => {
      const env = new Bash();

      await env.exec("printf '\\x80\\xff\\x00\\x90' > /input.bin");
      await env.exec("cat /input.bin > /output.bin");
      const result = await env.exec("cat /output.bin");

      expect(result.stdout.length).toBe(4);
      expect(result.stdout.charCodeAt(0)).toBe(0x80);
      expect(result.stdout.charCodeAt(1)).toBe(0xff);
      expect(result.stdout.charCodeAt(2)).toBe(0x00);
      expect(result.stdout.charCodeAt(3)).toBe(0x90);
    });

    it("should preserve binary data through pipe to base64 and back", async () => {
      const env = new Bash();

      await env.exec("printf '\\x80\\xff\\x90\\xab' > /binary.bin");
      await env.exec("base64 /binary.bin > /encoded.txt");
      const decodeResult = await env.exec("base64 -d /encoded.txt");

      expect(decodeResult.stdout.length).toBe(4);
      expect(decodeResult.stdout.charCodeAt(0)).toBe(0x80);
      expect(decodeResult.stdout.charCodeAt(1)).toBe(0xff);
      expect(decodeResult.stdout.charCodeAt(2)).toBe(0x90);
      expect(decodeResult.stdout.charCodeAt(3)).toBe(0xab);
    });
  });
});
