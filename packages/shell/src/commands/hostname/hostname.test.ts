import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("hostname command", () => {
  it("should return localhost in sandboxed environment", async () => {
    const env = new Bash();
    const result = await env.exec("hostname");
    expect(result.stdout).toBe("localhost\n");
    expect(result.exitCode).toBe(0);
  });

  it("should work in command substitution", async () => {
    const env = new Bash();
    const result = await env.exec("echo $(hostname)");
    expect(result.stdout).toBe("localhost\n");
    expect(result.exitCode).toBe(0);
  });
});
