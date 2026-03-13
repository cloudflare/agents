import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("touch", () => {
  it("should create empty file", async () => {
    const env = new Bash();
    const result = await env.exec("touch /newfile.txt");
    expect(result.exitCode).toBe(0);
    const content = await env.readFile("/newfile.txt");
    expect(content).toBe("");
  });

  it("should create multiple files", async () => {
    const env = new Bash();
    await env.exec("touch /a.txt /b.txt /c.txt");
    expect(await env.readFile("/a.txt")).toBe("");
    expect(await env.readFile("/b.txt")).toBe("");
    expect(await env.readFile("/c.txt")).toBe("");
  });

  it("should not modify existing file content", async () => {
    const env = new Bash({
      files: { "/existing.txt": "original content" }
    });
    await env.exec("touch /existing.txt");
    const content = await env.readFile("/existing.txt");
    expect(content).toBe("original content");
  });

  it("should create file in nested directory", async () => {
    const env = new Bash({
      files: { "/dir/subdir/.keep": "" }
    });
    await env.exec("touch /dir/subdir/newfile.txt");
    const content = await env.readFile("/dir/subdir/newfile.txt");
    expect(content).toBe("");
  });

  it("should error with no arguments", async () => {
    const env = new Bash();
    const result = await env.exec("touch");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing file operand");
  });

  it("should create file with relative path", async () => {
    const env = new Bash({
      files: { "/home/user/.keep": "" },
      cwd: "/home/user"
    });
    await env.exec("touch myfile.txt");
    const content = await env.readFile("/home/user/myfile.txt");
    expect(content).toBe("");
  });

  it("should handle file with spaces in name", async () => {
    const env = new Bash();
    await env.exec('touch "/file with spaces.txt"');
    const content = await env.readFile("/file with spaces.txt");
    expect(content).toBe("");
  });

  it("should create hidden file", async () => {
    const env = new Bash();
    await env.exec("touch /.hidden");
    const content = await env.readFile("/.hidden");
    expect(content).toBe("");
  });
});
