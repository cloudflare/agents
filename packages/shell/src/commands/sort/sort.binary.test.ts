import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("sort with binary content", () => {
  it("should sort lines containing binary-safe content", async () => {
    const env = new Bash({
      files: {
        "/data.txt": new Uint8Array([
          0x63,
          0x0a, // c\n
          0x61,
          0x0a, // a\n
          0x62,
          0x0a // b\n
        ])
      }
    });

    const result = await env.exec("sort /data.txt");
    expect(result.stdout).toBe("a\nb\nc\n");
    expect(result.exitCode).toBe(0);
  });
});
