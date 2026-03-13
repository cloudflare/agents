import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("which", () => {
  it("should find command in PATH", async () => {
    const env = new Bash();
    const result = await env.exec("which ls");
    expect(result.stdout).toBe("/usr/bin/ls\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should find multiple commands", async () => {
    const env = new Bash();
    const result = await env.exec("which ls cat echo");
    expect(result.stdout).toBe("/usr/bin/ls\n/usr/bin/cat\n/usr/bin/echo\n");
    expect(result.exitCode).toBe(0);
  });

  it("should return exit 1 for nonexistent command", async () => {
    const env = new Bash();
    const result = await env.exec("which nonexistent");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("should return exit 1 if any command not found", async () => {
    const env = new Bash();
    const result = await env.exec("which ls nonexistent cat");
    expect(result.stdout).toBe("/usr/bin/ls\n/usr/bin/cat\n");
    expect(result.exitCode).toBe(1);
  });

  it("should support -s for silent mode", async () => {
    const env = new Bash();
    const result = await env.exec("which -s ls");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should return exit 1 with -s for nonexistent", async () => {
    const env = new Bash();
    const result = await env.exec("which -s nonexistent");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("should support -a to show all matches", async () => {
    const env = new Bash();
    // With default PATH=/usr/bin:/bin, command exists in both directories
    // -a should show both matches in PATH order
    const result = await env.exec("which -a ls");
    expect(result.stdout).toBe("/usr/bin/ls\n/bin/ls\n");
    expect(result.exitCode).toBe(0);
  });

  it("should respect PATH environment", async () => {
    // Test with custom PATH that includes /bin - should find ls
    const env = new Bash();
    const result = await env.exec("export PATH=/bin; which ls");
    expect(result.stdout).toBe("/bin/ls\n");
    expect(result.exitCode).toBe(0);
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("which --help");
    expect(result.stdout).toContain("which");
    expect(result.stdout).toContain("locate a command");
    expect(result.exitCode).toBe(0);
  });

  it("should return exit 1 with no arguments", async () => {
    const env = new Bash();
    const result = await env.exec("which");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("should support combined -as flags", async () => {
    const env = new Bash();
    const result = await env.exec("which -as ls");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should resolve paths safely with ../", async () => {
    const env = new Bash();
    // A name containing ../ should not escape PATH directories
    const result = await env.exec("which ../etc/passwd");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });
});
