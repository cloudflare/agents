import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("expand", () => {
  it("converts tabs to 8 spaces by default", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\tb' | expand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a       b");
  });

  it("handles tab at start of line", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '\\thello' | expand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("        hello");
  });

  it("handles multiple tabs", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\tb\\tc' | expand");
    expect(result.exitCode).toBe(0);
    // a at col 0, tab to col 8, b at col 8, tab to col 16, c at col 16
    expect(result.stdout).toBe("a       b       c");
  });

  it("uses custom tab width with -t", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\tb' | expand -t 4");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a   b");
  });

  it("uses custom tab width with -t attached", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\tb' | expand -t4");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a   b");
  });

  it("handles custom tab stop list", async () => {
    const bash = new Bash();
    // Tab stops at 4 and 8
    const result = await bash.exec("printf '\\ta\\tb' | expand -t 4,8");
    expect(result.exitCode).toBe(0);
    // First tab goes to col 4, 'a' at col 4, second tab goes to col 8, 'b' at col 8
    expect(result.stdout).toBe("    a   b");
  });

  it("handles -i for leading tabs only", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '\\ta\\tb' | expand -i");
    expect(result.exitCode).toBe(0);
    // Leading tab expanded, but tab after 'a' is not
    expect(result.stdout).toBe("        a\tb");
  });

  it("handles empty input", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | expand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("handles input with no tabs", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello world' | expand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello world");
  });

  it("handles multiple lines", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '\\ta\\n\\tb\\n' | expand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("        a\n        b\n");
  });

  it("preserves trailing newline", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello\\n' | expand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("handles no trailing newline", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello' | expand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello");
  });

  it("reads from file", async () => {
    const bash = new Bash({
      files: {
        "/test.txt": "\thello\n\tworld\n"
      }
    });
    const result = await bash.exec("expand /test.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("        hello\n        world\n");
  });

  it("reads from multiple files", async () => {
    const bash = new Bash({
      files: {
        "/a.txt": "\ta\n",
        "/b.txt": "\tb\n"
      }
    });
    const result = await bash.exec("expand /a.txt /b.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("        a\n        b\n");
  });

  it("handles file not found", async () => {
    const bash = new Bash();
    const result = await bash.exec("expand /nonexistent.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("no such file or directory");
  });

  it("shows help with --help", async () => {
    const bash = new Bash();
    const result = await bash.exec("expand --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("expand");
    expect(result.stdout).toContain("tab");
  });

  it("errors on invalid tab size", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | expand -t abc");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid tab size");
  });

  it("errors on zero tab size", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | expand -t 0");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid tab size");
  });

  it("handles tab alignment correctly", async () => {
    const bash = new Bash();
    // 'ab' is 2 chars, tab should expand to 6 spaces to reach column 8
    const result = await bash.exec("printf 'ab\\tc' | expand");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ab      c");
  });

  it("handles consecutive tabs", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '\\t\\ta' | expand");
    expect(result.exitCode).toBe(0);
    // First tab: 8 spaces, second tab: 8 more spaces, then 'a'
    expect(result.stdout).toBe("                a");
  });

  it("handles --initial flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '\\ta\\tb' | expand --initial");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("        a\tb");
  });

  it("handles --tabs= option", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\tb' | expand --tabs=4");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a   b");
  });

  it("errors on unknown short flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | expand -x");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid option");
  });

  it("errors on unknown long flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | expand --unknown");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unrecognized option");
  });
});
