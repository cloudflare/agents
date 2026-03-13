import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("sed with binary content", () => {
  it("should perform substitution on binary file", async () => {
    const env = new Bash({
      files: {
        "/data.bin": new Uint8Array([
          0x68,
          0x65,
          0x6c,
          0x6c,
          0x6f,
          0x0a // hello\n
        ])
      }
    });

    const result = await env.exec("sed 's/hello/world/' /data.bin");
    expect(result.stdout).toBe("world\n");
    expect(result.exitCode).toBe(0);
  });
});
