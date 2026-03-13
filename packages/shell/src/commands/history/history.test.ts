import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("history command", () => {
  it("should show empty history initially", async () => {
    const env = new Bash();
    const result = await env.exec("history");
    // History is empty at start
    expect(result.exitCode).toBe(0);
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("history --help");
    expect(result.stdout).toContain("history");
    expect(result.stdout).toContain("command history");
    expect(result.exitCode).toBe(0);
  });

  it("should clear history with -c (within same exec)", async () => {
    const env = new Bash({
      env: { BASH_HISTORY: '["echo hello","ls -la"]' }
    });
    // history -c and verify in same exec (each exec is a new shell)
    const result = await env.exec("history -c; history");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("should display history with line numbers", async () => {
    const env = new Bash({
      env: { BASH_HISTORY: '["echo hello","ls -la"]' }
    });
    const result = await env.exec("history");
    expect(result.stdout).toBe("    1  echo hello\n    2  ls -la\n");
    expect(result.exitCode).toBe(0);
  });

  it("should limit output with numeric argument", async () => {
    const env = new Bash({
      env: { BASH_HISTORY: '["cmd1","cmd2","cmd3","cmd4","cmd5"]' }
    });
    const result = await env.exec("history 2");
    expect(result.stdout).toBe("    4  cmd4\n    5  cmd5\n");
    expect(result.exitCode).toBe(0);
  });
});
