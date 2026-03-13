import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("pwd", () => {
  it("should show default home directory", async () => {
    const env = new Bash();
    const result = await env.exec("pwd");
    expect(result.stdout).toBe("/home/user\n");
    expect(result.exitCode).toBe(0);
  });

  it("should show root directory when cwd is /", async () => {
    const env = new Bash({ cwd: "/" });
    const result = await env.exec("pwd");
    expect(result.stdout).toBe("/\n");
    expect(result.exitCode).toBe(0);
  });

  it("should show current directory", async () => {
    const env = new Bash({ cwd: "/home/user" });
    const result = await env.exec("pwd");
    expect(result.stdout).toBe("/home/user\n");
  });

  it("should reflect cd changes within same exec", async () => {
    const env = new Bash({
      files: { "/home/user/.keep": "" }
    });
    // cd and pwd must be in same exec (each exec is a new shell)
    const result = await env.exec("cd /home/user; pwd");
    expect(result.stdout).toBe("/home/user\n");
  });

  it("should work after multiple cd commands within same exec", async () => {
    const env = new Bash({
      files: {
        "/a/.keep": "",
        "/b/.keep": "",
        "/c/.keep": ""
      }
    });
    const result = await env.exec("cd /a; cd /b; cd /c; pwd");
    expect(result.stdout).toBe("/c\n");
  });

  it("should work after cd ..", async () => {
    const env = new Bash({
      files: { "/parent/child/.keep": "" },
      cwd: "/parent/child"
    });
    const result = await env.exec("cd ..; pwd");
    expect(result.stdout).toBe("/parent\n");
  });

  it("should ignore arguments", async () => {
    const env = new Bash({ cwd: "/test" });
    const result = await env.exec("pwd ignored args");
    expect(result.stdout).toBe("/test\n");
  });
});
