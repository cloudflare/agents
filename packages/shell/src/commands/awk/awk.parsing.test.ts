import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk parsing", () => {
  describe("whitespace handling", () => {
    it("should handle no whitespace between tokens", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN{x=1;y=2;print x+y}'`);
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle extra whitespace", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {   x  =  1  ;  y  =  2  ;  print  x + y  }'`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle newlines in program", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN {
        x = 1
        y = 2
        print x + y
      }'`);
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle tabs in program", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN {\tx=1;\ty=2;\tprint x+y}'`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("string parsing", () => {
    it("should handle escaped quotes in string", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "he said \\"hello\\"" }'`
      );
      expect(result.stdout).toBe('he said "hello"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should handle backslash sequences", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "a\\tb\\nc" }'`
      );
      expect(result.stdout).toBe("a\tb\nc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty string", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "[" "" "]" }'`
      );
      expect(result.stdout).toBe("[]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle string with only escape", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print "\\n" }'`);
      expect(result.stdout).toBe("\n\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("number parsing", () => {
    it("should parse integers", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 42 }'`);
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse floating point", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 3.14 }'`);
      expect(result.stdout).toBe("3.14\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse scientific notation", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 1e3 }'`);
      expect(result.stdout).toBe("1000\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse negative scientific notation", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 1e-2 }'`);
      expect(result.stdout).toBe("0.01\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse leading decimal", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print .5 }'`);
      expect(result.stdout).toBe("0.5\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("regex parsing", () => {
    it("should parse simple regex", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '/hello/ { print "matched" }'`
      );
      expect(result.stdout).toBe("matched\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse regex with special chars", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a.b" | awk '/a\\.b/ { print "matched" }'`
      );
      expect(result.stdout).toBe("matched\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse regex with brackets", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "abc" | awk '/[abc]+/ { print "matched" }'`
      );
      expect(result.stdout).toBe("matched\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse regex with anchors", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '/^hello$/ { print "matched" }'`
      );
      expect(result.stdout).toBe("matched\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse regex with quantifiers", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "aaa" | awk '/a+/ { print "matched" }'`
      );
      expect(result.stdout).toBe("matched\n");
      expect(result.exitCode).toBe(0);
    });

    it("should distinguish regex from division", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 10 / 2; print x }'`
      );
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("comment handling", () => {
    it("should ignore line comments", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN {
        x = 1 # this is a comment
        print x
      }'`);
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle comment at end of statement", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 1; # comment
        print x }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("operator parsing", () => {
    it("should parse two-character operators", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (1 <= 2), (2 >= 1), (1 == 1), (1 != 2) }'`
      );
      expect(result.stdout).toBe("1 1 1 1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse compound assignment operators", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x=10; x+=5; x-=3; x*=2; x/=4; print x }'`
      );
      // ((10+5)-3)*2/4 = (12)*2/4 = 24/4 = 6
      expect(result.stdout).toBe("6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse increment/decrement", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x=5; print ++x, x++, x }'`
      );
      expect(result.stdout).toBe("6 6 7\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse logical operators", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (1 && 1), (1 || 0), !0 }'`
      );
      expect(result.stdout).toBe("1 1 1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse regex operators", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '{ print ($0 ~ /hello/), ($0 !~ /world/) }'`
      );
      expect(result.stdout).toBe("1 1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("block structure parsing", () => {
    it("should parse empty blocks", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "test" | awk '{ } { print "ok" }'`);
      expect(result.stdout).toBe("ok\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse multiple rules", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk '/test/ { print "1" } /test/ { print "2" }'`
      );
      expect(result.stdout).toBe("1\n2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse BEGIN and END together", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "x" | awk 'BEGIN { print "B" } END { print "E" }'`
      );
      expect(result.stdout).toBe("B\nE\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse pattern without action", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "hello" | awk '/hello/'`);
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse action without pattern", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "hello" | awk '{ print "matched" }'`);
      expect(result.stdout).toBe("matched\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("statement parsing", () => {
    it("should parse if statement", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { if (1) print "yes" }'`
      );
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse if-else statement", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { if (0) print "yes"; else print "no" }'`
      );
      expect(result.stdout).toBe("no\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse for loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { for (i=1; i<=3; i++) printf i; print "" }'`
      );
      expect(result.stdout).toBe("123\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse while loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { i=1; while(i<=3) { printf i; i++ }; print "" }'`
      );
      expect(result.stdout).toBe("123\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse do-while loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { i=1; do { printf i; i++ } while(i<=3); print "" }'`
      );
      expect(result.stdout).toBe("123\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse for-in loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a[1]=1; a[2]=2; for (k in a) sum+=a[k]; print sum }'`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("function definition parsing", () => {
    it("should parse function with no params", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'function hello() { return "hi" } BEGIN { print hello() }'`
      );
      expect(result.stdout).toBe("hi\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse function with params", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'function add(a, b) { return a + b } BEGIN { print add(2, 3) }'`
      );
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse multiple functions", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk '
          function f1() { return 1 }
          function f2() { return 2 }
          BEGIN { print f1() + f2() }
        '`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("expression parsing edge cases", () => {
    it("should parse negative numbers", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print -5 }'`);
      expect(result.stdout).toBe("-5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse double negative on literal", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print --5 }'`);
      // --5 should be interpreted as -(-5) = 5
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse chained field access", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "1 2 3" | awk '{ print $($1) }'`);
      // $1 = "1", $($1) = $(1) = "1"
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse array with expression index", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a[1+1] = "two"; print a[2] }'`
      );
      expect(result.stdout).toBe("two\n");
      expect(result.exitCode).toBe(0);
    });

    it("should parse ternary with nested expressions", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (1 ? (2 ? "a" : "b") : "c") }'`
      );
      expect(result.stdout).toBe("a\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error cases", () => {
    it("should error on missing program", async () => {
      const env = new Bash();
      const result = await env.exec(`awk`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing");
    });

    it("should error on invalid option", async () => {
      const env = new Bash();
      const result = await env.exec(`awk --invalid-option '{print}'`);
      expect(result.exitCode).toBe(1);
    });

    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec(`awk '{print}' /nonexistent.txt`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No such file");
    });
  });
});
