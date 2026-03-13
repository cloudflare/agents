import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("tr with binary content", () => {
  it("should translate characters in binary content", async () => {
    const env = new Bash({
      files: {
        "/data.bin": new Uint8Array([0x61, 0x62, 0x63]) // abc
      }
    });

    const result = await env.exec("cat /data.bin | tr a-z A-Z");
    expect(result.stdout).toBe("ABC");
    expect(result.exitCode).toBe(0);
  });
});
