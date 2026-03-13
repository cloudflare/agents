import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("uniq with binary content", () => {
  it("should dedupe lines in binary file", async () => {
    const env = new Bash({
      files: {
        "/data.bin": new Uint8Array([
          0x61,
          0x0a, // a\n
          0x61,
          0x0a, // a\n
          0x62,
          0x0a // b\n
        ])
      }
    });

    const result = await env.exec("uniq /data.bin");
    expect(result.stdout).toBe("a\nb\n");
    expect(result.exitCode).toBe(0);
  });
});
