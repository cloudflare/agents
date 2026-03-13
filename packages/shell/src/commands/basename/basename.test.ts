import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("basename command", () => {
  it("should extract basename from path", async () => {
    const env = new Bash();
    const result = await env.exec("basename /usr/bin/sort");
    expect(result.stdout).toBe("sort\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle path without directory", async () => {
    const env = new Bash();
    const result = await env.exec("basename file.txt");
    expect(result.stdout).toBe("file.txt\n");
  });

  it("should remove suffix when provided", async () => {
    const env = new Bash();
    const result = await env.exec("basename /path/to/file.txt .txt");
    expect(result.stdout).toBe("file\n");
  });

  it("should handle -s suffix option", async () => {
    const env = new Bash();
    const result = await env.exec("basename -s .txt /path/file.txt");
    expect(result.stdout).toBe("file\n");
  });

  it("should handle multiple files with -a", async () => {
    const env = new Bash();
    const result = await env.exec("basename -a /path/one.txt /path/two.txt");
    expect(result.stdout).toBe("one.txt\ntwo.txt\n");
  });

  it("should handle --suffix with multiple files", async () => {
    const env = new Bash();
    const result = await env.exec(
      "basename --suffix=.txt /path/one.txt /path/two.txt"
    );
    expect(result.stdout).toBe("one\ntwo\n");
  });

  it("should show error for missing operand", async () => {
    const env = new Bash();
    const result = await env.exec("basename");
    expect(result.stderr).toContain("missing operand");
    expect(result.exitCode).toBe(1);
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("basename --help");
    expect(result.stdout).toContain("basename");
    expect(result.stdout).toContain("strip directory");
    expect(result.exitCode).toBe(0);
  });
});
