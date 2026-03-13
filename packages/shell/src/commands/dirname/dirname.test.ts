import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("dirname command", () => {
  it("should extract directory from path", async () => {
    const env = new Bash();
    const result = await env.exec("dirname /usr/bin/sort");
    expect(result.stdout).toBe("/usr/bin\n");
    expect(result.exitCode).toBe(0);
  });

  it("should return . for file without directory", async () => {
    const env = new Bash();
    const result = await env.exec("dirname file.txt");
    expect(result.stdout).toBe(".\n");
  });

  it("should return / for root-level path", async () => {
    const env = new Bash();
    const result = await env.exec("dirname /file.txt");
    expect(result.stdout).toBe("/\n");
  });

  it("should handle multiple paths", async () => {
    const env = new Bash();
    const result = await env.exec("dirname /path/to/file1 /another/path/file2");
    expect(result.stdout).toBe("/path/to\n/another/path\n");
  });

  it("should show error for missing operand", async () => {
    const env = new Bash();
    const result = await env.exec("dirname");
    expect(result.stderr).toContain("missing operand");
    expect(result.exitCode).toBe(1);
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("dirname --help");
    expect(result.stdout).toContain("dirname");
    expect(result.stdout).toContain("strip last component");
    expect(result.exitCode).toBe(0);
  });
});
