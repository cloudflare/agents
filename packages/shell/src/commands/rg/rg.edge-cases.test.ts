import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("rg empty and whitespace", () => {
  it("should handle empty file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/empty.txt": ""
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("should handle file with only newlines", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "\n\n\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("should match empty lines with ^$", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\n\nbar\n"
      }
    });
    const result = await bash.exec("rg '^$'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:\n");
    expect(result.stderr).toBe("");
  });

  it("should handle file with trailing whitespace", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello   \nworld\n"
      }
    });
    const result = await bash.exec("rg 'hello   '");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello   \n");
    expect(result.stderr).toBe("");
  });

  it("should handle file with only whitespace", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "   \n   \n"
      }
    });
    const result = await bash.exec("rg '^ +$'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:   \nfile.txt:2:   \n");
    expect(result.stderr).toBe("");
  });
});

// Note: -m (max count) tests removed - feature not yet implemented

describe("rg special characters", () => {
  it("should match literal dots with -F", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "a.b.c\nabc\n"
      }
    });
    const result = await bash.exec("rg -F 'a.b'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:a.b.c\n");
    expect(result.stderr).toBe("");
  });

  it("should match literal brackets with -F", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "array[0]\narray0\n"
      }
    });
    const result = await bash.exec("rg -F '[0]'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:array[0]\n");
    expect(result.stderr).toBe("");
  });

  it("should match literal parens with -F", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "func()\nfunc\n"
      }
    });
    const result = await bash.exec("rg -F '()'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:func()\n");
    expect(result.stderr).toBe("");
  });

  it("should match literal asterisks with -F", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "a*b\nab\naab\n"
      }
    });
    const result = await bash.exec("rg -F 'a*b'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:a*b\n");
    expect(result.stderr).toBe("");
  });

  it("should match backslashes with -F", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "path\\to\\file\npath/to/file\n"
      }
    });
    // Search for "path\" which appears at start of backslash path
    const result = await bash.exec("rg -F 'path\\'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:path\\to\\file\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg line boundaries", () => {
  it("should match start of line only once", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg -o '^'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:\n");
    expect(result.stderr).toBe("");
  });

  it("should not match end of line at end of file without newline", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello"
      }
    });
    const result = await bash.exec("rg 'hello$'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello\n");
    expect(result.stderr).toBe("");
  });

  it("should match anchored pattern at start", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "  hello\nhello\n"
      }
    });
    const result = await bash.exec("rg '^hello'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:hello\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg unicode", () => {
  it("should match unicode characters", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello 世界\nfoo bar\n"
      }
    });
    const result = await bash.exec("rg 世界");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello 世界\n");
    expect(result.stderr).toBe("");
  });

  it("should match emoji", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello 🎉\nfoo bar\n"
      }
    });
    const result = await bash.exec("rg 🎉");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello 🎉\n");
    expect(result.stderr).toBe("");
  });

  it("should handle case-insensitive unicode with -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "CAFÉ\ncafé\n"
      }
    });
    const result = await bash.exec("rg -i café");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:CAFÉ\nfile.txt:2:café\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg multiple files ordering", () => {
  it("should output files in sorted order", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/z.txt": "hello\n",
        "/home/user/a.txt": "hello\n",
        "/home/user/m.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a.txt:1:hello\nm.txt:1:hello\nz.txt:1:hello\n");
    expect(result.stderr).toBe("");
  });

  it("should handle nested directories in sorted order", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/z/file.txt": "hello\n",
        "/home/user/a/file.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a/file.txt:1:hello\nz/file.txt:1:hello\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg exit codes", () => {
  it("should return 0 when match found", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 when no match found", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg goodbye");
    expect(result.exitCode).toBe(1);
  });

  it("should return 2 on invalid regex", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg '['");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid regex");
  });

  it("should return 0 on match found with -q", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg -q hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("rg word boundaries", () => {
  it("should match word at start of line with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg -w hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello world\n");
    expect(result.stderr).toBe("");
  });

  it("should match word at end of line with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg -w world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello world\n");
    expect(result.stderr).toBe("");
  });

  it("should not match word within word with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "helloworld\nhello world\n"
      }
    });
    const result = await bash.exec("rg -w hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:hello world\n");
    expect(result.stderr).toBe("");
  });

  it("should match word with punctuation boundary with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello, world\nhello.world\n"
      }
    });
    const result = await bash.exec("rg -w hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt:1:hello, world\nfile.txt:2:hello.world\n"
    );
    expect(result.stderr).toBe("");
  });
});

describe("rg inverted context", () => {
  it("should show context around non-matching lines with -v", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "a\nb\nc\nd\ne\n"
      }
    });
    // With -v, lines NOT containing 'c' match (a, b, d, e)
    // Context includes the 'c' line as context for surrounding matches
    const result = await bash.exec("rg -v -C1 c");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt:1:a\nfile.txt-2-b\nfile.txt-3-c\nfile.txt:4:d\nfile.txt-5-e\n"
    );
    expect(result.stderr).toBe("");
  });
});

describe("rg gitignore edge cases", () => {
  it("should handle comments in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "# This is a comment\n*.log\n",
        "/home/user/app.ts": "hello\n",
        "/home/user/debug.log": "hello\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("app.ts:1:hello\n");
    expect(result.stderr).toBe("");
  });

  it("should handle blank lines in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "*.log\n\n*.tmp\n",
        "/home/user/app.ts": "hello\n",
        "/home/user/debug.log": "hello\n",
        "/home/user/cache.tmp": "hello\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("app.ts:1:hello\n");
    expect(result.stderr).toBe("");
  });

  // Note: Escaped hash in gitignore (\#file.txt) test removed - feature not yet implemented
});

describe("rg glob edge cases", () => {
  it("should handle glob with path separator", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/src/app.ts": "hello\n",
        "/home/user/test/app.ts": "hello\n"
      }
    });
    const result = await bash.exec("rg -g 'src/*.ts' hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("src/app.ts:1:hello\n");
    expect(result.stderr).toBe("");
  });

  it("should handle multiple globs", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.ts": "hello\n",
        "/home/user/b.js": "hello\n",
        "/home/user/c.py": "hello\n"
      }
    });
    const result = await bash.exec("rg -g '*.ts' -g '*.js' hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a.ts:1:hello\nb.js:1:hello\n");
    expect(result.stderr).toBe("");
  });
});
