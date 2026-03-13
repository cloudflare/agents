import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("head with binary files", () => {
  it("should read first n lines from binary file", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x4c,
          0x31,
          0x0a, // L1\n
          0x4c,
          0x32,
          0x0a, // L2\n
          0x4c,
          0x33,
          0x0a // L3\n
        ])
      }
    });

    const result = await env.exec("head -n 2 /binary.bin");
    expect(result.stdout).toBe("L1\nL2\n");
    expect(result.exitCode).toBe(0);
  });

  it("should read first n bytes with -c", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([0x41, 0x42, 0x43, 0x44, 0x45]) // ABCDE
      }
    });

    const result = await env.exec("head -c 3 /binary.bin");
    expect(result.stdout).toBe("ABC");
    expect(result.exitCode).toBe(0);
  });
});
