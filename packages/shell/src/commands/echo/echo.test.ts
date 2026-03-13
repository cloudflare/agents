import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("echo", () => {
  it("should echo simple text", async () => {
    const env = new Bash();
    const result = await env.exec("echo hello world");
    expect(result.stdout).toBe("hello world\n");
    expect(result.exitCode).toBe(0);
  });

  it("should echo empty string", async () => {
    const env = new Bash();
    const result = await env.exec("echo");
    expect(result.stdout).toBe("\n");
  });

  it("should echo multiple arguments", async () => {
    const env = new Bash();
    const result = await env.exec("echo one two three");
    expect(result.stdout).toBe("one two three\n");
  });

  it("should handle -n flag (no newline)", async () => {
    const env = new Bash();
    const result = await env.exec("echo -n hello");
    expect(result.stdout).toBe("hello");
  });

  it("should handle -e flag with \\n (newline)", async () => {
    const env = new Bash();
    const result = await env.exec('echo -e "hello\\nworld"');
    expect(result.stdout).toBe("hello\nworld\n");
  });

  it("should handle -e flag with \\t (tab)", async () => {
    const env = new Bash();
    const result = await env.exec('echo -e "col1\\tcol2"');
    expect(result.stdout).toBe("col1\tcol2\n");
  });

  it("should handle -e flag with \\r (carriage return)", async () => {
    const env = new Bash();
    const result = await env.exec('echo -e "hello\\rworld"');
    expect(result.stdout).toBe("hello\rworld\n");
  });

  it("should handle -e flag with multiple escape sequences", async () => {
    const env = new Bash();
    const result = await env.exec('echo -e "line1\\nline2\\ttabbed"');
    expect(result.stdout).toBe("line1\nline2\ttabbed\n");
  });

  it("should handle combined -en flags", async () => {
    const env = new Bash();
    const result = await env.exec('echo -en "hello\\nworld"');
    expect(result.stdout).toBe("hello\nworld");
  });

  it("should handle combined -ne flags", async () => {
    const env = new Bash();
    const result = await env.exec('echo -ne "a\\tb"');
    expect(result.stdout).toBe("a\tb");
  });

  it("should handle -E flag (disable escapes)", async () => {
    const env = new Bash();
    const result = await env.exec('echo -E "hello\\nworld"');
    expect(result.stdout).toBe("hello\\nworld\n");
  });

  it("should preserve quoted strings with spaces", async () => {
    const env = new Bash();
    const result = await env.exec('echo "hello world"');
    expect(result.stdout).toBe("hello world\n");
  });

  it("should handle single quotes", async () => {
    const env = new Bash();
    const result = await env.exec("echo 'hello world'");
    expect(result.stdout).toBe("hello world\n");
  });

  it("should handle mixed quotes", async () => {
    const env = new Bash();
    const result = await env.exec("echo \"hello\" 'world'");
    expect(result.stdout).toBe("hello world\n");
  });

  it("should handle multiple -e escape sequences", async () => {
    const env = new Bash();
    const result = await env.exec('echo -e "a\\nb\\nc"');
    expect(result.stdout).toBe("a\nb\nc\n");
  });

  it("should echo text starting with dash when using --", async () => {
    const env = new Bash();
    const result = await env.exec("echo -- -n");
    expect(result.stdout).toBe("-- -n\n");
  });
});
