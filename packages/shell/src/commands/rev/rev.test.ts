import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("rev", () => {
  it("reverses a simple string", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'hello' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("olleh\n");
  });

  it("reverses multiple lines", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'abc\\ndef\\nghi' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("cba\nfed\nihg");
  });

  it("reverses multiple lines with trailing newline", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'abc\\ndef\\n' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("cba\nfed\n");
  });

  it("handles empty input", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf '' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("handles single character", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'a' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\n");
  });

  it("handles empty lines", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\n\\nb\\n' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\n\nb\n");
  });

  it("reads from file", async () => {
    const bash = new Bash({
      files: {
        "/test.txt": "hello\nworld\n"
      }
    });
    const result = await bash.exec("rev /test.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("olleh\ndlrow\n");
  });

  it("reads from multiple files", async () => {
    const bash = new Bash({
      files: {
        "/a.txt": "abc\n",
        "/b.txt": "def\n"
      }
    });
    const result = await bash.exec("rev /a.txt /b.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("cba\nfed\n");
  });

  it("handles file not found", async () => {
    const bash = new Bash();
    const result = await bash.exec("rev /nonexistent.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("no such file or directory");
  });

  it("handles Unicode characters", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo '日本語' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("語本日\n");
  });

  it("handles emoji", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo '👋🌍' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("🌍👋\n");
  });

  it("shows help with --help", async () => {
    const bash = new Bash();
    const result = await bash.exec("rev --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rev");
    expect(result.stdout).toContain("reverse");
  });

  it("preserves spaces", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'a b c' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("c b a\n");
  });

  it("handles tabs", async () => {
    const bash = new Bash();
    const result = await bash.exec("printf 'a\\tb\\tc' | rev");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("c\tb\ta");
  });

  it("errors on unknown flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'test' | rev -x");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid option");
  });

  it("errors on unknown long flag", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'test' | rev --unknown");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unrecognized option");
  });

  it("handles dash as stdin indicator", async () => {
    const bash = new Bash();
    const result = await bash.exec("echo 'hello' | rev -");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("olleh\n");
  });

  it("handles -- to end options", async () => {
    const bash = new Bash({
      files: {
        "/-file.txt": "test\n"
      }
    });
    const result = await bash.exec("rev -- /-file.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("tset\n");
  });
});
