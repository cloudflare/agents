import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("tee command", () => {
  it("should pass through stdin to stdout", async () => {
    const env = new Bash();
    const result = await env.exec("echo hello | tee");
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
  });

  it("should write to file and stdout", async () => {
    const env = new Bash();
    const result = await env.exec("echo hello | tee output.txt");
    expect(result.stdout).toBe("hello\n");
    const content = await env.readFile("output.txt");
    expect(content).toBe("hello\n");
  });

  it("should write to multiple files", async () => {
    const env = new Bash();
    const result = await env.exec("echo hello | tee file1.txt file2.txt");
    expect(result.stdout).toBe("hello\n");
    const content1 = await env.readFile("file1.txt");
    const content2 = await env.readFile("file2.txt");
    expect(content1).toBe("hello\n");
    expect(content2).toBe("hello\n");
  });

  it("should append with -a flag", async () => {
    const env = new Bash({
      files: { "/test.txt": "existing\n" }
    });
    const result = await env.exec("echo appended | tee -a test.txt");
    expect(result.stdout).toBe("appended\n");
    const content = await env.readFile("/test.txt");
    expect(content).toBe("existing\nappended\n");
  });

  it("should append with --append flag", async () => {
    const env = new Bash({
      files: { "/test.txt": "existing\n" }
    });
    await env.exec("echo appended | tee --append test.txt");
    const content = await env.readFile("/test.txt");
    expect(content).toBe("existing\nappended\n");
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("tee --help");
    expect(result.stdout).toContain("tee");
    expect(result.stdout).toContain("stdin");
    expect(result.exitCode).toBe(0);
  });
});
