import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("env command", () => {
  it("should print all environment variables", async () => {
    const env = new Bash({
      env: { FOO: "bar", BAZ: "qux" }
    });
    const result = await env.exec("env");
    expect(result.stdout).toContain("FOO=bar");
    expect(result.stdout).toContain("BAZ=qux");
    expect(result.exitCode).toBe(0);
  });

  it("should include default environment variables", async () => {
    const env = new Bash();
    const result = await env.exec("env");
    expect(result.stdout).toContain("HOME=/");
    expect(result.stdout).toContain("PATH=/usr/bin:/bin");
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("env --help");
    expect(result.stdout).toContain("env");
    expect(result.stdout).toContain("environment");
    expect(result.exitCode).toBe(0);
  });

  it("should run command with empty environment when using -i", async () => {
    const env = new Bash({
      env: { FOO: "bar", PATH: "/usr/bin:/bin" }
    });
    const result = await env.exec("env -i printenv PATH");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("should apply NAME=VALUE with -i for command execution", async () => {
    const env = new Bash({
      env: { FOO: "bar" }
    });
    const result = await env.exec("env -i ONLY=value printenv ONLY");
    expect(result.stdout).toBe("value\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should unset variables for command execution with -u", async () => {
    const env = new Bash({
      env: { FOO: "bar", BAZ: "qux" }
    });
    const result = await env.exec("env -u FOO printenv FOO BAZ");
    expect(result.stdout).toBe("qux\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
  });
});

describe("printenv command", () => {
  it("should print all environment variables without args", async () => {
    const env = new Bash({
      env: { FOO: "bar" }
    });
    const result = await env.exec("printenv");
    expect(result.stdout).toContain("FOO=bar");
    expect(result.exitCode).toBe(0);
  });

  it("should print specific variable value", async () => {
    const env = new Bash({
      env: { FOO: "bar", BAZ: "qux" }
    });
    const result = await env.exec("printenv FOO");
    expect(result.stdout).toBe("bar\n");
    expect(result.exitCode).toBe(0);
  });

  it("should print multiple variable values", async () => {
    const env = new Bash({
      env: { FOO: "bar", BAZ: "qux" }
    });
    const result = await env.exec("printenv FOO BAZ");
    expect(result.stdout).toBe("bar\nqux\n");
  });

  it("should return exit code 1 for missing variable", async () => {
    const env = new Bash();
    const result = await env.exec("printenv NONEXISTENT");
    expect(result.exitCode).toBe(1);
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("printenv --help");
    expect(result.stdout).toContain("printenv");
    expect(result.exitCode).toBe(0);
  });
});

describe("env/printenv host isolation", () => {
  it("should not leak real host env vars via env", async () => {
    const bash = new Bash();
    const result = await bash.exec("env");
    // Should not contain common host env vars
    expect(result.stdout).not.toContain("NODE_ENV=");
    expect(result.stdout).not.toContain("SHELL=");
    expect(result.stdout).not.toContain("TERM=");
    expect(result.stdout).not.toContain("LANG=");
    expect(result.stdout).not.toContain("USER=");
  });

  it("should return virtual PATH, not host PATH", async () => {
    const bash = new Bash();
    const result = await bash.exec("printenv PATH");
    expect(result.stdout.trim()).toBe("/usr/bin:/bin");
    expect(result.stdout).not.toContain("/usr/local/bin");
  });
});
