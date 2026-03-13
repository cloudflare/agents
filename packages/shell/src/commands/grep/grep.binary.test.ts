import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("grep with binary files", () => {
  it("should find pattern in binary file", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x66,
          0x6f,
          0x6f,
          0x0a, // foo\n
          0x62,
          0x61,
          0x72,
          0x0a // bar\n
        ])
      }
    });

    const result = await env.exec("grep foo /binary.bin");
    expect(result.stdout).toBe("foo\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle binary content with matches", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x00,
          0x00,
          0x74,
          0x65,
          0x73,
          0x74,
          0x0a, // \0\0test\n
          0x00,
          0x66,
          0x6f,
          0x6f,
          0x0a // \0foo\n
        ])
      }
    });

    const result = await env.exec("grep test /binary.bin");
    expect(result.stdout).toContain("test");
    expect(result.exitCode).toBe(0);
  });
});
