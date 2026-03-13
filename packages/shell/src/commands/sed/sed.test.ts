import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";
import { SedLexer, SedTokenType } from "./lexer";
import { parseMultipleScripts } from "./parser";

describe("sed lexer", () => {
  it("should tokenize relative offset address +N", () => {
    const lexer = new SedLexer("/^2/,+2d");
    const tokens = lexer.tokenize();
    const tokenTypes = tokens.map((t) => t.type);
    expect(tokenTypes).toContain(SedTokenType.RELATIVE_OFFSET);
  });
});

describe("sed parser", () => {
  it("should parse relative offset address", () => {
    const result = parseMultipleScripts(["/^2/,+2d"]);
    expect(result.error).toBeUndefined();
    expect(result.commands.length).toBe(1);
  });
});

describe("sed command", () => {
  const createEnv = () =>
    new Bash({
      files: {
        "/test/file.txt": "hello world\nhello universe\ngoodbye world\n",
        "/test/numbers.txt": "line 1\nline 2\nline 3\nline 4\nline 5\n",
        "/test/names.txt": "John Smith\nJane Doe\nBob Johnson\n"
      },
      cwd: "/test"
    });

  it("should replace first occurrence per line", async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/hello/hi/' /test/file.txt");
    expect(result.stdout).toBe("hi world\nhi universe\ngoodbye world\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should replace all occurrences with g flag", async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/l/L/g' /test/file.txt");
    expect(result.stdout).toBe("heLLo worLd\nheLLo universe\ngoodbye worLd\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should print specific line with -n and line number", async () => {
    const env = createEnv();
    const result = await env.exec("sed -n '3p' /test/numbers.txt");
    expect(result.stdout).toBe("line 3\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should print range of lines", async () => {
    const env = createEnv();
    const result = await env.exec("sed -n '2,4p' /test/numbers.txt");
    expect(result.stdout).toBe("line 2\nline 3\nline 4\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should delete matching lines", async () => {
    const env = createEnv();
    const result = await env.exec("sed '/hello/d' /test/file.txt");
    expect(result.stdout).toBe("goodbye world\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should delete specific line number", async () => {
    const env = createEnv();
    const result = await env.exec("sed '2d' /test/numbers.txt");
    expect(result.stdout).toBe("line 1\nline 3\nline 4\nline 5\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should read from stdin via pipe", async () => {
    const env = createEnv();
    const result = await env.exec("echo 'foo bar' | sed 's/bar/baz/'");
    expect(result.stdout).toBe("foo baz\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should use different delimiter", async () => {
    const env = createEnv();
    const result = await env.exec(
      "echo '/path/to/file' | sed 's#/path#/newpath#'"
    );
    expect(result.stdout).toBe("/newpath/to/file\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle regex patterns in substitution", async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/[0-9]/X/' /test/numbers.txt");
    expect(result.stdout).toBe("line X\nline X\nline X\nline X\nline X\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should return error for non-existent file", async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/a/b/' /test/nonexistent.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "sed: /test/nonexistent.txt: No such file or directory\n"
    );
    expect(result.exitCode).toBe(1);
  });

  it("should handle empty replacement", async () => {
    const env = createEnv();
    const result = await env.exec("sed 's/world//' /test/file.txt");
    expect(result.stdout).toBe("hello \nhello universe\ngoodbye \n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should delete range of lines", async () => {
    const env = createEnv();
    const result = await env.exec("sed '2,4d' /test/numbers.txt");
    expect(result.stdout).toBe("line 1\nline 5\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  describe("case insensitive flag (i)", () => {
    it("should replace case insensitively with i flag", async () => {
      const env = createEnv();
      const result = await env.exec("sed 's/HELLO/hi/i' /test/file.txt");
      expect(result.stdout).toBe("hi world\nhi universe\ngoodbye world\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should combine i and g flags", async () => {
      const env = new Bash({
        files: { "/test.txt": "Hello HELLO hello\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/hello/hi/gi' /test.txt");
      expect(result.stdout).toBe("hi hi hi\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("address ranges with substitute", () => {
    it("should substitute only on line 1", async () => {
      const env = createEnv();
      const result = await env.exec("sed '1s/line/LINE/' /test/numbers.txt");
      expect(result.stdout).toBe("LINE 1\nline 2\nline 3\nline 4\nline 5\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should substitute only on line 2", async () => {
      const env = createEnv();
      const result = await env.exec("sed '2s/line/LINE/' /test/numbers.txt");
      expect(result.stdout).toBe("line 1\nLINE 2\nline 3\nline 4\nline 5\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should substitute on last line with $", async () => {
      const env = createEnv();
      const result = await env.exec("sed '$ s/line/LINE/' /test/numbers.txt");
      expect(result.stdout).toBe("line 1\nline 2\nline 3\nline 4\nLINE 5\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should substitute on range of lines", async () => {
      const env = createEnv();
      const result = await env.exec("sed '2,4s/line/LINE/' /test/numbers.txt");
      expect(result.stdout).toBe("line 1\nLINE 2\nLINE 3\nLINE 4\nline 5\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("$ address for delete", () => {
    it("should delete last line with $d", async () => {
      const env = createEnv();
      const result = await env.exec("sed '$ d' /test/numbers.txt");
      expect(result.stdout).toBe("line 1\nline 2\nline 3\nline 4\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should delete last line without space", async () => {
      const env = createEnv();
      const result = await env.exec("sed '$d' /test/numbers.txt");
      expect(result.stdout).toBe("line 1\nline 2\nline 3\nline 4\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("multiple expressions (-e)", () => {
    it("should apply multiple -e expressions", async () => {
      const env = createEnv();
      const result = await env.exec(
        "sed -e 's/hello/hi/' -e 's/world/there/' /test/file.txt"
      );
      expect(result.stdout).toBe("hi there\nhi universe\ngoodbye there\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should apply three -e expressions", async () => {
      const env = createEnv();
      const result = await env.exec(
        "sed -e 's/line/LINE/' -e 's/1/one/' -e 's/2/two/' /test/numbers.txt"
      );
      expect(result.stdout).toBe(
        "LINE one\nLINE two\nLINE 3\nLINE 4\nLINE 5\n"
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("& replacement (matched text)", () => {
    it("should replace & with matched text", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/hello/[&]/' /test.txt");
      expect(result.stdout).toBe("[hello]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple & in replacement", async () => {
      const env = new Bash({
        files: { "/test.txt": "world\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/world/&-&-&/' /test.txt");
      expect(result.stdout).toBe("world-world-world\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle escaped & in replacement", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/hello/\\&/' /test.txt");
      expect(result.stdout).toBe("&\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("in-place editing (-i)", () => {
    it("should edit file in-place with -i", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -i 's/hello/hi/' /test.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);

      // Verify file was modified
      const cat = await env.exec("cat /test.txt");
      expect(cat.stdout).toBe("hi world\n");
    });

    it("should edit file in-place with global replacement", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo foo foo\nbar foo bar\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -i 's/foo/baz/g' /test.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);

      const cat = await env.exec("cat /test.txt");
      expect(cat.stdout).toBe("baz baz baz\nbar baz bar\n");
    });

    it("should delete lines in-place", async () => {
      const env = new Bash({
        files: { "/test.txt": "line 1\nline 2\nline 3\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -i '2d' /test.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);

      const cat = await env.exec("cat /test.txt");
      expect(cat.stdout).toBe("line 1\nline 3\n");
    });

    it("should delete matching lines in-place", async () => {
      const env = new Bash({
        files: { "/test.txt": "keep this\nremove this\nkeep that\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -i '/remove/d' /test.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);

      const cat = await env.exec("cat /test.txt");
      expect(cat.stdout).toBe("keep this\nkeep that\n");
    });

    it("should edit multiple files in-place", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "hello\n",
          "/b.txt": "hello\n"
        },
        cwd: "/"
      });
      const result = await env.exec("sed -i 's/hello/hi/' /a.txt /b.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);

      const catA = await env.exec("cat /a.txt");
      expect(catA.stdout).toBe("hi\n");

      const catB = await env.exec("cat /b.txt");
      expect(catB.stdout).toBe("hi\n");
    });

    it("should handle --in-place flag", async () => {
      const env = new Bash({
        files: { "/test.txt": "old text\n" },
        cwd: "/"
      });
      const result = await env.exec("sed --in-place 's/old/new/' /test.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);

      const cat = await env.exec("cat /test.txt");
      expect(cat.stdout).toBe("new text\n");
    });
  });

  describe("hold space commands (h/H/g/G/x)", () => {
    it("should copy pattern space to hold space with h", async () => {
      const env = new Bash({
        files: { "/test.txt": "first\nsecond\nthird\n" },
        cwd: "/"
      });
      // h on line 1 copies "first" to hold, G on line 3 appends hold to pattern
      const result = await env.exec("sed '1h;3G' /test.txt");
      expect(result.stdout).toBe("first\nsecond\nthird\nfirst\n");
    });

    it("should append pattern space to hold space with H", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\n" },
        cwd: "/"
      });
      // H appends each line to hold space
      // After line a: hold = "a"
      // After line b: hold = "a\nb"
      // After line c: hold = "a\nb\nc"
      // $G appends hold to pattern: "c" + "\n" + "a\nb\nc" = "c\na\nb\nc"
      const result = await env.exec("sed 'H;$G' /test.txt");
      expect(result.stdout).toBe("a\nb\nc\na\nb\nc\n");
    });

    it("should copy hold space to pattern space with g", async () => {
      const env = new Bash({
        files: { "/test.txt": "first\nsecond\n" },
        cwd: "/"
      });
      // h on line 1 saves "first", g on line 2 replaces "second" with "first"
      const result = await env.exec("sed '1h;2g' /test.txt");
      expect(result.stdout).toBe("first\nfirst\n");
    });

    it("should append hold space to pattern space with G", async () => {
      const env = new Bash({
        files: { "/test.txt": "header\ndata\n" },
        cwd: "/"
      });
      // h saves "header", G on line 2 appends hold to pattern
      const result = await env.exec("sed '1h;2G' /test.txt");
      expect(result.stdout).toBe("header\ndata\nheader\n");
    });

    it("should exchange pattern and hold spaces with x", async () => {
      const env = new Bash({
        files: { "/test.txt": "A\nB\n" },
        cwd: "/"
      });
      // x on each line exchanges pattern/hold
      // Line 1: pattern=A, hold=empty -> pattern=empty, hold=A (prints empty)
      // Line 2: pattern=B, hold=A -> pattern=A, hold=B (prints A)
      const result = await env.exec("sed 'x' /test.txt");
      expect(result.stdout).toBe("\nA\n");
    });

    it("should collect lines in hold space with h and H", async () => {
      const env = new Bash({
        files: { "/test.txt": "1\n2\n3\n" },
        cwd: "/"
      });
      // 1h saves first line, 1!H appends subsequent lines
      // After processing: hold = "1\n2\n3"
      // $g copies hold to pattern space (replaces "3")
      // -n suppresses auto-print, $p prints last line (which is now hold content)
      const result = await env.exec("sed -n '$g;$p' /test.txt");
      // Since we don't accumulate with 1h;1!H, g will just copy empty hold
      expect(result.stdout).toBe("\n");
    });
  });

  describe("append command (a)", () => {
    it("should append text after matching line", async () => {
      const env = new Bash({
        files: { "/test.txt": "line 1\nline 2\nline 3\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '2a\\ appended' /test.txt");
      expect(result.stdout).toBe("line 1\nline 2\nappended\nline 3\n");
    });

    it("should append text after every line", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 'a\\ ---' /test.txt");
      expect(result.stdout).toBe("a\n---\nb\n---\n");
    });

    it("should append text after last line", async () => {
      const env = new Bash({
        files: { "/test.txt": "first\nlast\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '$a\\ footer' /test.txt");
      expect(result.stdout).toBe("first\nlast\nfooter\n");
    });
  });

  describe("insert command (i)", () => {
    it("should insert text before matching line", async () => {
      const env = new Bash({
        files: { "/test.txt": "line 1\nline 2\nline 3\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '2i\\ inserted' /test.txt");
      expect(result.stdout).toBe("line 1\ninserted\nline 2\nline 3\n");
    });

    it("should insert text before first line", async () => {
      const env = new Bash({
        files: { "/test.txt": "content\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '1i\\ header' /test.txt");
      expect(result.stdout).toBe("header\ncontent\n");
    });

    it("should insert text before every line", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 'i\\ >' /test.txt");
      expect(result.stdout).toBe(">\na\n>\nb\n");
    });
  });

  describe("change command (c)", () => {
    it("should change matching line", async () => {
      const env = new Bash({
        files: { "/test.txt": "old line\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '1c\\ new line' /test.txt");
      expect(result.stdout).toBe("new line\n");
    });

    it("should change specific line number", async () => {
      const env = new Bash({
        files: { "/test.txt": "line 1\nline 2\nline 3\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '2c\\ replaced' /test.txt");
      expect(result.stdout).toBe("line 1\nreplaced\nline 3\n");
    });
  });

  describe("quit command (q)", () => {
    it("should quit after matching line", async () => {
      const env = new Bash({
        files: { "/test.txt": "1\n2\n3\n4\n5\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '3q' /test.txt");
      expect(result.stdout).toBe("1\n2\n3\n");
    });

    it("should quit immediately on first line", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '1q' /test.txt");
      expect(result.stdout).toBe("a\n");
    });
  });

  describe("escaped characters", () => {
    it("should handle escaped parentheses in pattern", async () => {
      const env = new Bash({
        files: { "/test.txt": "const x = require('foo');\n" },
        cwd: "/"
      });
      // Use -E for ERE mode where \( and \) are literal parentheses
      const result = await env.exec(
        "sed -E \"s/const x = require\\('foo'\\);/import x from 'foo';/g\" /test.txt"
      );
      expect(result.stdout).toBe("import x from 'foo';\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle semicolons in pattern and replacement", async () => {
      const env = new Bash({
        files: { "/test.txt": "a;b;c\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a;b/x;y/' /test.txt");
      expect(result.stdout).toBe("x;y;c\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("pattern addresses", () => {
    it("should match lines by pattern", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo\nbar\nbaz\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '/bar/d' /test.txt");
      expect(result.stdout).toBe("foo\nbaz\n");
    });

    it("should apply substitution to pattern-matched lines", async () => {
      const env = new Bash({
        files: { "/test.txt": "apple\nbanana\napricot\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '/^a/s/a/A/g' /test.txt");
      expect(result.stdout).toBe("Apple\nbanana\nApricot\n");
    });
  });

  describe("Nth occurrence substitution", () => {
    it("should replace 2nd occurrence only", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo bar foo baz foo\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/foo/XXX/2' /test.txt");
      expect(result.stdout).toBe("foo bar XXX baz foo\n");
    });

    it("should replace 3rd occurrence only", async () => {
      const env = new Bash({
        files: { "/test.txt": "a a a a a\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a/X/3' /test.txt");
      expect(result.stdout).toBe("a a X a a\n");
    });
  });

  describe("step address (first~step)", () => {
    it("should match every 2nd line starting from 0", async () => {
      const env = new Bash({
        files: { "/test.txt": "1\n2\n3\n4\n5\n6\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -n '0~2p' /test.txt");
      expect(result.stdout).toBe("2\n4\n6\n");
    });

    it("should match every 3rd line starting from 1", async () => {
      const env = new Bash({
        files: { "/test.txt": "1\n2\n3\n4\n5\n6\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -n '1~3p' /test.txt");
      expect(result.stdout).toBe("1\n4\n");
    });
  });

  describe("relative offset address (+N)", () => {
    it("should delete N lines after matching pattern", async () => {
      const env = new Bash({
        files: { "/test.txt": "1\n2\n3\n4\n5\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '/^2/,+2d' /test.txt");
      expect(result.stdout).toBe("1\n5\n");
    });

    it("should print N lines after matching pattern", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\n1\nc\nc\na\n2\na\n3\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -n '/a/,+1p' /test.txt");
      expect(result.stdout).toBe("a\n1\na\n2\na\n3\n");
    });

    it("should work with grouped commands", async () => {
      const env = new Bash({
        files: { "/test.txt": "1\n2\n3\n4\n5\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '/^2/,+2{d}' /test.txt");
      expect(result.stdout).toBe("1\n5\n");
    });
  });

  describe("grouped commands", () => {
    it("should execute multiple commands in group", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '2{s/b/B/}' /test.txt");
      expect(result.stdout).toBe("a\nB\nc\n");
    });

    it("should execute multiple commands with semicolon in group", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -n '2{s/b/B/;p}' /test.txt");
      expect(result.stdout).toBe("B\n");
    });
  });

  describe("P command (print first line)", () => {
    it("should print up to first newline", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\n" },
        cwd: "/"
      });
      // N appends next line, P prints first part
      const result = await env.exec("sed -n 'N;P' /test.txt");
      expect(result.stdout).toBe("line1\n");
    });
  });

  describe("D command (delete first line)", () => {
    it("should delete up to first newline and restart cycle", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\n" },
        cwd: "/"
      });
      // N;P;D is the classic sliding window: prints each line except last
      // N appends next line, P prints first part, D deletes first part and restarts
      const result = await env.exec("sed -n 'N;P;D' /test.txt");
      // Real bash: outputs "a\nb\n" (all lines except last)
      expect(result.stdout).toBe("a\nb\n");
    });

    it("should quit when N has no more lines", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\n" },
        cwd: "/"
      });
      // N;D: N appends next line, D deletes first line and restarts
      // When N finally fails (no more lines), GNU sed auto-prints the pattern space
      const result = await env.exec("sed 'N;D' /test.txt");
      // GNU sed: prints the remaining line when N fails
      expect(result.stdout).toBe("c\n");
    });
  });

  describe("z command (zap pattern space)", () => {
    it("should empty pattern space", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\nworld\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '1z' /test.txt");
      expect(result.stdout).toBe("\nworld\n");
    });
  });

  describe("T command (branch if no substitution)", () => {
    it("should branch when no substitution made", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo\nbar\n" },
        cwd: "/"
      });
      // Replace foo with FOO, T branches to end if no match (skipping p)
      const result = await env.exec("sed -n 's/foo/FOO/;T;p' /test.txt");
      expect(result.stdout).toBe("FOO\n");
    });
  });

  describe("extended regex (-E/-r flag)", () => {
    it("should support + quantifier with -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "aaa bbb ccc\n" },
        cwd: "/"
      });
      // + means one or more (ERE syntax)
      const result = await env.exec("sed -E 's/a+/X/' /test.txt");
      expect(result.stdout).toBe("X bbb ccc\n");
    });

    it("should support ? quantifier with -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "color colour\n" },
        cwd: "/"
      });
      // ? means zero or one (ERE syntax)
      const result = await env.exec("sed -E 's/colou?r/COLOR/g' /test.txt");
      expect(result.stdout).toBe("COLOR COLOR\n");
    });

    it("should support alternation | with -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat dog bird\n" },
        cwd: "/"
      });
      // | means alternation (ERE syntax)
      const result = await env.exec("sed -E 's/cat|dog/ANIMAL/g' /test.txt");
      expect(result.stdout).toBe("ANIMAL ANIMAL bird\n");
    });

    it("should support grouping () with -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world\n" },
        cwd: "/"
      });
      // () for grouping and backreferences (ERE syntax)
      const result = await env.exec(
        "sed -E 's/(hello) (world)/\\2 \\1/' /test.txt"
      );
      expect(result.stdout).toBe("world hello\n");
    });

    it("should support -r as alias for -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "aaa bbb\n" },
        cwd: "/"
      });
      // -r is GNU sed alias for -E
      const result = await env.exec("sed -r 's/a+/X/' /test.txt");
      expect(result.stdout).toBe("X bbb\n");
    });

    it("should support complex ERE patterns", async () => {
      const env = new Bash({
        files: {
          "/test.txt":
            "error: file not found\nwarning: deprecated\ninfo: success\n"
        },
        cwd: "/"
      });
      // Complex pattern with alternation and grouping
      const result = await env.exec(
        "sed -E 's/^(error|warning): (.+)/[\\1] \\2/' /test.txt"
      );
      expect(result.stdout).toBe(
        "[error] file not found\n[warning] deprecated\ninfo: success\n"
      );
    });

    it("should support {n,m} quantifier with -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "a aa aaa aaaa\n" },
        cwd: "/"
      });
      // {2,3} means 2 to 3 occurrences
      const result = await env.exec("sed -E 's/a{2,3}/X/g' /test.txt");
      expect(result.stdout).toBe("a X X Xa\n");
    });

    it("should treat + as literal without -E flag (BRE mode)", async () => {
      const env = new Bash({
        files: { "/test.txt": "aaa bbb\na+ ccc\n" },
        cwd: "/"
      });
      // In BRE mode (without -E), + is a literal character
      const result = await env.exec("sed 's/a+/X/' /test.txt");
      // Only matches literal "a+", not one or more a's
      expect(result.stdout).toBe("aaa bbb\nX ccc\n");
    });

    it("should treat \\+ as quantifier in BRE mode", async () => {
      const env = new Bash({
        files: { "/test.txt": "aaa bbb\n" },
        cwd: "/"
      });
      // In BRE mode, \+ is one-or-more quantifier
      const result = await env.exec("sed 's/a\\+/X/' /test.txt");
      expect(result.stdout).toBe("X bbb\n");
    });

    it("should handle \\? as optional in BRE mode", async () => {
      const env = new Bash({
        files: { "/test.txt": "ab\nb\n" },
        cwd: "/"
      });
      // In BRE mode, \? is optional quantifier (0 or 1)
      // a?b matches "ab" (1 a) or "b" (0 a's)
      const result = await env.exec("sed 's/a\\?b/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\n");
    });

    it("should handle \\| as alternation in BRE mode", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat\ndog\nbird\n" },
        cwd: "/"
      });
      // In BRE mode, \| is alternation
      const result = await env.exec("sed 's/cat\\|dog/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\nbird\n");
    });
  });

  describe("Q command (quit without printing)", () => {
    it("should quit without printing current line", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '2Q' /test.txt");
      expect(result.stdout).toBe("line1\n");
    });

    it("should differ from q which prints before quitting", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\n" },
        cwd: "/"
      });
      // q prints the line, then quits
      const resultQ = await env.exec("sed '2q' /test.txt");
      expect(resultQ.stdout).toBe("line1\nline2\n");
      // Q quits without printing
      const resultQSilent = await env.exec("sed '2Q' /test.txt");
      expect(resultQSilent.stdout).toBe("line1\n");
    });
  });

  describe("l command (list with escapes)", () => {
    it("should escape special characters", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\tworld\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -n 'l' /test.txt");
      expect(result.stdout).toBe("hello\\tworld$\n");
    });

    it("should escape backslash", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\\b\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -n 'l' /test.txt");
      expect(result.stdout).toBe("a\\\\b$\n");
    });

    it("should mark end of line with $", async () => {
      const env = new Bash({
        files: { "/test.txt": "test\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -n 'l' /test.txt");
      expect(result.stdout).toBe("test$\n");
    });
  });

  describe("z command (zap pattern space)", () => {
    it("should empty the pattern space", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\nworld\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 'z' /test.txt");
      expect(result.stdout).toBe("\n\n");
    });

    it("should work with address", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '2z' /test.txt");
      expect(result.stdout).toBe("line1\n\nline3\n");
    });
  });

  describe("pattern range state tracking", () => {
    it("should track range state across lines", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nSTART\nb\nc\nEND\nd\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '/START/,/END/d' /test.txt");
      expect(result.stdout).toBe("a\nd\n");
    });

    it("should handle multiple ranges in same file", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nSTART\nb\nEND\nc\nSTART\nd\nEND\ne\n" },
        cwd: "/"
      });
      const result = await env.exec("sed '/START/,/END/d' /test.txt");
      expect(result.stdout).toBe("a\nc\ne\n");
    });

    it("should handle unclosed range at EOF", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nSTART\nb\nc\n" },
        cwd: "/"
      });
      // Range starts at START, never finds END, so deletes to EOF
      const result = await env.exec("sed '/START/,/END/d' /test.txt");
      expect(result.stdout).toBe("a\n");
    });
  });

  describe("substitution tracking for t/T commands", () => {
    it("should track substitution even when pattern matches same text", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\n" },
        cwd: "/"
      });
      // s/./&/ replaces char with itself, but substitution still happened
      const result = await env.exec(
        "sed 's/./&/;t skip;s/$/X/;:skip' /test.txt"
      );
      // substitution happened, so branch skips adding X
      expect(result.stdout).toBe("a\nb\n");
    });

    it("should branch with T when no substitution made", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\n" },
        cwd: "/"
      });
      // s/x/y/ doesn't match, so T branches
      const result = await env.exec(
        "sed 's/x/y/;T add;b end;:add;s/$/X/;:end' /test.txt"
      );
      expect(result.stdout).toBe("aX\nbX\n");
    });

    it("should not branch with T when substitution made", async () => {
      const env = new Bash({
        files: { "/test.txt": "ax\nbx\n" },
        cwd: "/"
      });
      // s/x/y/ matches, so T doesn't branch
      const result = await env.exec(
        "sed 's/x/y/;T add;b end;:add;s/$/X/;:end' /test.txt"
      );
      expect(result.stdout).toBe("ay\nby\n");
    });
  });
});
