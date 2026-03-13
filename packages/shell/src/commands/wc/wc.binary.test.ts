import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("wc with binary files", () => {
  it("should count bytes correctly", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43])
      }
    });

    const result = await env.exec("wc -c /binary.bin");
    expect(result.stdout).toContain("5");
    expect(result.exitCode).toBe(0);
  });

  it("should count lines with null bytes", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([0x41, 0x0a, 0x00, 0x0a, 0x42, 0x0a])
      }
    });

    const result = await env.exec("wc -l /binary.bin");
    expect(result.stdout).toContain("3");
    expect(result.exitCode).toBe(0);
  });
});
