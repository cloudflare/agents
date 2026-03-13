import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("od command", () => {
  it("should dump stdin in octal format", async () => {
    const env = new Bash();
    const result = await env.exec('echo -n "AB" | od');
    // A=101, B=102 in octal (4-char fields: space + 3-digit octal)
    expect(result.stdout).toBe("0000000  101 102\n0000002\n");
    expect(result.exitCode).toBe(0);
  });

  it("should show character mode with -c", async () => {
    const env = new Bash();
    const result = await env.exec('echo -n "hi" | od -c');
    // Character mode uses 4-char fields (3 spaces + char for printable)
    expect(result.stdout).toBe("0000000    h   i\n0000002\n");
    expect(result.exitCode).toBe(0);
  });

  it("should show escape sequences in character mode", async () => {
    const env = new Bash();
    const result = await env.exec('echo "hello" | od -c');
    // Character mode uses 4-char fields (2 spaces + 2-char escape sequence)
    expect(result.stdout).toBe("0000000    h   e   l   l   o  \\n\n0000006\n");
    expect(result.exitCode).toBe(0);
  });

  it("should suppress addresses with -An", async () => {
    const env = new Bash();
    const result = await env.exec('echo -n "A" | od -An');
    // Octal mode uses 4-char fields (1 space + 3-digit octal)
    expect(result.stdout).toBe(" 101\n");
    expect(result.exitCode).toBe(0);
  });

  it("should read from file", async () => {
    const env = new Bash();
    await env.exec('echo -n "test" > /tmp/od-test.txt');
    const result = await env.exec("od /tmp/od-test.txt");
    // t=164, e=145, s=163, t=164 in octal (4-char fields)
    expect(result.stdout).toBe("0000000  164 145 163 164\n0000004\n");
    expect(result.exitCode).toBe(0);
  });

  it("should error on non-existent file", async () => {
    const env = new Bash();
    const result = await env.exec("od /nonexistent/file.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "od: /nonexistent/file.txt: No such file or directory\n"
    );
  });
});
