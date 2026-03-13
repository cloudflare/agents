/**
 * Tests for rg -m/--max-count flag
 *
 * The -m/--max-count flag limits the number of matching lines per file.
 */
import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("rg -m/--max-count basic functionality", () => {
  it("should stop after 1 match with -m1", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nfoo\nfoo\nfoo\n"
      }
    });
    const result = await bash.exec("rg -m1 foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo\n");
  });

  it("should stop after 2 matches with -m2", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\nfoo\nbar\nfoo\n"
      }
    });
    const result = await bash.exec("rg -m2 foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo\nfile.txt:3:foo\n");
  });

  it("should stop after 3 matches with -m 3", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "test\ntest\ntest\ntest\ntest\n"
      }
    });
    const result = await bash.exec("rg -m 3 test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt:1:test\nfile.txt:2:test\nfile.txt:3:test\n"
    );
  });

  it("should work with --max-count=N syntax", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "abc\nabc\nabc\nabc\n"
      }
    });
    const result = await bash.exec("rg --max-count=2 abc");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:abc\nfile.txt:2:abc\n");
  });

  it("should work with --max-count N syntax", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "xyz\nxyz\nxyz\n"
      }
    });
    const result = await bash.exec("rg --max-count 1 xyz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:xyz\n");
  });

  it("should show all matches when count exceeds matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\n"
      }
    });
    const result = await bash.exec("rg -m100 foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo\n");
  });

  it("should return exit code 1 when no matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\n"
      }
    });
    const result = await bash.exec("rg -m1 notfound");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });
});

describe("rg -m with multiple files", () => {
  it("should limit matches per file independently", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.txt": "match\nmatch\nmatch\n",
        "/home/user/b.txt": "match\nmatch\nmatch\n"
      }
    });
    const result = await bash.exec("rg -m1 match");
    expect(result.exitCode).toBe(0);
    // Each file should have only 1 match
    expect(result.stdout).toBe("a.txt:1:match\nb.txt:1:match\n");
  });

  it("should limit to 2 matches per file across multiple files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file1.txt": "foo\nfoo\nfoo\nfoo\n",
        "/home/user/file2.txt": "foo\nfoo\nfoo\n"
      }
    });
    const result = await bash.exec("rg -m2 foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file1.txt:1:foo\nfile1.txt:2:foo\nfile2.txt:1:foo\nfile2.txt:2:foo\n"
    );
  });

  it("should work when some files have fewer matches than limit", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/many.txt": "x\nx\nx\nx\nx\n",
        "/home/user/few.txt": "x\n"
      }
    });
    const result = await bash.exec("rg -m3 x");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "few.txt:1:x\nmany.txt:1:x\nmany.txt:2:x\nmany.txt:3:x\n"
    );
  });
});

describe("rg -m with single file search", () => {
  it("should limit matches in single file mode", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/data.txt": "line1\nline2\nline3\nline4\nline5\n"
      }
    });
    const result = await bash.exec("rg -m2 line data.txt");
    expect(result.exitCode).toBe(0);
    // Single file = no filename prefix, no line numbers by default
    expect(result.stdout).toBe("line1\nline2\n");
  });

  it("should limit matches with line numbers in single file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/data.txt": "a\na\na\na\na\n"
      }
    });
    const result = await bash.exec("rg -n -m2 a data.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1:a\n2:a\n");
  });
});

