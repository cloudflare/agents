import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("cut with binary content", () => {
  it("should cut fields from binary file", async () => {
    const env = new Bash({
      files: {
        "/data.bin": new Uint8Array([
          0x61,
          0x3a,
          0x62,
          0x3a,
          0x63,
          0x0a // a:b:c\n
        ])
      }
    });

    const result = await env.exec("cut -d: -f2 /data.bin");
    expect(result.stdout).toBe("b\n");
    expect(result.exitCode).toBe(0);
  });
});
