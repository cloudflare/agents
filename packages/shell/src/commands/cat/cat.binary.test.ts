import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("cat with binary files", () => {
  it("should output binary content unchanged", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]) // "Hello"
      }
    });

    const result = await env.exec("cat /binary.bin");
    expect(result.stdout).toBe("Hello");
    expect(result.exitCode).toBe(0);
  });

  it("should handle null bytes in content", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43]) // A\0B\0C
      }
    });

    const result = await env.exec("cat /binary.bin");
    expect(result.stdout).toBe("A\0B\0C");
    expect(result.exitCode).toBe(0);
  });

  it("should concatenate multiple binary files", async () => {
    const env = new Bash({
      files: {
        "/a.bin": new Uint8Array([0x41, 0x42]), // "AB"
        "/b.bin": new Uint8Array([0x43, 0x44]) // "CD"
      }
    });

    const result = await env.exec("cat /a.bin /b.bin");
    expect(result.stdout).toBe("ABCD");
    expect(result.exitCode).toBe(0);
  });

  it("should number lines in binary file with -n", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([0x41, 0x0a, 0x42, 0x0a]) // "A\nB\n"
      }
    });

    const result = await env.exec("cat -n /binary.bin");
    expect(result.stdout).toBe("     1\tA\n     2\tB\n");
    expect(result.exitCode).toBe(0);
  });

  it("should preserve UTF-8 multibyte characters", async () => {
    const env = new Bash();
    await env.exec('printf "中文测试\\n" > /tmp/utf8.txt');
    const result = await env.exec("cat /tmp/utf8.txt");
    expect(result.stdout).toBe("中文测试\n");
    expect(result.exitCode).toBe(0);
  });

  it("should preserve Korean text", async () => {
    const env = new Bash();
    await env.exec('printf "설정\\n" > /tmp/korean.txt');
    const result = await env.exec("cat /tmp/korean.txt");
    expect(result.stdout).toBe("설정\n");
    expect(result.exitCode).toBe(0);
  });

  it("should preserve emoji", async () => {
    const env = new Bash();
    await env.exec('printf "hello 🌍\\n" > /tmp/emoji.txt');
    const result = await env.exec("cat /tmp/emoji.txt");
    expect(result.stdout).toBe("hello 🌍\n");
    expect(result.exitCode).toBe(0);
  });
});
