import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("grep", () => {
  it("should find matching lines", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello world\nfoo bar\nhello again\n" }
    });
    const result = await env.exec("grep hello /test.txt");
    expect(result.stdout).toBe("hello world\nhello again\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should return exit code 1 when no match", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello world\n" }
    });
    const result = await env.exec("grep missing /test.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("should be case sensitive by default", async () => {
    const env = new Bash({
      files: { "/test.txt": "Hello\nhello\nHELLO\n" }
    });
    const result = await env.exec("grep hello /test.txt");
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
  });

  it("should be case insensitive with -i", async () => {
    const env = new Bash({
      files: { "/test.txt": "Hello\nhello\nHELLO\n" }
    });
    const result = await env.exec("grep -i hello /test.txt");
    expect(result.stdout).toBe("Hello\nhello\nHELLO\n");
    expect(result.stderr).toBe("");
  });

  it("should be case insensitive with --ignore-case", async () => {
    const env = new Bash({
      files: { "/test.txt": "Hello\nhello\n" }
    });
    const result = await env.exec("grep --ignore-case hello /test.txt");
    expect(result.stdout).toBe("Hello\nhello\n");
    expect(result.stderr).toBe("");
  });

  it("should show line numbers with -n", async () => {
    const env = new Bash({
      files: { "/test.txt": "aaa\nbbb\naaa\n" }
    });
    const result = await env.exec("grep -n aaa /test.txt");
    expect(result.stdout).toBe("1:aaa\n3:aaa\n");
    expect(result.stderr).toBe("");
  });

  it("should show line numbers with --line-number", async () => {
    const env = new Bash({
      files: { "/test.txt": "match\nno\nmatch\n" }
    });
    const result = await env.exec("grep --line-number match /test.txt");
    expect(result.stdout).toBe("1:match\n3:match\n");
    expect(result.stderr).toBe("");
  });

  it("should invert match with -v", async () => {
    const env = new Bash({
      files: { "/test.txt": "keep\nremove\nkeep\n" }
    });
    const result = await env.exec("grep -v remove /test.txt");
    expect(result.stdout).toBe("keep\nkeep\n");
    expect(result.stderr).toBe("");
  });

  it("should invert match with --invert-match", async () => {
    const env = new Bash({
      files: { "/test.txt": "yes\nno\nyes\n" }
    });
    const result = await env.exec("grep --invert-match no /test.txt");
    expect(result.stdout).toBe("yes\nyes\n");
    expect(result.stderr).toBe("");
  });

  it("should count matches with -c", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\na\na\n" }
    });
    const result = await env.exec("grep -c a /test.txt");
    expect(result.stdout).toBe("3\n");
    expect(result.stderr).toBe("");
  });

  it("should count matches with --count", async () => {
    const env = new Bash({
      files: { "/test.txt": "x\nx\ny\n" }
    });
    const result = await env.exec("grep --count x /test.txt");
    expect(result.stdout).toBe("2\n");
    expect(result.stderr).toBe("");
  });

  it("should list files with matches using -l", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "found here\n",
        "/b.txt": "nothing\n",
        "/c.txt": "also found\n"
      }
    });
    const result = await env.exec("grep -l found /a.txt /b.txt /c.txt");
    expect(result.stdout).toBe("/a.txt\n/c.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should list files with --files-with-matches", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "yes\n",
        "/b.txt": "no\n"
      }
    });
    const result = await env.exec(
      "grep --files-with-matches yes /a.txt /b.txt"
    );
    expect(result.stdout).toBe("/a.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should search recursively with -r", async () => {
    const env = new Bash({
      files: {
        "/dir/root.txt": "needle here\n",
        "/dir/sub/file.txt": "another needle\n"
      }
    });
    const result = await env.exec("grep -r needle /dir");
    expect(result.stdout).toBe(
      "/dir/root.txt:needle here\n/dir/sub/file.txt:another needle\n"
    );
    expect(result.stderr).toBe("");
  });

  it("should search recursively with -R", async () => {
    const env = new Bash({
      files: { "/dir/file.txt": "findme\n" }
    });
    const result = await env.exec("grep -R findme /dir");
    expect(result.stdout).toBe("/dir/file.txt:findme\n");
    expect(result.stderr).toBe("");
  });

  it("should match whole words with -w", async () => {
    const env = new Bash({
      files: { "/test.txt": "cat\ncats\ncat dog\ncaterpillar\n" }
    });
    const result = await env.exec("grep -w cat /test.txt");
    expect(result.stdout).toBe("cat\ncat dog\n");
    expect(result.stderr).toBe("");
  });

  it("should match whole words with --word-regexp", async () => {
    const env = new Bash({
      files: { "/test.txt": "the\ntheme\nthe end\n" }
    });
    const result = await env.exec("grep --word-regexp the /test.txt");
    expect(result.stdout).toBe("the\nthe end\n");
    expect(result.stderr).toBe("");
  });

  it("should support extended regex with -E", async () => {
    const env = new Bash({
      files: { "/test.txt": "cat\ndog\nbird\n" }
    });
    const result = await env.exec('grep -E "cat|dog" /test.txt');
    expect(result.stdout).toBe("cat\ndog\n");
    expect(result.stderr).toBe("");
  });

  it("should support extended regex with --extended-regexp", async () => {
    const env = new Bash({
      files: { "/test.txt": "abc\nabc123\nxyz\n" }
    });
    const result = await env.exec(
      'grep --extended-regexp "abc[0-9]+" /test.txt'
    );
    expect(result.stdout).toBe("abc123\n");
    expect(result.stderr).toBe("");
  });

  it("should use -e to specify pattern", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello\nworld\n" }
    });
    const result = await env.exec("grep -e hello /test.txt");
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
  });

  it("should read from stdin", async () => {
    const env = new Bash();
    const result = await env.exec('echo -e "foo\\nbar\\nfoo" | grep foo');
    expect(result.stdout).toBe("foo\nfoo\n");
    expect(result.stderr).toBe("");
  });

  it("should error on missing pattern", async () => {
    const env = new Bash();
    const result = await env.exec("grep");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("grep: missing pattern\n");
    expect(result.exitCode).toBe(2);
  });

  it("should error on missing file", async () => {
    const env = new Bash();
    const result = await env.exec("grep pattern /missing.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "grep: /missing.txt: No such file or directory\n"
    );
    expect(result.exitCode).toBe(2); // Exit code 2 for errors (like real grep)
  });

  it("should combine -in flags", async () => {
    const env = new Bash({
      files: { "/test.txt": "Hello\nhello\n" }
    });
    const result = await env.exec("grep -in hello /test.txt");
    expect(result.stdout).toBe("1:Hello\n2:hello\n");
    expect(result.stderr).toBe("");
  });

  it("should show filename for multiple files", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "match\n",
        "/b.txt": "match\n"
      }
    });
    const result = await env.exec("grep match /a.txt /b.txt");
    expect(result.stdout).toBe("/a.txt:match\n/b.txt:match\n");
    expect(result.stderr).toBe("");
  });

  it("should match literal text without regex interpretation", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello\nworld\nhello world\n" }
    });
    const result = await env.exec('grep "hello world" /test.txt');
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("");
  });

  it("should skip directories in non-recursive mode", async () => {
    const env = new Bash({
      files: { "/dir/file.txt": "content\n" }
    });
    const result = await env.exec("grep pattern /dir");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("grep: /dir: Is a directory\n");
  });

  it("should count zero matches correctly with -c", async () => {
    const env = new Bash({
      files: { "/test.txt": "no match here\n" }
    });
    const result = await env.exec("grep -c missing /test.txt");
    expect(result.stdout).toBe("0\n");
    expect(result.stderr).toBe("");
  });

  // Regex pattern tests
  describe("regex patterns", () => {
    it("should match beginning of line with ^", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world\nworld hello\n" }
      });
      const result = await env.exec('grep "^hello" /test.txt');
      expect(result.stdout).toBe("hello world\n");
    });

    it("should match end of line with $", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world\nworld hello\n" }
      });
      const result = await env.exec('grep "hello$" /test.txt');
      expect(result.stdout).toBe("world hello\n");
    });

    it("should match any character with .", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat\ncut\ncot\ncar\n" }
      });
      const result = await env.exec('grep "c.t" /test.txt');
      expect(result.stdout).toBe("cat\ncut\ncot\n");
    });

    it("should match zero or more with *", async () => {
      const env = new Bash({
        files: { "/test.txt": "ac\nabc\nabbc\nabbbc\n" }
      });
      const result = await env.exec('grep "ab*c" /test.txt');
      expect(result.stdout).toBe("ac\nabc\nabbc\nabbbc\n");
    });

    it("should match character class with []", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat\nbat\nrat\nhat\n" }
      });
      const result = await env.exec('grep "[cbr]at" /test.txt');
      expect(result.stdout).toBe("cat\nbat\nrat\n");
    });

    it("should match negated character class with [^]", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat\nbat\nrat\nhat\n" }
      });
      const result = await env.exec('grep "[^cbr]at" /test.txt');
      expect(result.stdout).toBe("hat\n");
    });

    it("should escape special regex characters in literal search", async () => {
      const env = new Bash({
        files: { "/test.txt": "price: $100\nprice: 100\n" }
      });
      // To match literal $, escape it with \\$ (shell escaping gives grep \$)
      const result = await env.exec('grep "\\\\\\$100" /test.txt');
      expect(result.stdout).toBe("price: $100\n");
    });

    it("should match digits with extended regex", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc\nabc123\n123abc\n" }
      });
      const result = await env.exec('grep -E "[0-9]+" /test.txt');
      expect(result.stdout).toBe("abc123\n123abc\n");
    });

    it("should match one or more with + in extended regex", async () => {
      const env = new Bash({
        files: { "/test.txt": "ac\nabc\nabbc\n" }
      });
      const result = await env.exec('grep -E "ab+c" /test.txt');
      expect(result.stdout).toBe("abc\nabbc\n");
    });

    it("should match optional with ? in extended regex", async () => {
      const env = new Bash({
        files: { "/test.txt": "color\ncolour\ncolr\n" }
      });
      const result = await env.exec('grep -E "colou?r" /test.txt');
      expect(result.stdout).toBe("color\ncolour\n");
    });

    it("should match groups with () in extended regex", async () => {
      const env = new Bash({
        files: { "/test.txt": "ab\nabab\nababab\nac\n" }
      });
      const result = await env.exec('grep -E "(ab)+" /test.txt');
      expect(result.stdout).toBe("ab\nabab\nababab\n");
    });
  });

  // Edge cases
  describe("edge cases", () => {
    it("should handle empty file", async () => {
      const env = new Bash({
        files: { "/empty.txt": "" }
      });
      const result = await env.exec("grep pattern /empty.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    });

    it("should handle file with only newlines", async () => {
      const env = new Bash({
        files: { "/newlines.txt": "\n\n\n" }
      });
      const result = await env.exec('grep "." /newlines.txt');
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    });

    it("should handle very long lines", async () => {
      const env = new Bash({
        files: {
          "/long.txt": `${"a".repeat(10000)}needle${"b".repeat(10000)}\n`
        }
      });
      const result = await env.exec("grep needle /long.txt");
      expect(result.stdout).toContain("needle");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple matches on same line", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo bar foo baz foo\n" }
      });
      const result = await env.exec("grep foo /test.txt");
      expect(result.stdout).toBe("foo bar foo baz foo\n");
    });

    it("should handle pattern that matches entire line", async () => {
      const env = new Bash({
        files: { "/test.txt": "exactmatch\nno\n" }
      });
      const result = await env.exec('grep "^exactmatch$" /test.txt');
      expect(result.stdout).toBe("exactmatch\n");
    });

    it("should handle special characters in filenames", async () => {
      const env = new Bash({
        files: { "/file-with-dash.txt": "content\n" }
      });
      const result = await env.exec("grep content /file-with-dash.txt");
      expect(result.stdout).toBe("content\n");
    });

    it("should handle unicode content", async () => {
      const env = new Bash({
        files: { "/unicode.txt": "hello\n\u4e2d\u6587\nworld\n" }
      });
      const result = await env.exec('grep "\u4e2d\u6587" /unicode.txt');
      expect(result.stdout).toBe("\u4e2d\u6587\n");
    });

    it("should handle tabs in content", async () => {
      const env = new Bash({
        files: { "/tabs.txt": "col1\tcol2\tcol3\n" }
      });
      const result = await env.exec("grep col2 /tabs.txt");
      expect(result.stdout).toBe("col1\tcol2\tcol3\n");
    });
  });

  // Combined flags
  describe("combined flags", () => {
    it("should combine -i and -v (case insensitive invert)", async () => {
      const env = new Bash({
        files: { "/test.txt": "Hello\nWorld\nhello\n" }
      });
      const result = await env.exec("grep -iv hello /test.txt");
      expect(result.stdout).toBe("World\n");
    });

    it("should combine -c and -i (count case insensitive)", async () => {
      const env = new Bash({
        files: { "/test.txt": "Hello\nhello\nHELLO\nworld\n" }
      });
      const result = await env.exec("grep -ci hello /test.txt");
      expect(result.stdout).toBe("3\n");
    });

    it("should combine -n and -v (line numbers with invert)", async () => {
      const env = new Bash({
        files: { "/test.txt": "keep\nremove\nkeep\n" }
      });
      const result = await env.exec("grep -nv remove /test.txt");
      expect(result.stdout).toBe("1:keep\n3:keep\n");
    });

    it("should combine -l and -r (files with matches recursive)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "needle\n",
          "/dir/b.txt": "no match\n",
          "/dir/sub/c.txt": "needle here\n"
        }
      });
      const result = await env.exec("grep -rl needle /dir");
      expect(result.stdout).toContain("/dir/a.txt");
      expect(result.stdout).toContain("/dir/sub/c.txt");
      expect(result.stdout).not.toContain("b.txt");
    });

    it("should combine -w and -i (whole word case insensitive)", async () => {
      const env = new Bash({
        files: { "/test.txt": "Cat\ncat\ncaterpillar\nCAT\n" }
      });
      const result = await env.exec("grep -wi cat /test.txt");
      expect(result.stdout).toBe("Cat\ncat\nCAT\n");
    });

    it("should combine -E and -i (extended regex case insensitive)", async () => {
      const env = new Bash({
        files: { "/test.txt": "CAT\nDOG\nbird\n" }
      });
      const result = await env.exec('grep -Ei "cat|dog" /test.txt');
      expect(result.stdout).toBe("CAT\nDOG\n");
    });
  });

  describe("POSIX character classes", () => {
    it("should match [[:alpha:]] for letters", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc\n123\na1b\n" }
      });
      const result = await env.exec('grep -E "^[[:alpha:]]+$" /test.txt');
      expect(result.stdout).toBe("abc\n");
    });

    it("should match [[:digit:]] for digits", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc\n123\na1b\n" }
      });
      const result = await env.exec('grep -E "^[[:digit:]]+$" /test.txt');
      expect(result.stdout).toBe("123\n");
    });

    it("should match [[:alnum:]] for alphanumeric", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc123\n!@#\na1b\n" }
      });
      const result = await env.exec('grep -E "^[[:alnum:]]+$" /test.txt');
      expect(result.stdout).toBe("abc123\na1b\n");
    });

    it("should match [[:upper:]] for uppercase letters", async () => {
      const env = new Bash({
        files: { "/test.txt": "ABC\nabc\nAbC\n" }
      });
      const result = await env.exec('grep -E "^[[:upper:]]+$" /test.txt');
      expect(result.stdout).toBe("ABC\n");
    });

    it("should match [[:lower:]] for lowercase letters", async () => {
      const env = new Bash({
        files: { "/test.txt": "ABC\nabc\nAbC\n" }
      });
      const result = await env.exec('grep -E "^[[:lower:]]+$" /test.txt');
      expect(result.stdout).toBe("abc\n");
    });

    it("should match [[:xdigit:]] for hex digits", async () => {
      const env = new Bash({
        files: { "/test.txt": "deadbeef\n12ab\nGHI\n" }
      });
      const result = await env.exec('grep -E "^[[:xdigit:]]+$" /test.txt');
      expect(result.stdout).toBe("deadbeef\n12ab\n");
    });

    it("should match [[:space:]] for whitespace", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world\nhelloworld\n" }
      });
      const result = await env.exec('grep -E "[[:space:]]" /test.txt');
      expect(result.stdout).toBe("hello world\n");
    });

    it("should combine POSIX classes with other characters", async () => {
      const env = new Bash({
        files: { "/test.txt": "a1\nb2\nc!\n" }
      });
      const result = await env.exec(
        'grep -E "^[[:alpha:]][[:digit:]]$" /test.txt'
      );
      expect(result.stdout).toBe("a1\nb2\n");
    });

    it("should negate POSIX classes with [^]", async () => {
      const env = new Bash({
        files: { "/test.txt": "123\nabc\n!@#\n" }
      });
      const result = await env.exec('grep -E "^[^[:alpha:]]+$" /test.txt');
      expect(result.stdout).toBe("123\n!@#\n");
    });
  });

  describe("BRE interval expressions", () => {
    it("should match exact count with \\{n\\}", async () => {
      const env = new Bash({
        // Use anchors to test exact match
        files: { "/test.txt": "ab\naab\naaab\n" }
      });
      const result = await env.exec("grep '^a\\{2\\}b$' /test.txt");
      expect(result.stdout).toBe("aab\n");
    });

    it("should match minimum count with \\{n,\\}", async () => {
      const env = new Bash({
        files: { "/test.txt": "ab\naab\naaab\naaaab\n" }
      });
      const result = await env.exec("grep '^a\\{2,\\}b$' /test.txt");
      expect(result.stdout).toBe("aab\naaab\naaaab\n");
    });

    it("should match range with \\{n,m\\}", async () => {
      const env = new Bash({
        files: { "/test.txt": "ab\naab\naaab\naaaab\n" }
      });
      const result = await env.exec("grep '^a\\{2,3\\}b$' /test.txt");
      expect(result.stdout).toBe("aab\naaab\n");
    });

    it("should match zero count with \\{0,0\\}", async () => {
      const env = new Bash({
        files: { "/test.txt": "bc\nabc\nac\n" }
      });
      // a{0,0}bc means "zero a's followed by bc" = just "bc"
      const result = await env.exec("grep 'a\\{0,0\\}bc' /test.txt");
      expect(result.stdout).toBe("bc\nabc\n");
    });
  });

  describe("word boundaries", () => {
    it("should match word start with [[:<:]]", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo bar\nbarfoo\nfoobar\n" }
      });
      const result = await env.exec('grep -E "[[:<:]]foo" /test.txt');
      expect(result.stdout).toBe("foo bar\nfoobar\n");
    });

    it("should match word end with [[:>:]]", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo bar\nbarfoo\nfoobar\n" }
      });
      const result = await env.exec('grep -E "foo[[:>:]]" /test.txt');
      expect(result.stdout).toBe("foo bar\nbarfoo\n");
    });

    it("should match whole word with [[:<:]] and [[:>:]]", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo bar\nbarfoo\nfoobar\nfoo\n" }
      });
      const result = await env.exec('grep -E "[[:<:]]foo[[:>:]]" /test.txt');
      expect(result.stdout).toBe("foo bar\nfoo\n");
    });
  });

  describe("bracket expression edge cases", () => {
    it("should match ] as first char in bracket expression", async () => {
      const env = new Bash({
        files: { "/test.txt": "a]b\na[b\nacb\n" }
      });
      const result = await env.exec('grep -E "a[][]b" /test.txt');
      expect(result.stdout).toBe("a]b\na[b\n");
    });

    it("should match ] as first char in negated bracket", async () => {
      const env = new Bash({
        files: { "/test.txt": "a]c\nabc\nadc\n" }
      });
      const result = await env.exec('grep -E "a[^]b]c" /test.txt');
      expect(result.stdout).toBe("adc\n");
    });
  });

  describe("BRE anchor edge cases", () => {
    it("should treat ^ as literal in middle of pattern", async () => {
      const env = new Bash({
        files: { "/test.txt": "a^b\nacb\nabc\n" }
      });
      const result = await env.exec("grep 'a^b' /test.txt");
      expect(result.stdout).toBe("a^b\n");
    });

    it("should treat $ as literal in middle of pattern", async () => {
      const env = new Bash({
        files: { "/test.txt": "a$b\nacb\nabc\n" }
      });
      const result = await env.exec("grep 'a\\$b' /test.txt");
      expect(result.stdout).toBe("a$b\n");
    });

    it("should treat ^ as anchor at start of BRE group", async () => {
      const env = new Bash({
        files: { "/test.txt": "b\nab\nba\n" }
      });
      const result = await env.exec("grep 'a*\\(^b$\\)c*' /test.txt");
      expect(result.stdout).toBe("b\n");
    });

    it("should treat $ as anchor at end of BRE group", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nab\nba\n" }
      });
      const result = await env.exec("grep '\\(^a$\\)' /test.txt");
      expect(result.stdout).toBe("a\n");
    });
  });

  describe("BRE literal * edge cases", () => {
    it("should treat * as literal at pattern start", async () => {
      const env = new Bash({
        files: { "/test.txt": "*\nabc\n*abc\n" }
      });
      const result = await env.exec("grep '^\\*' /test.txt");
      expect(result.stdout).toBe("*\n*abc\n");
    });

    it("should treat * as literal after ^ anchor", async () => {
      const env = new Bash({
        files: { "/test.txt": "*\nabc\n*abc\n" }
      });
      const result = await env.exec("grep '^*' /test.txt");
      expect(result.stdout).toBe("*\n*abc\n");
    });

    it("should treat * in group as quantifier", async () => {
      const env = new Bash({
        files: { "/test.txt": "ab\nabb\nabbb\n" }
      });
      const result = await env.exec("grep 'ab*' /test.txt");
      expect(result.stdout).toBe("ab\nabb\nabbb\n");
    });
  });

  describe("combined POSIX classes and quantifiers", () => {
    it("should match POSIX class with BRE interval", async () => {
      const env = new Bash({
        files: { "/test.txt": "ab\naab\naaab\n" }
      });
      const result = await env.exec("grep '[[:alpha:]]\\{2\\}b' /test.txt");
      expect(result.stdout).toBe("aab\naaab\n");
    });

    it("should match multiple POSIX classes in one bracket", async () => {
      const env = new Bash({
        files: { "/test.txt": "a1\n1a\n!!\nA9\n" }
      });
      const result = await env.exec(
        'grep -E "^[[:alpha:][:digit:]]+$" /test.txt'
      );
      expect(result.stdout).toBe("a1\n1a\nA9\n");
    });

    it("should negate multiple POSIX classes", async () => {
      const env = new Bash({
        files: { "/test.txt": "!@#\nabc\n123\na1!\n" }
      });
      const result = await env.exec(
        'grep -E "^[^[:alpha:][:digit:]]+$" /test.txt'
      );
      expect(result.stdout).toBe("!@#\n");
    });
  });
});
