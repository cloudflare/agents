import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("wc", () => {
  it("should count lines, words, and characters", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello world\nfoo bar\n" }
    });
    const result = await env.exec("wc /test.txt");
    expect(result.stdout).toMatch(/\s*2\s+/); // 2 lines
    expect(result.stdout).toMatch(/\s+4\s+/); // 4 words
    expect(result.stdout).toMatch(/\s+20\s+/); // 20 chars
    expect(result.exitCode).toBe(0);
  });

  it("should count only lines with -l", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\nc\n" }
    });
    const result = await env.exec("wc -l /test.txt");
    expect(result.stdout.trim()).toMatch(/^\s*3\s+\/test\.txt$/);
  });

  it("should count only words with -w", async () => {
    const env = new Bash({
      files: { "/test.txt": "one two three four\n" }
    });
    const result = await env.exec("wc -w /test.txt");
    expect(result.stdout.trim()).toMatch(/^\s*4\s+\/test\.txt$/);
  });

  it("should count only characters with -c", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello\n" }
    });
    const result = await env.exec("wc -c /test.txt");
    expect(result.stdout.trim()).toMatch(/^\s*6\s+\/test\.txt$/);
  });

  it("should count only characters with -m", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello\n" }
    });
    const result = await env.exec("wc -m /test.txt");
    expect(result.stdout.trim()).toMatch(/^\s*6\s+\/test\.txt$/);
  });

  it("should combine -lw flags", async () => {
    const env = new Bash({
      files: { "/test.txt": "one two\nthree\n" }
    });
    const result = await env.exec("wc -lw /test.txt");
    expect(result.stdout).toMatch(/\s*2\s+/); // 2 lines
    expect(result.stdout).toMatch(/\s+3\s+/); // 3 words
    expect(result.stdout).not.toMatch(/\s+14\s+/); // not showing chars
  });

  it("should show total for multiple files", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "one\n",
        "/b.txt": "two\n"
      }
    });
    const result = await env.exec("wc /a.txt /b.txt");
    expect(result.stdout).toContain("/a.txt");
    expect(result.stdout).toContain("/b.txt");
    expect(result.stdout).toContain("total");
  });

  it("should read from stdin", async () => {
    const env = new Bash();
    const result = await env.exec('echo "hello world" | wc -w');
    expect(result.stdout.trim()).toBe("2");
  });

  it("should handle empty file", async () => {
    const env = new Bash({
      files: { "/empty.txt": "" }
    });
    const result = await env.exec("wc /empty.txt");
    expect(result.stdout).toMatch(/\s*0\s+/); // 0 lines
  });

  it("should error on missing file", async () => {
    const env = new Bash();
    const result = await env.exec("wc /missing.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No such file or directory");
  });

  it("should handle --lines flag", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\n" }
    });
    const result = await env.exec("wc --lines /test.txt");
    expect(result.stdout.trim()).toMatch(/^\s*2\s+\/test\.txt$/);
  });

  it("should handle --words flag", async () => {
    const env = new Bash({
      files: { "/test.txt": "one two\n" }
    });
    const result = await env.exec("wc --words /test.txt");
    expect(result.stdout.trim()).toMatch(/^\s*2\s+\/test\.txt$/);
  });

  it("should handle --bytes flag", async () => {
    const env = new Bash({
      files: { "/test.txt": "hi\n" }
    });
    const result = await env.exec("wc --bytes /test.txt");
    expect(result.stdout.trim()).toMatch(/^\s*3\s+\/test\.txt$/);
  });

  it("should count lines with content ending in newline", async () => {
    const env = new Bash({
      files: { "/test.txt": "line1\nline2\n" }
    });
    const result = await env.exec("wc -l /test.txt");
    expect(result.stdout.trim()).toMatch(/^\s*2\s+\/test\.txt$/);
  });

  it("should handle multiple spaces between words", async () => {
    const env = new Bash({
      files: { "/test.txt": "one   two    three\n" }
    });
    const result = await env.exec("wc -w /test.txt");
    expect(result.stdout.trim()).toMatch(/^\s*3\s+\/test\.txt$/);
  });
});
