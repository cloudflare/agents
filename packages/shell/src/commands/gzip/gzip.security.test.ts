import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("gzip security hardening", () => {
  it("handles large gunzip -c output without stack overflow", async () => {
    const env = new Bash();
    const bigContent = "A".repeat(200000);
    await env.writeFile("/big.txt", bigContent);
    await env.exec("gzip /big.txt");

    const result = await env.exec("gunzip -c /big.txt.gz");

    expect(result.stdout).toBe(bigContent);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("enforces decompressed output limit for file extraction", async () => {
    const env = new Bash({
      executionLimits: {
        maxOutputSize: 128
      }
    });
    await env.writeFile("/payload.txt", "X".repeat(200));
    await env.exec("gzip /payload.txt");

    const result = await env.exec("gunzip /payload.txt.gz");

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "gunzip: /payload.txt.gz: decompressed data exceeds limit (128 bytes)\n"
    );
    expect(result.exitCode).toBe(1);
    expect(await env.fs.exists("/payload.txt")).toBe(false);
  });

  it("enforces decompressed output limit for stdin input", async () => {
    const env = new Bash({
      executionLimits: {
        maxOutputSize: 128
      }
    });
    await env.writeFile("/payload.txt", "Y".repeat(200));
    await env.exec("gzip /payload.txt");
    const compressed = await env.fs.readFileBuffer("/payload.txt.gz");

    const result = await env.exec("gunzip -c", {
      stdin: Buffer.from(compressed).toString("latin1")
    });

    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "gunzip: stdin: decompressed data exceeds limit (128 bytes)\n"
    );
    expect(result.exitCode).toBe(1);
  });
});
