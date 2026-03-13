import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("head", () => {
  it("should show first 10 lines by default", async () => {
    const lines = `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")}\n`;
    const env = new Bash({
      files: { "/test.txt": lines }
    });
    const result = await env.exec("head /test.txt");
    expect(result.stdout).toBe(
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n"
    );
    expect(result.exitCode).toBe(0);
  });

  it("should show specified number of lines with -n", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\nc\nd\ne\n" }
    });
    const result = await env.exec("head -n 3 /test.txt");
    expect(result.stdout).toBe("a\nb\nc\n");
  });

  it("should show specified number of lines with -n attached", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\nc\nd\ne\n" }
    });
    const result = await env.exec("head -n3 /test.txt");
    expect(result.stdout).toBe("a\nb\nc\n");
  });

  it("should show specified number of lines with -NUM", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\nc\nd\ne\n" }
    });
    const result = await env.exec("head -2 /test.txt");
    expect(result.stdout).toBe("a\nb\n");
  });

  it("should handle file with fewer lines than requested", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\n" }
    });
    const result = await env.exec("head -n 10 /test.txt");
    expect(result.stdout).toBe("a\nb\n");
  });

  it("should show headers for multiple files", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "aaa\n",
        "/b.txt": "bbb\n"
      }
    });
    const result = await env.exec("head /a.txt /b.txt");
    expect(result.stdout).toBe("==> /a.txt <==\naaa\n\n==> /b.txt <==\nbbb\n");
  });

  it("should error on missing file", async () => {
    const env = new Bash();
    const result = await env.exec("head /missing.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "head: /missing.txt: No such file or directory\n"
    );
  });

  it("should read from stdin", async () => {
    const env = new Bash();
    const result = await env.exec('echo -e "a\\nb\\nc\\nd\\ne" | head -n 2');
    expect(result.stdout).toBe("a\nb\n");
  });

  it("should handle empty file", async () => {
    const env = new Bash({
      files: { "/empty.txt": "" }
    });
    const result = await env.exec("head /empty.txt");
    expect(result.exitCode).toBe(0);
  });

  it("should handle head -n 1", async () => {
    const env = new Bash({
      files: { "/test.txt": "first\nsecond\n" }
    });
    const result = await env.exec("head -n 1 /test.txt");
    expect(result.stdout).toBe("first\n");
  });

  it("should handle file without trailing newline", async () => {
    const env = new Bash({
      files: { "/test.txt": "no newline" }
    });
    const result = await env.exec("head -n 1 /test.txt");
    expect(result.stdout).toBe("no newline\n");
  });

  it("should show first line only with -n 1", async () => {
    const env = new Bash({
      files: { "/test.txt": "first\nsecond\nthird\n" }
    });
    const result = await env.exec("head -n 1 /test.txt");
    expect(result.stdout).toBe("first\n");
  });
});
