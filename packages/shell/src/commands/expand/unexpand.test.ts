import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("unexpand", () => {
  it("converts leading spaces to tabs (default 8)", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '        hello' | unexpand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\thello");
  });

  it("handles partial tab stops", async () => {
    const bash = new Bash();
    // 4 spaces is not enough for an 8-space tab
    const result = await bash.exec("printf '    hello' | unexpand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("    hello");
  });

  it("handles 16 leading spaces", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '                hello' | unexpand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\t\thello");
  });

  it("does not convert spaces after text by default", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello        world' | unexpand");
    expect(result.exitCode).toBe(0);
    // Spaces after 'hello' are not leading, so they stay as spaces
    expect(result.stdout).toBe("hello        world");
  });

  it("converts all spaces with -a", async () => {
    const bash = new Bash();
    // 'hello' is 5 chars, then 3 spaces to reach col 8, then 'world'
    const result = await bash.exec("printf 'hello   world' | unexpand -a");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\tworld");
  });

  it("uses custom tab width with -t", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '    hello' | unexpand -t 4");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\thello");
  });

  it("handles empty input", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | unexpand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("handles input with no spaces", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello' | unexpand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("handles multiple lines", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      "printf '        a\\n        b\\n' | unexpand"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\ta\n\tb\n");
  });

  it("preserves trailing newline", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello\\n' | unexpand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("handles no trailing newline", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello' | unexpand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("reads from file", async () => {
    const bash = new Bash({
      files: {
        "/test.txt": "        hello\n        world\n"
      }
    });
    const result = await bash.exec("unexpand /test.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\thello\n\tworld\n");
  });

  it("reads from multiple files", async () => {
    const bash = new Bash({
      files: {
        "/a.txt": "        a\n",
        "/b.txt": "        b\n"
      }
    });
    const result = await bash.exec("unexpand /a.txt /b.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\ta\n\tb\n");
  });

  it("handles file not found", async () => {
    const bash = new Bash();
    const result = await bash.exec("unexpand /nonexistent.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("no such file or directory");
  });

  it("shows help with --help", async () => {
    const bash = new Bash();
    const result = await bash.exec("unexpand --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("unexpand");
    expect(result.stdout).toContain("tab");
  });

  it("errors on invalid tab size", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | unexpand -t abc");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid tab size");
  });

  it("handles --all flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello   world' | unexpand --all");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\tworld");
  });

  it("handles --tabs= option", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '    hello' | unexpand --tabs=4");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\thello");
  });

  it("handles mixed tabs and spaces", async () => {
    const bash = new Bash();
    // Tab then spaces
    const result = await bash.exec("printf '\\t    hello' | unexpand");
    expect(result.exitCode).toBe(0);
    // Original tab preserved, 4 spaces not enough for another tab
    expect(result.stdout).toBe("\t    hello");
  });

  it("handles 12 spaces with 4-space tabs", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      "printf '            hello' | unexpand -t 4"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\t\t\thello");
  });

  it("errors on unknown short flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | unexpand -x");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid option");
  });

  it("errors on unknown long flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | unexpand --unknown");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unrecognized option");
  });
});
