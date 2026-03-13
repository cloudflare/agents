import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk string functions", () => {
  describe("length()", () => {
    it("should return length of string", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '{ print length($0) }'`
      );
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 for empty string", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print length("") }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use $0 when called without argument", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "abcdefg" | awk '{ print length() }'`
      );
      expect(result.stdout).toBe("7\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle numbers", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print length(12345) }'`
      );
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("substr()", () => {
    it("should extract substring from start position", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print substr("hello world", 7) }'`
      );
      expect(result.stdout).toBe("world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should extract substring with length", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print substr("hello world", 1, 5) }'`
      );
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle start position beyond string length", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "[" substr("abc", 10) "]" }'`
      );
      expect(result.stdout).toBe("[]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle position 0 (treated as 1)", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print substr("hello", 0, 3) }'`
      );
      expect(result.stdout).toBe("hel\n");
      expect(result.exitCode).toBe(0);
    });

    it("should extract middle portion", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print substr("abcdefgh", 3, 4) }'`
      );
      expect(result.stdout).toBe("cdef\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("index()", () => {
    it("should return position of substring", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print index("hello world", "world") }'`
      );
      expect(result.stdout).toBe("7\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 when not found", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print index("hello", "xyz") }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should find single character", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print index("abcdef", "c") }'`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should find first occurrence", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print index("abcabc", "bc") }'`
      );
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return 1 for empty needle", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print index("hello", "") }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("tolower()", () => {
    it("should convert string to lowercase", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print tolower("HELLO WORLD") }'`
      );
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should preserve already lowercase", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print tolower("hello") }'`
      );
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle mixed case", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print tolower("HeLLo WoRLd") }'`
      );
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should preserve non-alphabetic characters", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print tolower("ABC123!@#") }'`
      );
      expect(result.stdout).toBe("abc123!@#\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("toupper()", () => {
    it("should convert string to uppercase", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print toupper("hello world") }'`
      );
      expect(result.stdout).toBe("HELLO WORLD\n");
      expect(result.exitCode).toBe(0);
    });

    it("should preserve already uppercase", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print toupper("HELLO") }'`
      );
      expect(result.stdout).toBe("HELLO\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle mixed case", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print toupper("HeLLo WoRLd") }'`
      );
      expect(result.stdout).toBe("HELLO WORLD\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("sub()", () => {
    it("should replace first occurrence", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello hello" | awk '{ sub(/hello/, "hi"); print }'`
      );
      expect(result.stdout).toBe("hi hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return number of replacements", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '{ n = sub(/l/, "L"); print n, $0 }'`
      );
      expect(result.stdout).toBe("1 heLlo\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 when no match", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '{ n = sub(/x/, "X"); print n, $0 }'`
      );
      expect(result.stdout).toBe("0 hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with specific variable", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk '{ x = "foo bar foo"; sub(/foo/, "baz", x); print x }'`
      );
      expect(result.stdout).toBe("baz bar foo\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with & in replacement (matched text)", async () => {
      // Note: & replacement in sub/gsub is not fully implemented
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '{ sub(/ll/, "[&]"); print }'`
      );
      expect(result.stdout).toBe("he[ll]o\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("gsub()", () => {
    it("should replace all occurrences", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello hello hello" | awk '{ gsub(/hello/, "hi"); print }'`
      );
      expect(result.stdout).toBe("hi hi hi\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return number of replacements", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "ababa" | awk '{ n = gsub(/a/, "X"); print n, $0 }'`
      );
      expect(result.stdout).toBe("3 XbXbX\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 when no match", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '{ n = gsub(/x/, "X"); print n, $0 }'`
      );
      expect(result.stdout).toBe("0 hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with specific field", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "aaa bbb aaa" | awk '{ gsub(/a/, "X", $1); print }'`
      );
      expect(result.stdout).toBe("XXX bbb aaa\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle regex patterns", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a1b2c3" | awk '{ gsub(/[0-9]/, "#"); print }'`
      );
      expect(result.stdout).toBe("a#b#c#\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("sprintf()", () => {
    it("should format string with %s", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print sprintf("Hello %s!", "World") }'`
      );
      expect(result.stdout).toBe("Hello World!\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format integer with %d", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print sprintf("Value: %d", 42) }'`
      );
      expect(result.stdout).toBe("Value: 42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format float with %f", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print sprintf("Pi: %.2f", 3.14159) }'`
      );
      expect(result.stdout).toBe("Pi: 3.14\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle width specifier", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print sprintf("[%10s]", "hi") }'`
      );
      expect(result.stdout).toBe("[        hi]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle left justify with -", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print sprintf("[%-10s]", "hi") }'`
      );
      expect(result.stdout).toBe("[hi        ]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle zero padding with %0d", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print sprintf("%05d", 42) }'`
      );
      expect(result.stdout).toBe("00042\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple format specifiers", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print sprintf("%s: %d (%.1f%%)", "Score", 85, 85.0) }'`
      );
      expect(result.stdout).toBe("Score: 85 (85.0%)\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("string concatenation", () => {
    it("should concatenate with space (juxtaposition)", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a = "hello"; b = "world"; print a " " b }'`
      );
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should concatenate strings directly", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "foo" "bar" "baz" }'`
      );
      expect(result.stdout).toBe("foobarbaz\n");
      expect(result.exitCode).toBe(0);
    });

    it("should concatenate numbers as strings", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 1 2 3 }'`);
      expect(result.stdout).toBe("123\n");
      expect(result.exitCode).toBe(0);
    });

    it("should concatenate with assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { s = "a"; s = s "b"; s = s "c"; print s }'`
      );
      expect(result.stdout).toBe("abc\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("string comparison", () => {
    it("should compare strings with ==", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { if ("abc" == "abc") print "equal" }'`
      );
      expect(result.stdout).toBe("equal\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compare strings with !=", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { if ("abc" != "xyz") print "different" }'`
      );
      expect(result.stdout).toBe("different\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compare strings lexicographically with <", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { if ("abc" < "abd") print "less" }'`
      );
      expect(result.stdout).toBe("less\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compare strings lexicographically with >", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { if ("z" > "a") print "greater" }'`
      );
      expect(result.stdout).toBe("greater\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("string to number conversion", () => {
    it("should convert numeric string to number", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print "42" + 0 }'`);
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should convert string with leading number", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "123abc" + 0 }'`
      );
      expect(result.stdout).toBe("123\n");
      expect(result.exitCode).toBe(0);
    });

    it("should convert non-numeric string to 0", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "hello" + 0 }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should convert number to string with concatenation", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { n = 42; print n "" }'`
      );
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
