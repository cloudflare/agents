import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk user-defined functions", () => {
  describe("basic function definition", () => {
    it("should define and call a simple function", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "5" | awk 'function double(x) { return x * 2 } { print double($1) }'`
      );
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should define function with multiple parameters", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "3 4" | awk 'function add(a, b) { return a + b } { print add($1, $2) }'`
      );
      expect(result.stdout).toBe("7\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support function with no parameters", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'function greet() { return "hello" } BEGIN { print greet() }'`
      );
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("variable scoping", () => {
    it("should make non-parameter variables global", async () => {
      const env = new Bash();
      // Variables assigned in function (not parameters) should persist globally
      const result = await env.exec(
        `echo "" | awk 'function foo() { x = 42 } BEGIN { foo(); print x }'`
      );
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should make parameters local to function", async () => {
      const env = new Bash();
      // Parameters should not affect global variables with same name
      const result = await env.exec(
        `echo "" | awk 'function foo(x) { x = 99 } BEGIN { x = 1; foo(5); print x }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use extra parameters as local variables", async () => {
      const env = new Bash();
      // Extra parameters (declared but not passed) are local and initialized to ""
      const result = await env.exec(
        `echo "" | awk 'function foo(a,    local) { local = 100; return a + local } BEGIN { local = 5; print foo(1), local }'`
      );
      expect(result.stdout).toBe("101 5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle local variables in function", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "5" | awk 'function square(x) { result = x * x; return result } { print square($1) }'`
      );
      expect(result.stdout).toBe("25\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("recursive functions", () => {
    it("should support simple recursion", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "5" | awk 'function fact(n) { if (n <= 1) return 1; return n * fact(n-1) } { print fact($1) }'`
      );
      expect(result.stdout).toBe("120\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support fibonacci", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "10" | awk 'function fib(n) { if (n <= 2) return 1; return fib(n-1) + fib(n-2) } { print fib($1) }'`
      );
      expect(result.stdout).toBe("55\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("function calling other functions", () => {
    it("should allow functions to call other functions", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "3" | awk 'function double(x) { return x * 2 } function quadruple(x) { return double(double(x)) } { print quadruple($1) }'`
      );
      expect(result.stdout).toBe("12\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("function with string operations", () => {
    it("should handle string return values", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "world" | awk 'function greet(name) { return "hello " name } { print greet($1) }'`
      );
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("function in BEGIN/END blocks", () => {
    it("should work in BEGIN block", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'function sum(a,b) { return a+b } BEGIN { print sum(10, 20) }'`
      );
      expect(result.stdout).toBe("30\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("multiple functions", () => {
    it("should support multiple function definitions", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "4" | awk 'function square(x) { return x*x } function cube(x) { return x*x*x } { print square($1), cube($1) }'`
      );
      expect(result.stdout).toBe("16 64\n");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("awk multiple rules", () => {
  describe("pattern action pairs", () => {
    it("should execute multiple rules in order", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple\nbanana\ncherry\n" }
      });
      const result = await env.exec(
        `awk '/apple/{print "FRUIT"} /banana/{print "YELLOW"}' /data.txt`
      );
      expect(result.stdout).toBe("FRUIT\nYELLOW\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle pattern with next to skip rules", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec(`awk '/b/{next}{print}' /data.txt`);
      expect(result.stdout).toBe("a\nc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should execute default action (print) for pattern-only rules", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello\nworld\nhello world\n" }
      });
      const result = await env.exec(`awk '/hello/' /data.txt`);
      expect(result.stdout).toBe("hello\nhello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle mixed pattern and action-only rules", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n" }
      });
      const result = await env.exec(
        `awk '/2/{print "TWO"} {print "line:" $0}' /data.txt`
      );
      expect(result.stdout).toBe("line:1\nTWO\nline:2\nline:3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("BEGIN and END with main rules", () => {
    it("should execute BEGIN, main rules, and END in order", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\n" }
      });
      const result = await env.exec(
        `awk 'BEGIN{print "START"} {print $0} END{print "END"}' /data.txt`
      );
      expect(result.stdout).toBe("START\na\nb\nEND\n");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("awk control flow", () => {
  describe("next statement", () => {
    it("should skip to next record", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n4\n5\n" }
      });
      const result = await env.exec(
        `awk '{ if ($1 % 2 == 0) next; print }' /data.txt`
      );
      expect(result.stdout).toBe("1\n3\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should skip remaining rules for current line", async () => {
      const env = new Bash({
        files: { "/data.txt": "skip\nkeep\n" }
      });
      const result = await env.exec(
        `awk '/skip/{next}{print "processed:", $0}' /data.txt`
      );
      expect(result.stdout).toBe("processed: keep\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("exit statement", () => {
    it("should exit immediately with code", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n" }
      });
      const result = await env.exec(
        `awk '{ if ($1 == 2) exit 42; print }' /data.txt`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(42);
    });

    it("should exit with 0 by default", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n" }
      });
      const result = await env.exec(
        `awk '{ if ($1 == 2) exit; print }' /data.txt`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("break and continue in loops", () => {
    it("should break out of for loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { for(i=1; i<=10; i++) { if(i>5) break; print i } }'`
      );
      expect(result.stdout).toBe("1\n2\n3\n4\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should continue to next iteration", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { for(i=1; i<=5; i++) { if(i==3) continue; print i } }'`
      );
      expect(result.stdout).toBe("1\n2\n4\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should break out of while loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { i=0; while(1) { i++; if(i>3) break; print i } }'`
      );
      expect(result.stdout).toBe("1\n2\n3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should continue in while loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { i=0; while(i<5) { i++; if(i==3) continue; print i } }'`
      );
      expect(result.stdout).toBe("1\n2\n4\n5\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("do-while loops", () => {
    it("should execute body at least once", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { i=10; do { print i; i++ } while(i<10) }'`
      );
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should loop while condition is true", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { i=1; do { print i; i++ } while(i<=3) }'`
      );
      expect(result.stdout).toBe("1\n2\n3\n");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("awk built-in variables", () => {
  describe("FILENAME", () => {
    it("should contain current filename", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\n" }
      });
      const result = await env.exec(`awk '{print FILENAME}' /test.txt`);
      expect(result.stdout).toBe("/test.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should be empty for stdin", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "test" | awk '{print FILENAME}'`);
      expect(result.stdout).toBe("\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("FNR", () => {
    it("should reset for each file", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "a1\na2\n",
          "/b.txt": "b1\nb2\nb3\n"
        }
      });
      const result = await env.exec(
        `awk '{print FILENAME, FNR, NR}' /a.txt /b.txt`
      );
      expect(result.stdout).toBe(
        "/a.txt 1 1\n/a.txt 2 2\n/b.txt 1 3\n/b.txt 2 4\n/b.txt 3 5\n"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("RSTART and RLENGTH", () => {
    it("should be set by match()", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello world" | awk '{ match($0, /wor/); print RSTART, RLENGTH }'`
      );
      expect(result.stdout).toBe("7 3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should be 0 and -1 when no match", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '{ match($0, /xyz/); print RSTART, RLENGTH }'`
      );
      expect(result.stdout).toBe("0 -1\n");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("awk string functions", () => {
  describe("match()", () => {
    it("should return position of match", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello world" | awk '{ print match($0, /world/) }'`
      );
      expect(result.stdout).toBe("7\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 for no match", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello" | awk '{ print match($0, /xyz/) }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with regex patterns", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test123abc" | awk '{ match($0, /[0-9]+/); print RSTART, RLENGTH }'`
      );
      expect(result.stdout).toBe("5 3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("gensub()", () => {
    it("should replace first occurrence", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello hello" | awk '{ print gensub(/hello/, "hi", 1) }'`
      );
      expect(result.stdout).toBe("hi hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should replace all occurrences with g", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello hello" | awk '{ print gensub(/hello/, "hi", "g") }'`
      );
      expect(result.stdout).toBe("hi hi\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support backreferences", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello world" | awk '{ print gensub(/([a-z]+) ([a-z]+)/, "\\\\2 \\\\1", 1) }'`
      );
      expect(result.stdout).toBe("world hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should replace Nth occurrence", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b a b a" | awk '{ print gensub(/a/, "X", 2) }'`
      );
      expect(result.stdout).toBe("a b X b a\n");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("awk arithmetic", () => {
  describe("power operator", () => {
    it("should compute power with ^", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 2^10 }'`);
      expect(result.stdout).toBe("1024\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compute power with **", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 3**4 }'`);
      expect(result.stdout).toBe("81\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle fractional exponents", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 9^0.5 }'`);
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("awk printf formats", () => {
  describe("hexadecimal %x", () => {
    it("should format as hex lowercase", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf "%x\\n", 255 }'`
      );
      expect(result.stdout).toBe("ff\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format as hex uppercase", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf "%X\\n", 255 }'`
      );
      expect(result.stdout).toBe("FF\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("octal %o", () => {
    it("should format as octal", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf "%o\\n", 64 }'`
      );
      expect(result.stdout).toBe("100\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("character %c", () => {
    it("should format number as character", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf "%c\\n", 65 }'`
      );
      expect(result.stdout).toBe("A\n");
      expect(result.exitCode).toBe(0);
    });

    it("should format string first char", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf "%c\\n", "hello" }'`
      );
      expect(result.stdout).toBe("h\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("scientific %e", () => {
    it("should format in scientific notation", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf "%.2e\\n", 1234.5 }'`
      );
      expect(result.stdout).toBe("1.23e+3\n");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("awk field separator", () => {
  describe("regex field separator -F", () => {
    it("should split on regex pattern", async () => {
      const env = new Bash({
        files: { "/data.txt": "a1b2c3d\n" }
      });
      const result = await env.exec(
        `awk -F'[0-9]' '{print $1, $2, $3, $4}' /data.txt`
      );
      expect(result.stdout).toBe("a b c d\n");
      expect(result.exitCode).toBe(0);
    });

    it("should split on multiple characters", async () => {
      const env = new Bash({
        files: { "/data.txt": "a::b::c\n" }
      });
      const result = await env.exec(
        `awk -F'::' '{print $1, $2, $3}' /data.txt`
      );
      expect(result.stdout).toBe("a b c\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle character class", async () => {
      const env = new Bash({
        files: { "/data.txt": "a,b;c:d\n" }
      });
      const result = await env.exec(
        `awk -F'[,;:]' '{print $1, $2, $3, $4}' /data.txt`
      );
      expect(result.stdout).toBe("a b c d\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
