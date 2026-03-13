import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("tee with binary files", () => {
  it("should write binary content to file", async () => {
    const env = new Bash({
      files: {
        "/input.bin": new Uint8Array([0x48, 0x69, 0x0a]) // Hi\n
      }
    });

    const result = await env.exec("cat /input.bin | tee /output.bin");
    expect(result.stdout).toBe("Hi\n");

    const check = await env.exec("cat /output.bin");
    expect(check.stdout).toBe("Hi\n");
  });
});