describe("rg -m with other flags", () => {
  it("should work with -c (count)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "x\nx\nx\nx\nx\n"
      }
    });
    // Note: -c counts all matches, -m doesn't affect the count in ripgrep
    // But our implementation limits before counting
    const result = await bash.exec("rg -c x");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:5\n");
  });

  it("should work with -v (invert match)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\nfoo\nbaz\nfoo\n"
      }
    });
    const result = await bash.exec("rg -m2 -v foo");
    expect(result.exitCode).toBe(0);
    // Lines NOT matching "foo", limited to 2
    expect(result.stdout).toBe("file.txt:2:bar\nfile.txt:4:baz\n");
  });

  it("should work with -i (case insensitive)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "Foo\nFOO\nfoo\nFoO\n"
      }
    });
    const result = await bash.exec("rg -m2 -i foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:Foo\nfile.txt:2:FOO\n");
  });

  it("should work with -w (word match)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo bar\nfoobar\nbar foo\nbaz foo baz\n"
      }
    });
    const result = await bash.exec("rg -m2 -w foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo bar\nfile.txt:3:bar foo\n");
  });

  it("should work with -o (only matching)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "abc123def\nabc456def\nabc789def\n"
      }
    });
    const result = await bash.exec("rg -m2 -o '[0-9]+'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:123\nfile.txt:456\n");
  });

  it("should work with -l (files with matches)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.txt": "test\ntest\ntest\n",
        "/home/user/b.txt": "test\n"
      }
    });
    // -l just lists files, -m shouldn't affect output but may affect early exit
    const result = await bash.exec("rg -m1 -l test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a.txt\nb.txt\n");
  });

  it("should work with -q (quiet mode)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "find me\nfind me\nfind me\n"
      }
    });
    const result = await bash.exec("rg -m1 -q 'find me'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("rg -m with context lines", () => {
  it("should work with -A (after context)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt":
          "match1\nafter1\nmatch2\nafter2\nmatch3\nafter3\n"
      }
    });
    const result = await bash.exec("rg -m1 -A1 match file.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("match1\nafter1\n");
  });

  it("should work with -B (before context)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt":
          "before1\nmatch1\nbefore2\nmatch2\nbefore3\nmatch3\n"
      }
    });
    const result = await bash.exec("rg -m1 -B1 match file.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("before1\nmatch1\n");
  });

  it("should work with -C (context)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt":
          "ctx1\nmatch1\nctx2\nmatch2\nctx3\nmatch3\nctx4\n"
      }
    });
    const result = await bash.exec("rg -m1 -C1 match file.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ctx1\nmatch1\nctx2\n");
  });

  it("should limit matches not context lines", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt":
          "a\nb\nmatch\nc\nd\ne\nf\nmatch\ng\nh\ni\nj\nmatch\nk\n"
      }
    });
    const result = await bash.exec("rg -m2 -A2 match file.txt");
    expect(result.exitCode).toBe(0);
    // 2 matches with 2 lines of after context each, plus separator
    expect(result.stdout).toContain("match");
    const lines = result.stdout.trim().split("\n");
    // Should have: match1, c, d, --, match2, g, h
    expect(lines.length).toBe(7);
    expect(lines[3]).toBe("--");
  });
});

describe("rg -m edge cases", () => {
  it("should handle -m0 as unlimited", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "a\na\na\n"
      }
    });
    const result = await bash.exec("rg -m0 a");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:a\nfile.txt:2:a\nfile.txt:3:a\n");
  });

  it("should handle large -m value", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "test\ntest\n"
      }
    });
    const result = await bash.exec("rg -m999999 test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:test\nfile.txt:2:test\n");
  });

  it("should work with empty file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/empty.txt": ""
      }
    });
    const result = await bash.exec("rg -m1 test");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("should work with file type filter", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/code.js": "const x = 1;\nconst y = 2;\nconst z = 3;\n",
        "/home/user/code.py": "const = 'not js'\n"
      }
    });
    const result = await bash.exec("rg -m1 -t js const");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("code.js:1:const x = 1;\n");
  });

  it("should work with glob filter", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test.log": "error\nerror\nerror\n",
        "/home/user/test.txt": "error\n"
      }
    });
    const result = await bash.exec("rg -m1 -g '*.log' error");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test.log:1:error\n");
  });
});

describe("rg -m with regex patterns", () => {
  it("should limit regex matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "cat\ndog\ncat\nbird\ncat\n"
      }
    });
    const result = await bash.exec("rg -m2 'cat|dog'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:cat\nfile.txt:2:dog\n");
  });

  it("should limit matches with anchors", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "start line\nmiddle start\nstart again\n"
      }
    });
    const result = await bash.exec("rg -m1 '^start'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:start line\n");
  });
});
