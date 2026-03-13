import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("true", () => {
  it("should return exit code 0", async () => {
    const env = new Bash();
    const result = await env.exec("true");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("should ignore all arguments", async () => {
    const env = new Bash();
    const result = await env.exec("true --help -x --anything");
    expect(result.exitCode).toBe(0);
  });

  it("should work in conditionals", async () => {
    const env = new Bash();
    const result = await env.exec("true && echo yes || echo no");
    expect(result.stdout).toBe("yes\n");
  });
});

describe("false", () => {
  it("should return exit code 1", async () => {
    const env = new Bash();
    const result = await env.exec("false");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("should ignore all arguments", async () => {
    const env = new Bash();
    const result = await env.exec("false --help -x --anything");
    expect(result.exitCode).toBe(1);
  });

  it("should work in conditionals", async () => {
    const env = new Bash();
    const result = await env.exec("false && echo yes || echo no");
    expect(result.stdout).toBe("no\n");
  });
});
