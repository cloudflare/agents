import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("nl", () => {
  it("numbers lines from stdin", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\nc' | nl");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("     1\ta\n     2\tb\n     3\tc");
  });

  it("numbers lines from file", async () => {
    const bash = new Bash({
      files: {
        "/test.txt": "line1\nline2\nline3\n"
      }
    });
    const result = await bash.exec("nl /test.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("     1\tline1\n     2\tline2\n     3\tline3\n");
  });

  it("skips empty lines with default style (t)", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\n\\nb\\n' | nl");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("     1\ta\n      \t\n     2\tb\n");
  });

  it("numbers all lines with -ba", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\n\\nb\\n' | nl -ba");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("     1\ta\n     2\t\n     3\tb\n");
  });

  it("numbers all lines with -b a (space)", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\n\\nb\\n' | nl -b a");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("     1\ta\n     2\t\n     3\tb\n");
  });

  it("numbers no lines with -bn", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | nl -bn");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("      \ta\n      \tb\n");
  });

  it("left justifies with -n ln", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | nl -n ln");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1     \ta\n2     \tb\n");
  });

  it("right justifies with zeros with -n rz", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | nl -n rz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("000001\ta\n000002\tb\n");
  });

  it("sets width with -w", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | nl -w 3");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("  1\ta\n  2\tb\n");
  });

  it("sets width with -w and rz format", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | nl -w 3 -n rz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("001\ta\n002\tb\n");
  });

  it("sets separator with -s", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | nl -s ': '");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("     1: a\n     2: b\n");
  });

  it("sets starting number with -v", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\n' | nl -v 10");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("    10\ta\n    11\tb\n");
  });

  it("sets increment with -i", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\nc\\n' | nl -i 5");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("     1\ta\n     6\tb\n    11\tc\n");
  });

  it("combines multiple options", async () => {
    const bash = new Bash();
    const result = await bash.exec(
      "printf 'a\\nb\\nc\\n' | nl -ba -n rz -w 4 -s '|' -v 100 -i 10"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0100|a\n0110|b\n0120|c\n");
  });

  it("handles empty input", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | nl");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("handles single line without newline", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'hello' | nl");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("     1\thello");
  });

  it("handles multiple files", async () => {
    const bash = new Bash({
      files: {
        "/a.txt": "one\ntwo\n",
        "/b.txt": "three\nfour\n"
      }
    });
    const result = await bash.exec("nl /a.txt /b.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour\n"
    );
  });

  it("continues numbering across files", async () => {
    const bash = new Bash({
      files: {
        "/a.txt": "one\n",
        "/b.txt": "two\n"
      }
    });
    const result = await bash.exec("nl -v 10 /a.txt /b.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("    10\tone\n    11\ttwo\n");
  });

  it("handles file not found", async () => {
    const bash = new Bash();
    const result = await bash.exec("nl /nonexistent.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("no such file or directory");
  });

  it("shows help with --help", async () => {
    const bash = new Bash();
    const result = await bash.exec("nl --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nl");
    expect(result.stdout).toContain("number");
  });

  it("errors on invalid body style", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | nl -b x");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid body numbering style");
  });

  it("errors on invalid number format", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | nl -n xx");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid line numbering format");
  });

  it("errors on invalid width", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | nl -w abc");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid line number field width");
  });

  it("handles negative start number", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\nb\\nc\\n' | nl -v -1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("    -1\ta\n     0\tb\n     1\tc\n");
  });

  it("handles whitespace-only lines as non-empty with -bt", async () => {
    const bash = new Bash();
    // With -bt (default), whitespace-only lines are considered empty
    const result = await bash.exec("printf 'a\\n   \\nb\\n' | nl");
    expect(result.exitCode).toBe(0);
    // Whitespace-only line is considered empty and not numbered
    expect(result.stdout).toBe("     1\ta\n      \t   \n     2\tb\n");
  });

  it("errors on unknown short flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | nl -x");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid option");
  });

  it("errors on unknown long flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'x' | nl --unknown");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unrecognized option");
  });
});
