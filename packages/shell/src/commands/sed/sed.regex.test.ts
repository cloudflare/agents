import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("sed regex patterns", () => {
  describe("POSIX character classes", () => {
    it("should match [:alpha:] alphabetic characters", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc123xyz\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:alpha:]]/_/g' /test.txt");
      expect(result.stdout).toBe("___123___\n");
    });

    it("should match [:digit:] numeric characters", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc123xyz\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:digit:]]/#/g' /test.txt");
      expect(result.stdout).toBe("abc###xyz\n");
    });

    it("should match [:alnum:] alphanumeric characters", async () => {
      const env = new Bash({
        files: { "/test.txt": "a1-b2_c3\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:alnum:]]/X/g' /test.txt");
      expect(result.stdout).toBe("XX-XX_XX\n");
    });

    it("should match [:space:] whitespace", async () => {
      const env = new Bash({
        files: { "/test.txt": "a b\tc\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:space:]]/_/g' /test.txt");
      // Matches space and tab, newline is line terminator
      expect(result.stdout).toBe("a_b_c\n");
    });

    it("should match [:upper:] uppercase letters", async () => {
      const env = new Bash({
        files: { "/test.txt": "Hello World\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:upper:]]/X/g' /test.txt");
      expect(result.stdout).toBe("Xello Xorld\n");
    });

    it("should match [:lower:] lowercase letters", async () => {
      const env = new Bash({
        files: { "/test.txt": "Hello World\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:lower:]]/x/g' /test.txt");
      expect(result.stdout).toBe("Hxxxx Wxxxx\n");
    });

    it("should match [:punct:] punctuation", async () => {
      const env = new Bash({
        files: { "/test.txt": "Hello, World!\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:punct:]]//g' /test.txt");
      expect(result.stdout).toBe("Hello World\n");
    });

    it("should match [:blank:] space and tab only", async () => {
      const env = new Bash({
        files: { "/test.txt": "a b\tc\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:blank:]]/_/g' /test.txt");
      // [:blank:] matches space and tab but not newline
      expect(result.stdout).toBe("a_b_c\n");
    });

    it("should match [:xdigit:] hexadecimal digits", async () => {
      const env = new Bash({
        files: { "/test.txt": "0x1F2a3b\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:xdigit:]]/X/g' /test.txt");
      // Implementation matches 0-9, a-f, A-F and lowercase hex prefix 'x'
      expect(result.stdout).toBe("XxXXXXXX\n");
    });

    it("should support negated character classes", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc123\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[^[:digit:]]/X/g' /test.txt");
      // Newline is line terminator, not matched by pattern
      expect(result.stdout).toBe("XXX123\n");
    });

    it("should combine POSIX classes with other characters", async () => {
      const env = new Bash({
        files: { "/test.txt": "a1-b2_c3\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/[[:digit:]_-]/./g' /test.txt");
      expect(result.stdout).toBe("a..b..c.\n");
    });
  });

  describe("BRE (Basic Regular Expression) patterns", () => {
    it("should treat + as literal without backslash", async () => {
      const env = new Bash({
        files: { "/test.txt": "a+b\naab\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a+b/X/' /test.txt");
      expect(result.stdout).toBe("X\naab\n");
    });

    it("should treat \\+ as quantifier", async () => {
      const env = new Bash({
        files: { "/test.txt": "aab\nab\nb\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a\\+b/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\nb\n");
    });

    it("should treat ? as literal without backslash", async () => {
      const env = new Bash({
        files: { "/test.txt": "a?b\nab\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a?b/X/' /test.txt");
      expect(result.stdout).toBe("X\nab\n");
    });

    it("should treat | as literal without backslash", async () => {
      const env = new Bash({
        files: { "/test.txt": "a|b\nab\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a|b/X/' /test.txt");
      expect(result.stdout).toBe("X\nab\n");
    });

    it("should treat () as literal without backslash", async () => {
      const env = new Bash({
        files: { "/test.txt": "(foo)\nfoo\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/(foo)/X/' /test.txt");
      expect(result.stdout).toBe("X\nfoo\n");
    });

    // Skipped: RE2 doesn't support backreferences for ReDoS protection
    it.skip("should use \\( \\) for grouping in BRE", async () => {
      const env = new Bash({
        files: { "/test.txt": "abcabc\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/\\(abc\\)\\1/X/' /test.txt");
      expect(result.stdout).toBe("X\n");
    });
  });

  describe("ERE (Extended Regular Expression) with -E/-r", () => {
    it("should treat + as quantifier with -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "aab\nab\nb\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -E 's/a+b/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\nb\n");
    });

    it("should treat ? as quantifier with -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "ab\nb\naab\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -E 's/a?b/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\naX\n");
    });

    it("should treat | as alternation with -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat\ndog\nrat\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -E 's/cat|dog/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\nrat\n");
    });

    // Skipped: RE2 doesn't support backreferences for ReDoS protection
    it.skip("should use () for grouping with -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "abcabc\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -E 's/(abc)\\1/X/' /test.txt");
      expect(result.stdout).toBe("X\n");
    });

    it("-r should work same as -E", async () => {
      const env = new Bash({
        files: { "/test.txt": "aab\nab\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -r 's/a+b/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\n");
    });
  });

  describe("backreferences", () => {
    it("should support backreferences in replacement", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world\n" },
        cwd: "/"
      });
      const result = await env.exec(
        "sed 's/\\(hello\\) \\(world\\)/\\2 \\1/' /test.txt"
      );
      expect(result.stdout).toBe("world hello\n");
    });

    it("should support & as entire match", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/hello/[&]/' /test.txt");
      expect(result.stdout).toBe("[hello]\n");
    });

    it("should escape & with backslash", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/hello/\\&/' /test.txt");
      expect(result.stdout).toBe("&\n");
    });

    it("should support multiple backreferences", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc\n" },
        cwd: "/"
      });
      const result = await env.exec(
        "sed -E 's/(a)(b)(c)/\\3\\2\\1/' /test.txt"
      );
      expect(result.stdout).toBe("cba\n");
    });
  });

  describe("anchors", () => {
    it("should match ^ at start of line", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc\nxabc\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/^a/X/' /test.txt");
      expect(result.stdout).toBe("Xbc\nxabc\n");
    });

    it("should match $ at end of line", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc\nabcx\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/c$/X/' /test.txt");
      expect(result.stdout).toBe("abX\nabcx\n");
    });

    it("should match ^$ for empty line", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\n\nb\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/^$/EMPTY/' /test.txt");
      expect(result.stdout).toBe("a\nEMPTY\nb\n");
    });
  });

  describe("special characters and escapes", () => {
    it("should match literal dot with backslash", async () => {
      const env = new Bash({
        files: { "/test.txt": "a.b\nacb\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a\\.b/X/' /test.txt");
      expect(result.stdout).toBe("X\nacb\n");
    });

    it("should match . as any character", async () => {
      const env = new Bash({
        files: { "/test.txt": "a1b\na2b\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a.b/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\n");
    });

    it("should handle newline in replacement with \\n", async () => {
      const env = new Bash({
        files: { "/test.txt": "a:b\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/:/\\n/' /test.txt");
      expect(result.stdout).toBe("a\nb\n");
    });

    it("should handle tab in replacement with \\t", async () => {
      const env = new Bash({
        files: { "/test.txt": "a:b\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/:/\\t/' /test.txt");
      expect(result.stdout).toBe("a\tb\n");
    });
  });

  describe("quantifiers", () => {
    it("should match * (zero or more)", async () => {
      const env = new Bash({
        files: { "/test.txt": "b\nab\naab\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a*/X/' /test.txt");
      expect(result.stdout).toBe("Xb\nXb\nXb\n");
    });

    it("should match \\{n\\} exactly n times in BRE", async () => {
      const env = new Bash({
        files: { "/test.txt": "aa\naaa\naaaa\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a\\{3\\}/X/' /test.txt");
      expect(result.stdout).toBe("aa\nX\nXa\n");
    });

    it("should match {n} exactly n times in ERE", async () => {
      const env = new Bash({
        files: { "/test.txt": "aa\naaa\naaaa\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -E 's/a{3}/X/' /test.txt");
      expect(result.stdout).toBe("aa\nX\nXa\n");
    });

    it("should match \\{n,m\\} range in BRE", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\naa\naaa\naaaa\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a\\{2,3\\}/X/' /test.txt");
      expect(result.stdout).toBe("a\nX\nX\nXa\n");
    });

    it("should match {n,} at least n times in ERE", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\naa\naaa\n" },
        cwd: "/"
      });
      const result = await env.exec("sed -E 's/a{2,}/X/' /test.txt");
      expect(result.stdout).toBe("a\nX\nX\n");
    });
  });

  describe("character classes", () => {
    it("should match bracket expression", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat\ncut\ncot\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/c[aou]t/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\nX\n");
    });

    it("should match negated bracket expression", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat\ncbt\ncct\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/c[^a]t/X/' /test.txt");
      expect(result.stdout).toBe("cat\nX\nX\n");
    });

    it("should match range in bracket expression", async () => {
      const env = new Bash({
        files: { "/test.txt": "a1b\na5b\na9b\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a[0-4]b/X/' /test.txt");
      expect(result.stdout).toBe("X\na5b\na9b\n");
    });

    it("should match literal ] at start of bracket", async () => {
      const env = new Bash({
        files: { "/test.txt": "a]b\na[b\n" },
        cwd: "/"
      });
      const result = await env.exec("sed 's/a[][]b/X/' /test.txt");
      expect(result.stdout).toBe("X\nX\n");
    });
  });
});
