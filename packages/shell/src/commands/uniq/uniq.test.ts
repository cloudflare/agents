import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("uniq command", () => {
  const createEnv = () =>
    new Bash({
      files: {
        "/test/adjacent.txt": "apple\napple\nbanana\nbanana\nbanana\ncherry\n",
        "/test/mixed.txt": "a\nb\na\nc\nc\n",
        "/test/single.txt": "one\ntwo\nthree\n",
        "/test/all-same.txt": "hello\nhello\nhello\n"
      },
      cwd: "/test"
    });

  it("should remove adjacent duplicates", async () => {
    const env = createEnv();
    const result = await env.exec("uniq /test/adjacent.txt");
    expect(result.stdout).toBe("apple\nbanana\ncherry\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should count occurrences with -c", async () => {
    const env = createEnv();
    const result = await env.exec("uniq -c /test/adjacent.txt");
    expect(result.stdout).toBe("   2 apple\n   3 banana\n   1 cherry\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should show only duplicates with -d", async () => {
    const env = createEnv();
    const result = await env.exec("uniq -d /test/adjacent.txt");
    expect(result.stdout).toBe("apple\nbanana\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should show only unique lines with -u", async () => {
    const env = createEnv();
    const result = await env.exec("uniq -u /test/adjacent.txt");
    expect(result.stdout).toBe("cherry\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should only remove adjacent duplicates (not all duplicates)", async () => {
    const env = createEnv();
    const result = await env.exec("uniq /test/mixed.txt");
    expect(result.stdout).toBe("a\nb\na\nc\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should read from stdin via pipe", async () => {
    const env = createEnv();
    const result = await env.exec('echo -e "x\\nx\\ny" | uniq');
    expect(result.stdout).toBe("x\ny\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should work with sort for removing all duplicates", async () => {
    const env = createEnv();
    const result = await env.exec("sort /test/mixed.txt | uniq");
    expect(result.stdout).toBe("a\nb\nc\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle file with no duplicates", async () => {
    const env = createEnv();
    const result = await env.exec("uniq /test/single.txt");
    expect(result.stdout).toBe("one\ntwo\nthree\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle file with all same lines", async () => {
    const env = createEnv();
    const result = await env.exec("uniq /test/all-same.txt");
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should return error for non-existent file", async () => {
    const env = createEnv();
    const result = await env.exec("uniq /test/nonexistent.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "uniq: /test/nonexistent.txt: No such file or directory\n"
    );
    expect(result.exitCode).toBe(1);
  });

  it("should handle empty input", async () => {
    const env = createEnv();
    const result = await env.exec('echo -n "" | uniq');
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
