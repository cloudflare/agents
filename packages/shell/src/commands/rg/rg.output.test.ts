import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("rg output modes", () => {
  it("should count matches with -c", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello\nhello\nhello\n"
      }
    });
    const result = await bash.exec("rg -c hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:3\n");
    expect(result.stderr).toBe("");
  });

  it("should count matches across multiple files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.txt": "hello\nhello\n",
        "/home/user/b.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg -c hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a.txt:2\nb.txt:1\n");
    expect(result.stderr).toBe("");
  });

  it("should list files with -l", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file1.txt": "hello\n",
        "/home/user/file2.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg -l hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file1.txt\nfile2.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should list files without matches with --files-without-match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file1.txt": "hello\n",
        "/home/user/file2.txt": "world\n"
      }
    });
    const result = await bash.exec("rg --files-without-match hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file2.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should show only matching text with -o", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg -o hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:hello\n");
    expect(result.stderr).toBe("");
  });

  it("should show multiple matches per line with -o", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello hello hello\n"
      }
    });
    const result = await bash.exec("rg -o hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt:hello\nfile.txt:hello\nfile.txt:hello\n"
    );
    expect(result.stderr).toBe("");
  });
});

describe("rg context lines", () => {
  it("should show lines after match with -A", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "line1\nhello\nline3\nline4\n"
      }
    });
    const result = await bash.exec("rg -A 1 hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:hello\nfile.txt-3-line3\n");
    expect(result.stderr).toBe("");
  });

  it("should show lines before match with -B", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "line1\nline2\nhello\nline4\n"
      }
    });
    const result = await bash.exec("rg -B 1 hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt-2-line2\nfile.txt:3:hello\n");
    expect(result.stderr).toBe("");
  });

  it("should show context with -C", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "line1\nline2\nhello\nline4\nline5\n"
      }
    });
    const result = await bash.exec("rg -C 1 hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt-2-line2\nfile.txt:3:hello\nfile.txt-4-line4\n"
    );
    expect(result.stderr).toBe("");
  });

  it("should handle context at start of file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "match\nline2\nline3\n"
      }
    });
    const result = await bash.exec("rg -B 2 match");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:match\n");
    expect(result.stderr).toBe("");
  });

  it("should handle context at end of file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "line1\nline2\nmatch\n"
      }
    });
    const result = await bash.exec("rg -A 2 match");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:3:match\n");
    expect(result.stderr).toBe("");
  });

  it("should handle overlapping context from multiple matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "a\nmatch1\nb\nmatch2\nc\n"
      }
    });
    const result = await bash.exec("rg -C 1 match");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt-1-a\nfile.txt:2:match1\nfile.txt-3-b\nfile.txt:4:match2\nfile.txt-5-c\n"
    );
    expect(result.stderr).toBe("");
  });

  it("should support combined context format -A2", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "a\nhello\nb\nc\nd\n"
      }
    });
    const result = await bash.exec("rg -A2 hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt:2:hello\nfile.txt-3-b\nfile.txt-4-c\n"
    );
    expect(result.stderr).toBe("");
  });
});

describe("rg quiet mode", () => {
  it("should suppress output with -q", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg -q hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("should return exit code 1 when no match with -q", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg -q nomatch");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("should exit early on first match with -q", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file1.txt": "hello\n",
        "/home/user/file2.txt": "hello\n",
        "/home/user/file3.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg -q hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("should work with --quiet long form", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg --quiet hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("rg help", () => {
  it("should show help with --help", async () => {
    const bash = new Bash();
    const result = await bash.exec("rg --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rg");
    expect(result.stdout).toContain("recursively search");
    expect(result.stderr).toBe("");
  });
});
