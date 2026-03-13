import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("fold", () => {
  it("wraps at 80 columns by default", async () => {
    const bash = new Bash();
    const longLine = "a".repeat(100);
    const result = await bash.exec(`echo '${longLine}' | fold`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${"a".repeat(80)}\n${"a".repeat(20)}\n`);
  });

  it("wraps at specified width with -w", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'hello world' | fold -w 5");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n worl\nd\n");
  });

  it("wraps at specified width with -w attached", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo '1234567890' | fold -w5");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("12345\n67890\n");
  });

  it("breaks at spaces with -s", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'hello world foo bar' | fold -sw 10");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello \nworld foo \nbar\n");
  });

  it("breaks at spaces with -s when word fits exactly", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'abc defgh' | fold -sw 6");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abc \ndefgh\n");
  });

  it("handles lines shorter than width", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'short' | fold -w 80");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("short\n");
  });

  it("handles empty input", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | fold");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("handles empty lines", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\n\\nb\\n' | fold -w 5");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\n\nb\n");
  });

  it("preserves trailing newline", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello\\n' | fold -w 5");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("handles no trailing newline", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello' | fold -w 5");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("reads from file", async () => {
    const bash = new Bash({
      files: {
        "/test.txt": "1234567890\n"
      }
    });
    const result = await bash.exec("fold -w 5 /test.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("12345\n67890\n");
  });

  it("reads from multiple files", async () => {
    const bash = new Bash({
      files: {
        "/a.txt": "aaaaaaaaaa\n",
        "/b.txt": "bbbbbbbbbb\n"
      }
    });
    const result = await bash.exec("fold -w 5 /a.txt /b.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("aaaaa\naaaaa\nbbbbb\nbbbbb\n");
  });

  it("handles file not found", async () => {
    const bash = new Bash();
    const result = await bash.exec("fold /nonexistent.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("no such file or directory");
  });

  it("shows help with --help", async () => {
    const bash = new Bash();
    const result = await bash.exec("fold --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fold");
    expect(result.stdout).toContain("wrap");
  });

  it("errors on invalid width", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'x' | fold -w abc");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid number of columns");
  });

  it("errors on zero width", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'x' | fold -w 0");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid number of columns");
  });

  it("handles tabs expanding to 8-column boundary", async () => {
    const bash = new Bash();
    // Tab at position 0 expands to 8 columns
    const result = await bash.exec("printf '\\tabc' | fold -w 10");
    expect(result.exitCode).toBe(0);
    // Tab = 8 cols, 'a' = 1 (9), 'b' = 1 (10), 'c' wraps
    expect(result.stdout).toBe("\tab\nc");
  });

  it("handles combined -sb flags", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'hello world' | fold -sb -w 8");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello \nworld\n");
  });

  it("handles multiple lines", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      "printf '12345678901234567890\\nabcdefghij\\n' | fold -w 10"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1234567890\n1234567890\nabcdefghij\n");
  });

  it("handles -s with no spaces in line", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'abcdefghij' | fold -sw 5");
    expect(result.exitCode).toBe(0);
    // Without spaces, breaks at width
    expect(result.stdout).toBe("abcde\nfghij\n");
  });

  it("handles -s with space at exact boundary", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'abcd efgh' | fold -sw 5");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("abcd \nefgh\n");
  });

  it("errors on unknown short flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'x' | fold -x");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid option");
  });

  it("errors on unknown long flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'x' | fold --unknown");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unrecognized option");
  });
});
