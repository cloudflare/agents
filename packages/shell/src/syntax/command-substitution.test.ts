import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Command Substitution $(cmd)", () => {
  it("should capture echo output", async () => {
    const env = new Bash();
    const result = await env.exec("echo $(echo hello)");
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
  });

  it("should capture command output in variable (within same exec)", async () => {
    const env = new Bash();
    const result = await env.exec("X=$(echo world); echo $X");
    expect(result.stdout).toBe("world\n");
  });

  it("should work with cat", async () => {
    const env = new Bash({
      files: { "/test.txt": "file content" }
    });
    const result = await env.exec("echo $(cat /test.txt)");
    expect(result.stdout).toBe("file content\n");
  });

  it("should strip trailing newline from substitution", async () => {
    const env = new Bash();
    const result = await env.exec("echo prefix-$(echo middle)-suffix");
    expect(result.stdout).toBe("prefix-middle-suffix\n");
  });

  it("should handle nested command substitution", async () => {
    const env = new Bash();
    const result = await env.exec("echo $(echo $(echo nested))");
    expect(result.stdout).toBe("nested\n");
  });

  it("should work with pipes inside substitution", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello\nworld\n" }
    });
    const result = await env.exec("echo $(cat /test.txt | grep world)");
    expect(result.stdout).toBe("world\n");
  });

  it("should convert newlines to spaces in unquoted command substitution", async () => {
    const env = new Bash({
      files: { "/test.txt": "line1\nline2\nline3" }
    });
    const result = await env.exec("echo $(cat /test.txt)");
    // In bash, newlines become spaces when echoed unquoted
    expect(result.stdout).toBe("line1 line2 line3\n");
  });

  it("should work with wc -l", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\nc\n" }
    });
    const result = await env.exec("echo lines: $(wc -l < /test.txt)");
    expect(result.stdout).toMatch(/lines:\s+3/);
  });

  it("should work in variable assignment (within same exec)", async () => {
    const env = new Bash();
    const result = await env.exec("COUNT=$(echo 42); echo $COUNT");
    expect(result.stdout).toBe("42\n");
  });

  it("should handle empty command output", async () => {
    const env = new Bash();
    const result = await env.exec("echo prefix$(echo)suffix");
    expect(result.stdout).toBe("prefixsuffix\n");
  });
});

describe("Arithmetic Expansion $((expr))", () => {
  it("should evaluate simple addition", async () => {
    const env = new Bash();
    const result = await env.exec("echo $((1 + 2))");
    expect(result.stdout).toBe("3\n");
  });

  it("should evaluate subtraction", async () => {
    const env = new Bash();
    const result = await env.exec("echo $((10 - 3))");
    expect(result.stdout).toBe("7\n");
  });

  it("should evaluate multiplication", async () => {
    const env = new Bash();
    const result = await env.exec("echo $((4 * 5))");
    expect(result.stdout).toBe("20\n");
  });

  it("should evaluate division (integer)", async () => {
    const env = new Bash();
    const result = await env.exec("echo $((10 / 3))");
    expect(result.stdout).toBe("3\n");
  });

  it("should evaluate modulo", async () => {
    const env = new Bash();
    const result = await env.exec("echo $((10 % 3))");
    expect(result.stdout).toBe("1\n");
  });

  it("should evaluate power", async () => {
    const env = new Bash();
    const result = await env.exec("echo $((2 ** 8))");
    expect(result.stdout).toBe("256\n");
  });

  it("should handle parentheses", async () => {
    const env = new Bash();
    const result = await env.exec("echo $(((2 + 3) * 4))");
    expect(result.stdout).toBe("20\n");
  });

  it("should handle variables with $ prefix", async () => {
    const env = new Bash({ env: { X: "5" } });
    const result = await env.exec("echo $(($X + 3))");
    expect(result.stdout).toBe("8\n");
  });

  it("should handle variables without $ prefix", async () => {
    const env = new Bash({ env: { X: "5" } });
    const result = await env.exec("echo $((X + 3))");
    expect(result.stdout).toBe("8\n");
  });

  it("should handle negative numbers", async () => {
    const env = new Bash();
    const result = await env.exec("echo $((-5 + 3))");
    expect(result.stdout).toBe("-2\n");
  });

  it("should handle comparison operators", async () => {
    const env = new Bash();
    expect((await env.exec("echo $((5 > 3))")).stdout).toBe("1\n");
    expect((await env.exec("echo $((5 < 3))")).stdout).toBe("0\n");
    expect((await env.exec("echo $((5 == 5))")).stdout).toBe("1\n");
    expect((await env.exec("echo $((5 != 5))")).stdout).toBe("0\n");
  });

  it("should handle logical operators", async () => {
    const env = new Bash();
    expect((await env.exec("echo $((1 && 1))")).stdout).toBe("1\n");
    expect((await env.exec("echo $((1 && 0))")).stdout).toBe("0\n");
    expect((await env.exec("echo $((0 || 1))")).stdout).toBe("1\n");
    expect((await env.exec("echo $((0 || 0))")).stdout).toBe("0\n");
  });

  it("should handle bitwise operators", async () => {
    const env = new Bash();
    expect((await env.exec("echo $((5 & 3))")).stdout).toBe("1\n"); // 101 & 011 = 001
    expect((await env.exec("echo $((5 | 3))")).stdout).toBe("7\n"); // 101 | 011 = 111
    expect((await env.exec("echo $((5 ^ 3))")).stdout).toBe("6\n"); // 101 ^ 011 = 110
  });

  it("should handle shift operators", async () => {
    const env = new Bash();
    expect((await env.exec("echo $((1 << 4))")).stdout).toBe("16\n");
    expect((await env.exec("echo $((16 >> 2))")).stdout).toBe("4\n");
  });

  it("should handle complex expressions", async () => {
    const env = new Bash();
    const result = await env.exec("echo $((2 + 3 * 4 - 1))");
    expect(result.stdout).toBe("13\n"); // 2 + 12 - 1 = 13
  });

  it("should work in variable assignment (within same exec)", async () => {
    const env = new Bash();
    const result = await env.exec("SUM=$((10 + 20)); echo $SUM");
    expect(result.stdout).toBe("30\n");
  });

  it("should handle increment pattern (within same exec)", async () => {
    const env = new Bash();
    const result = await env.exec("N=5; N=$((N + 1)); echo $N");
    expect(result.stdout).toBe("6\n");
  });
});
