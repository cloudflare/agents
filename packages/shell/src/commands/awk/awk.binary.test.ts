import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk with binary content", () => {
  it("should process binary file with awk", async () => {
    const env = new Bash({
      files: {
        "/data.bin": new Uint8Array([
          0x31,
          0x20,
          0x32,
          0x0a, // 1 2\n
          0x33,
          0x20,
          0x34,
          0x0a // 3 4\n
        ])
      }
    });

    const result = await env.exec("awk '{print $1 + $2}' /data.bin");
    expect(result.stdout).toBe("3\n7\n");
    expect(result.exitCode).toBe(0);
  });
});
