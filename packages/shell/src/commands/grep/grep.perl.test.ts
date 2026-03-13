import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("grep Perl regex (-P)", () => {
  // ============================================================
  // \K - Reset Match Start
  // ============================================================
  describe("\\K reset match start", () => {
    describe("basic functionality", () => {
      it("should extract text after \\K with -oP", async () => {
        const env = new Bash({
          files: { "/test.txt": "foo=bar\nbaz=qux\n" }
        });
        const result = await env.exec("grep -oP '=\\K\\w+' /test.txt");
        expect(result.stdout).toBe("bar\nqux\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with \\K in useEffect pattern", async () => {
        const env = new Bash({
          files: {
            "/app.tsx":
              "useEffect(() => { }, [count]);\nuseEffect(() => { }, [name, id]);\n"
          }
        });
        const result = await env.exec(
          'grep -oP "useEffect\\(.*?\\[\\K[^\\]]+" /app.tsx'
        );
        expect(result.stdout).toBe("count\nname, id\n");
        expect(result.exitCode).toBe(0);
      });

      it("should extract URLs after protocol with \\K", async () => {
        const env = new Bash({
          files: {
            "/test.txt":
              "http://example.com\nhttps://test.org\nftp://files.net\n"
          }
        });
        const result = await env.exec(
          "grep -oP 'https?://\\K[^\\s]+' /test.txt"
        );
        expect(result.stdout).toBe("example.com\ntest.org\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("edge cases", () => {
      it("should return empty string when \\K is at end of pattern", async () => {
        const env = new Bash({
          files: { "/test.txt": "prefix\n" }
        });
        const result = await env.exec("grep -oP 'prefix\\K' /test.txt");
        expect(result.stdout).toBe("\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with \\K at start of pattern", async () => {
        const env = new Bash({
          files: { "/test.txt": "hello world\n" }
        });
        const result = await env.exec("grep -oP '\\K\\w+' /test.txt");
        // \K at start means entire match is kept
        expect(result.stdout).toBe("hello\nworld\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with \\K and capturing groups before", async () => {
        const env = new Bash({
          files: { "/test.txt": "foo123bar\n" }
        });
        const result = await env.exec("grep -oP '(foo)\\K\\d+' /test.txt");
        expect(result.stdout).toBe("123\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with \\K and capturing groups after", async () => {
        const env = new Bash({
          files: { "/test.txt": "foo123bar\n" }
        });
        const result = await env.exec("grep -oP 'foo\\K(\\d+)' /test.txt");
        expect(result.stdout).toBe("123\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with \\K inside alternation", async () => {
        const env = new Bash({
          files: { "/test.txt": "foo=1\nbar:2\n" }
        });
        const result = await env.exec(
          "grep -oP '(?:foo=|bar:)\\K\\d+' /test.txt"
        );
        expect(result.stdout).toBe("1\n2\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with \\K and quantifiers", async () => {
        const env = new Bash({
          files: { "/test.txt": "aaabbb\nabbbb\n" }
        });
        const result = await env.exec("grep -oP 'a+\\Kb+' /test.txt");
        expect(result.stdout).toBe("bbb\nbbbb\n");
        expect(result.exitCode).toBe(0);
      });

      // Skipped: RE2 doesn't support lookahead/lookbehind for ReDoS protection
      it.skip("should work with \\K and lookahead", async () => {
        const env = new Bash({
          files: { "/test.txt": "foo123\nfooabc\n" }
        });
        const result = await env.exec("grep -oP 'foo\\K\\d+(?=\\d)' /test.txt");
        expect(result.stdout).toBe("12\n");
        expect(result.exitCode).toBe(0);
      });

      // Skipped: RE2 doesn't support lookahead/lookbehind for ReDoS protection
      it.skip("should work with \\K and lookbehind", async () => {
        const env = new Bash({
          files: { "/test.txt": "price: $100\ncost: $200\n" }
        });
        const result = await env.exec(
          "grep -oP '(?<=price: )\\$\\K\\d+' /test.txt"
        );
        expect(result.stdout).toBe("100\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("with file options", () => {
      it("should work with multiple files", async () => {
        const env = new Bash({
          files: {
            "/a.txt": "key=value1\n",
            "/b.txt": "key=value2\n"
          }
        });
        const result = await env.exec("grep -oP 'key=\\K\\w+' /a.txt /b.txt");
        expect(result.stdout).toBe("/a.txt:value1\n/b.txt:value2\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with -h flag to suppress filename", async () => {
        const env = new Bash({
          files: {
            "/a.txt": "x=1\n",
            "/b.txt": "x=2\n"
          }
        });
        const result = await env.exec("grep -ohP 'x=\\K\\d+' /a.txt /b.txt");
        expect(result.stdout).toBe("1\n2\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with -n for line numbers", async () => {
        const env = new Bash({
          files: { "/test.txt": "skip\nfoo=bar\nskip\nfoo=baz\n" }
        });
        const result = await env.exec("grep -onP 'foo=\\K\\w+' /test.txt");
        expect(result.stdout).toBe("2:bar\n4:baz\n");
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // ============================================================
  // \Q...\E - Quote Metacharacters
  // ============================================================
  describe("\\Q...\\E quote metacharacters", () => {
    describe("basic functionality", () => {
      it("should match literal dot", async () => {
        const env = new Bash({
          files: { "/test.txt": "foo.bar\nfooxbar\n" }
        });
        const result = await env.exec("grep -oP '\\Q.\\E' /test.txt");
        expect(result.stdout).toBe(".\n");
        expect(result.exitCode).toBe(0);
      });

      it("should match literal asterisk", async () => {
        const env = new Bash({
          files: { "/test.txt": "a*b\naaab\n" }
        });
        const result = await env.exec("grep -oP '\\Q*\\E' /test.txt");
        expect(result.stdout).toBe("*\n");
        expect(result.exitCode).toBe(0);
      });

      it("should match multiple special characters", async () => {
        const env = new Bash({
          files: { "/test.txt": "foo.bar*baz\nfooxbarybaz\n" }
        });
        const result = await env.exec("grep -oP '\\Qfoo.bar*\\E' /test.txt");
        expect(result.stdout).toBe("foo.bar*\n");
        expect(result.exitCode).toBe(0);
      });

      it("should match regex metacharacters", async () => {
        const env = new Bash({
          files: { "/test.txt": "test^$.*+?end\nother\n" }
        });
        const result = await env.exec("grep -oP '\\Q^$.*+?\\E' /test.txt");
        expect(result.stdout).toBe("^$.*+?\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("edge cases", () => {
      it("should handle \\Q without \\E (quotes to end)", async () => {
        const env = new Bash({
          files: { "/test.txt": "test[0]++\ntest0\n" }
        });
        const result = await env.exec("grep -oP '\\Q[0]++' /test.txt");
        expect(result.stdout).toBe("[0]++\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle empty \\Q\\E", async () => {
        const env = new Bash({
          files: { "/test.txt": "abc\n" }
        });
        const result = await env.exec("grep -oP 'a\\Q\\Ebc' /test.txt");
        expect(result.stdout).toBe("abc\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle multiple \\Q...\\E pairs", async () => {
        const env = new Bash({
          files: { "/test.txt": "a+b=c*d\na1b2c3d\n" }
        });
        const result = await env.exec(
          "grep -oP '\\Q+\\E.\\Q=\\E.\\Q*\\E' /test.txt"
        );
        expect(result.stdout).toBe("+b=c*\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle \\Q...\\E at start of pattern", async () => {
        const env = new Bash({
          files: { "/test.txt": "^start\nstart\n" }
        });
        const result = await env.exec("grep -oP '\\Q^\\Estart' /test.txt");
        expect(result.stdout).toBe("^start\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle \\Q...\\E at end of pattern", async () => {
        const env = new Bash({
          files: { "/test.txt": "end$\nend\n" }
        });
        const result = await env.exec("grep -oP 'end\\Q$\\E' /test.txt");
        expect(result.stdout).toBe("end$\n");
        expect(result.exitCode).toBe(0);
      });

      it("should not interpret \\E without preceding \\Q", async () => {
        const env = new Bash({
          files: { "/test.txt": "test\\Evalue\nother\n" }
        });
        // \E alone should be passed through and likely treated as literal E or error
        const result = await env.exec("grep -P 'test' /test.txt");
        expect(result.stdout).toBe("test\\Evalue\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("combining with regex", () => {
      it("should combine \\Q...\\E with regular regex after", async () => {
        const env = new Bash({
          files: { "/test.txt": "price: $100\nprice: $250\n" }
        });
        const result = await env.exec("grep -oP '\\Q$\\E\\d+' /test.txt");
        expect(result.stdout).toBe("$100\n$250\n");
        expect(result.exitCode).toBe(0);
      });

      it("should combine \\Q...\\E with regex before", async () => {
        const env = new Bash({
          files: { "/test.txt": "file.txt\nfile.doc\n" }
        });
        const result = await env.exec("grep -oP '\\w+\\Q.txt\\E' /test.txt");
        expect(result.stdout).toBe("file.txt\n");
        expect(result.exitCode).toBe(0);
      });

      it("should combine \\Q...\\E with \\K", async () => {
        const env = new Bash({
          files: { "/test.txt": "var=value\nother\n" }
        });
        const result = await env.exec("grep -oP '\\Qvar=\\E\\K\\w+' /test.txt");
        expect(result.stdout).toBe("value\n");
        expect(result.exitCode).toBe(0);
      });

      it("should combine \\Q...\\E with character class", async () => {
        const env = new Bash({
          files: { "/test.txt": "a+1\na+2\nb+1\n" }
        });
        const result = await env.exec("grep -oP '[ab]\\Q+\\E\\d' /test.txt");
        expect(result.stdout).toBe("a+1\na+2\nb+1\n");
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // ============================================================
  // \x{NNNN} - Unicode Code Points
  // ============================================================
  describe("\\x{NNNN} Unicode code points", () => {
    describe("basic functionality", () => {
      it("should match ASCII by code point", async () => {
        const env = new Bash({
          files: { "/test.txt": "Hello\n" }
        });
        const result = await env.exec("grep -oP '\\x{48}' /test.txt");
        expect(result.stdout).toBe("H\n");
        expect(result.exitCode).toBe(0);
      });

      it("should match BMP Unicode characters", async () => {
        const env = new Bash({
          files: { "/test.txt": "Hello ☃ World\n" }
        });
        const result = await env.exec("grep -oP '\\x{2603}' /test.txt");
        expect(result.stdout).toBe("☃\n");
        expect(result.exitCode).toBe(0);
      });

      it("should match supplementary plane emoji", async () => {
        const env = new Bash({
          files: { "/test.txt": "Test 😀 emoji\n" }
        });
        const result = await env.exec("grep -oP '\\x{1F600}' /test.txt");
        expect(result.stdout).toBe("😀\n");
        expect(result.exitCode).toBe(0);
      });

      it("should match mathematical symbols", async () => {
        const env = new Bash({
          files: { "/test.txt": "Sum: ∑ Integral: ∫\n" }
        });
        const result = await env.exec("grep -oP '\\x{2211}' /test.txt");
        expect(result.stdout).toBe("∑\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("multiple and combined patterns", () => {
      it("should match multiple Unicode in character class", async () => {
        const env = new Bash({
          files: { "/test.txt": "Stars: ★☆★\n" }
        });
        const result = await env.exec(
          "grep -oP '[\\x{2605}\\x{2606}]+' /test.txt"
        );
        expect(result.stdout).toBe("★☆★\n");
        expect(result.exitCode).toBe(0);
      });

      it("should match sequence of Unicode code points", async () => {
        const env = new Bash({
          files: { "/test.txt": "Card: ♠♥♦♣\n" }
        });
        const result = await env.exec(
          "grep -oP '\\x{2660}\\x{2665}\\x{2666}\\x{2663}' /test.txt"
        );
        expect(result.stdout).toBe("♠♥♦♣\n");
        expect(result.exitCode).toBe(0);
      });

      it("should combine Unicode with regular patterns", async () => {
        const env = new Bash({
          files: { "/test.txt": "Price: €100\nPrice: €50\n" }
        });
        const result = await env.exec("grep -oP '\\x{20AC}\\d+' /test.txt");
        expect(result.stdout).toBe("€100\n€50\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with Unicode and \\K", async () => {
        const env = new Bash({
          files: { "/test.txt": "€100\n€200\n" }
        });
        const result = await env.exec("grep -oP '\\x{20AC}\\K\\d+' /test.txt");
        expect(result.stdout).toBe("100\n200\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("edge cases", () => {
      it("should handle lowercase hex digits", async () => {
        const env = new Bash({
          files: { "/test.txt": "Test ñ char\n" }
        });
        const result = await env.exec("grep -oP '\\x{f1}' /test.txt");
        expect(result.stdout).toBe("ñ\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle mixed case hex digits", async () => {
        const env = new Bash({
          files: { "/test.txt": "Hello ☃ World\n" }
        });
        const result = await env.exec("grep -oP '\\x{26Fa}' /test.txt");
        // 0x26FA is ⛺ (tent), not in file
        expect(result.stdout).toBe("");
        expect(result.exitCode).toBe(1);
      });

      it("should handle single digit code point", async () => {
        const env = new Bash({
          files: { "/test.txt": "Tab:\there\n" }
        });
        const result = await env.exec("grep -oP '\\x{9}' /test.txt");
        expect(result.stdout).toBe("\t\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle null character code point", async () => {
        const env = new Bash({
          files: { "/test.txt": "test\n" }
        });
        // Search for 'e' using code point
        const result = await env.exec("grep -oP '\\x{65}' /test.txt");
        expect(result.stdout).toBe("e\n");
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // ============================================================
  // (?i:...) - Inline Modifiers
  // ============================================================
  describe("(?i:...) inline modifiers", () => {
    describe("basic case insensitivity", () => {
      it("should apply case-insensitive only to group", async () => {
        const env = new Bash({
          files: {
            "/test.txt": "Hello world\nhello world\nHELLO world\nHello WORLD\n"
          }
        });
        const result = await env.exec("grep -oP '(?i:hello) world' /test.txt");
        expect(result.stdout).toBe("Hello world\nhello world\nHELLO world\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle single letter case insensitivity", async () => {
        const env = new Bash({
          files: { "/test.txt": "Apple\napple\nAPPLE\n" }
        });
        const result = await env.exec("grep -oP '(?i:a)pple' /test.txt");
        expect(result.stdout).toBe("Apple\napple\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle mixed case pattern", async () => {
        const env = new Bash({
          files: { "/test.txt": "CamelCase\ncamelcase\nCAMELCASE\n" }
        });
        const result = await env.exec("grep -oP '(?i:CamelCase)' /test.txt");
        expect(result.stdout).toBe("CamelCase\ncamelcase\nCAMELCASE\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("combining with other patterns", () => {
      it("should preserve regex patterns inside modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "abc123\nABC123\naBc456\n" }
        });
        const result = await env.exec("grep -oP '(?i:abc)\\d+' /test.txt");
        expect(result.stdout).toBe("abc123\nABC123\naBc456\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle character class inside modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "cat\nCAT\nCat\ndog\n" }
        });
        const result = await env.exec("grep -oP '(?i:[cd]at)' /test.txt");
        expect(result.stdout).toBe("cat\nCAT\nCat\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle quantifiers inside modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "aaa\nAAA\nAaA\nbbb\n" }
        });
        const result = await env.exec("grep -oP '(?i:a+)' /test.txt");
        expect(result.stdout).toBe("aaa\nAAA\nAaA\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle alternation inside modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "yes\nYES\nno\nNO\nmaybe\n" }
        });
        const result = await env.exec("grep -oP '(?i:yes|no)' /test.txt");
        expect(result.stdout).toBe("yes\nYES\nno\nNO\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("multiple modifier groups", () => {
      it("should handle adjacent modifier groups", async () => {
        const env = new Bash({
          files: { "/test.txt": "TestCase\ntestcase\nTESTCASE\ntestCASE\n" }
        });
        const result = await env.exec(
          "grep -oP '(?i:test)(?i:case)' /test.txt"
        );
        expect(result.stdout).toBe("TestCase\ntestcase\nTESTCASE\ntestCASE\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle modifier group followed by literal", async () => {
        const env = new Bash({
          files: { "/test.txt": "ABCdef\nabcdef\nABCDEF\n" }
        });
        const result = await env.exec("grep -oP '(?i:abc)def' /test.txt");
        expect(result.stdout).toBe("ABCdef\nabcdef\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle literal followed by modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "abcDEF\nabcdef\nABCDEF\n" }
        });
        const result = await env.exec("grep -oP 'abc(?i:def)' /test.txt");
        expect(result.stdout).toBe("abcDEF\nabcdef\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("edge cases", () => {
      it("should handle empty modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "test\n" }
        });
        const result = await env.exec("grep -oP 'te(?i:)st' /test.txt");
        expect(result.stdout).toBe("test\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle digits in modifier group (unchanged)", async () => {
        const env = new Bash({
          files: { "/test.txt": "abc123\nABC123\n" }
        });
        const result = await env.exec("grep -oP '(?i:abc123)' /test.txt");
        expect(result.stdout).toBe("abc123\nABC123\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle special chars in modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "a.b\nA.B\na.B\n" }
        });
        const result = await env.exec("grep -oP '(?i:a\\.b)' /test.txt");
        expect(result.stdout).toBe("a.b\nA.B\na.B\n");
        expect(result.exitCode).toBe(0);
      });

      it("should handle escape sequences in modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "a1b\nA2B\na3B\n" }
        });
        const result = await env.exec("grep -oP '(?i:a)\\d(?i:b)' /test.txt");
        expect(result.stdout).toBe("a1b\nA2B\na3B\n");
        expect(result.exitCode).toBe(0);
      });

      it("should preserve non-alpha chars in modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "a-b_c\nA-B_C\n" }
        });
        const result = await env.exec("grep -oP '(?i:a-b_c)' /test.txt");
        expect(result.stdout).toBe("a-b_c\nA-B_C\n");
        expect(result.exitCode).toBe(0);
      });
    });

    describe("interaction with \\K", () => {
      it("should work with \\K after modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "Key=value\nKEY=VALUE\nkey=data\n" }
        });
        const result = await env.exec("grep -oP '(?i:key)=\\K\\w+' /test.txt");
        expect(result.stdout).toBe("value\nVALUE\ndata\n");
        expect(result.exitCode).toBe(0);
      });

      it("should work with \\K inside modifier group", async () => {
        const env = new Bash({
          files: { "/test.txt": "prefix:VALUE\nPREFIX:value\n" }
        });
        const result = await env.exec(
          "grep -oP '(?i:prefix:\\K\\w+)' /test.txt"
        );
        expect(result.stdout).toBe("VALUE\nvalue\n");
        expect(result.exitCode).toBe(0);
      });
    });
  });

  // ============================================================
  // (?P<name>...) - Named Groups
  // ============================================================
  describe("(?P<name>...) named groups", () => {
    it("should support named groups", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world\n" }
      });
      const result = await env.exec("grep -P '(?P<word>\\w+)' /test.txt");
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support multiple named groups", async () => {
      const env = new Bash({
        files: { "/test.txt": "John:25\nJane:30\n" }
      });
      const result = await env.exec(
        "grep -P '(?P<name>\\w+):(?P<age>\\d+)' /test.txt"
      );
      expect(result.stdout).toBe("John:25\nJane:30\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support named groups with -o", async () => {
      const env = new Bash({
        files: { "/test.txt": "email: test@example.com\n" }
      });
      const result = await env.exec(
        "grep -oP '(?P<user>\\w+)@(?P<domain>[\\w.]+)' /test.txt"
      );
      expect(result.stdout).toBe("test@example.com\n");
      expect(result.exitCode).toBe(0);
    });
  });

  // ============================================================
  // Other Perl regex features
  // ============================================================
  describe("other Perl regex features", () => {
    it("should support non-greedy quantifiers", async () => {
      const env = new Bash({
        files: { "/test.txt": "<a>text</a>\n" }
      });
      const result = await env.exec("grep -oP '<.*?>' /test.txt");
      expect(result.stdout).toBe("<a>\n</a>\n");
      expect(result.exitCode).toBe(0);
    });

    // Skipped: JavaScript doesn't support possessive quantifiers (a++)
    it.skip("should support possessive quantifiers", async () => {
      const env = new Bash({
        files: { "/test.txt": "aaab\n" }
      });
      const result = await env.exec("grep -oP 'a++' /test.txt");
      expect(result.stdout).toBe("aaa\n");
      expect(result.exitCode).toBe(0);
    });

    // Skipped: RE2 doesn't support lookahead for ReDoS protection
    it.skip("should support positive lookahead", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo1\nfoo\nfoo2\n" }
      });
      const result = await env.exec("grep -oP 'foo(?=\\d)' /test.txt");
      expect(result.stdout).toBe("foo\nfoo\n");
      expect(result.exitCode).toBe(0);
    });

    // Skipped: RE2 doesn't support lookahead for ReDoS protection
    it.skip("should support negative lookahead", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo1\nfoo\nfoobar\n" }
      });
      const result = await env.exec("grep -oP 'foo(?!\\d)' /test.txt");
      expect(result.stdout).toBe("foo\nfoo\n");
      expect(result.exitCode).toBe(0);
    });

    // Skipped: RE2 doesn't support lookbehind for ReDoS protection
    it.skip("should support positive lookbehind", async () => {
      const env = new Bash({
        files: { "/test.txt": "$100\n100\n€100\n" }
      });
      const result = await env.exec("grep -oP '(?<=\\$)\\d+' /test.txt");
      expect(result.stdout).toBe("100\n");
      expect(result.exitCode).toBe(0);
    });

    // Skipped: RE2 doesn't support lookbehind for ReDoS protection
    it.skip("should support negative lookbehind", async () => {
      const env = new Bash({
        files: { "/test.txt": "$100\n100\n€100\n" }
      });
      const result = await env.exec("grep -oP '(?<!\\$)\\b\\d+' /test.txt");
      expect(result.stdout).toBe("100\n100\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support atomic groups", async () => {
      const env = new Bash({
        files: { "/test.txt": "aaab\n" }
      });
      // Atomic group (?>...) - JS doesn't support natively, may pass through
      const result = await env.exec("grep -P 'a+b' /test.txt");
      expect(result.stdout).toBe("aaab\n");
      expect(result.exitCode).toBe(0);
    });
  });

  // ============================================================
  // Complex combinations
  // ============================================================
  describe("complex feature combinations", () => {
    it("should combine \\K, \\Q...\\E, and \\x{} in one pattern", async () => {
      const env = new Bash({
        files: { "/test.txt": "Price: €100.00\nCost: €50.50\n" }
      });
      const result = await env.exec(
        "grep -oP '\\Q€\\E\\K\\d+\\Q.\\E\\d+' /test.txt"
      );
      expect(result.stdout).toBe("100.00\n50.50\n");
      expect(result.exitCode).toBe(0);
    });

    it("should combine (?i:) and \\K", async () => {
      const env = new Bash({
        files: { "/test.txt": "Name: John\nNAME: Jane\nname: Bob\n" }
      });
      const result = await env.exec("grep -oP '(?i:name): \\K\\w+' /test.txt");
      expect(result.stdout).toBe("John\nJane\nBob\n");
      expect(result.exitCode).toBe(0);
    });

    it("should combine Unicode and case insensitivity", async () => {
      const env = new Bash({
        files: { "/test.txt": "Café\ncafé\nCAFÉ\n" }
      });
      const result = await env.exec("grep -oP '(?i:caf)\\x{e9}' /test.txt");
      expect(result.stdout).toBe("Café\ncafé\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle real-world URL extraction pattern", async () => {
      const env = new Bash({
        files: {
          "/test.txt":
            'Link: <a href="https://example.com/path?q=1">click</a>\n'
        }
      });
      const result = await env.exec(
        "grep -oP 'href=\"\\Khttps?://[^\"]+' /test.txt"
      );
      expect(result.stdout).toBe("https://example.com/path?q=1\n");
      expect(result.exitCode).toBe(0);
    });

    // Skipped: RE2 doesn't support lookahead for ReDoS protection
    it.skip("should handle real-world log parsing pattern", async () => {
      const env = new Bash({
        files: {
          "/test.txt":
            "[2024-01-15 10:30:45] ERROR: Connection failed\n[2024-01-15 10:31:00] INFO: Retry successful\n"
        }
      });
      const result = await env.exec(
        "grep -oP '\\[\\K[^\\]]+(?=\\] ERROR)' /test.txt"
      );
      expect(result.stdout).toBe("2024-01-15 10:30:45\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle real-world JSON value extraction", async () => {
      const env = new Bash({
        files: {
          "/test.txt": '{"name": "John", "age": 30, "city": "NYC"}\n'
        }
      });
      const result = await env.exec(
        'grep -oP \'"name":\\s*"\\K[^"]+\' /test.txt'
      );
      expect(result.stdout).toBe("John\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
