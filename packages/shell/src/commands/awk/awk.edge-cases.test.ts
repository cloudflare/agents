import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk edge cases", () => {
  describe("empty input handling", () => {
    it("should handle empty file", async () => {
      const env = new Bash({
        files: { "/empty.txt": "" }
      });
      const result = await env.exec(`awk '{ print "line" }' /empty.txt`);
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should run BEGIN with empty file", async () => {
      const env = new Bash({
        files: { "/empty.txt": "" }
      });
      const result = await env.exec(
        `awk 'BEGIN { print "start" } { print } END { print "end" }' /empty.txt`
      );
      expect(result.stdout).toBe("start\nend\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty stdin", async () => {
      const env = new Bash();
      const result = await env.exec(`echo -n "" | awk '{ print "line" }'`);
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle file with only newlines", async () => {
      const env = new Bash({
        files: { "/newlines.txt": "\n\n\n" }
      });
      const result = await env.exec(`awk '{ print NR, NF }' /newlines.txt`);
      expect(result.stdout).toBe("1 0\n2 0\n3 0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("special characters in data", () => {
    it("should handle quotes in data", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo 'he said "hello"' | awk '{ print $3 }'`
      );
      expect(result.stdout).toBe('"hello"\n');
      expect(result.exitCode).toBe(0);
    });

    it("should handle backslash in data", async () => {
      const env = new Bash();
      // In single quotes, backslashes are literal - no escaping
      const result = await env.exec(
        `echo 'path\\\\to\\\\file' | awk '{ print }'`
      );
      // JS \\\\  -> bash \\ (two backslashes each), single quotes preserve literally
      expect(result.stdout).toBe("path\\\\to\\\\file\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle brackets in data", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "[test]" | awk '{ print $1 }'`);
      expect(result.stdout).toBe("[test]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle dollar sign in data", async () => {
      const env = new Bash();
      // In single quotes, backslash and dollar are literal - no escaping
      const result = await env.exec(
        `echo 'price: \\$100' | awk '{ print $2 }'`
      );
      // JS \\$ -> bash \$ (backslash + dollar), single quotes preserve literally
      expect(result.stdout).toBe("\\$100\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle ampersand in data", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "a & b" | awk '{ print $2 }'`);
      expect(result.stdout).toBe("&\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("numeric edge cases", () => {
    it("should handle very large numbers", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 1e308 }'`);
      expect(result.stdout).toMatch(/1e\+?308/i);
      expect(result.exitCode).toBe(0);
    });

    it("should handle very small numbers", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 1e-308 }'`);
      expect(result.stdout).toMatch(/1e-308/i);
      expect(result.exitCode).toBe(0);
    });

    it("should handle negative zero", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print -0 }'`);
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle floating point precision", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print 0.1 + 0.2 }'`
      );
      // JavaScript floating point: 0.30000000000000004
      expect(parseFloat(result.stdout.trim())).toBeCloseTo(0.3, 10);
      expect(result.exitCode).toBe(0);
    });

    it("should handle integer overflow gracefully", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print 9999999999999999999999 }'`
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("string edge cases", () => {
    it("should handle empty string comparison", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print ("" == "") }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle null character equivalent", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = ""; print length(x) }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle very long string", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { for(i=0;i<100;i++) s=s"x"; print length(s) }'`
      );
      expect(result.stdout).toBe("100\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle string with only spaces", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "     " | awk '{ print NF }'`);
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("regex edge cases", () => {
    it("should match empty regex", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "test" | awk '//' | head -1`);
      expect(result.stdout).toBe("test\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle regex with special chars", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a.b" | awk '/a\\.b/ { print "matched" }'`
      );
      expect(result.stdout).toBe("matched\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle regex at line start", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk '/^test/ { print "yes" }'`
      );
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle regex at line end", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk '/test$/ { print "yes" }'`
      );
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle case-sensitive regex", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "TEST" | awk '/test/ { print "matched" }'`
      );
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("control flow edge cases", () => {
    it("should handle empty action block", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "test" | awk '{ }'`);
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle nested if without else", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "5" | awk '{ if ($1 > 3) if ($1 < 10) print "yes" }'`
      );
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple semicolons", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x=1;; y=2;;; print x+y }'`
      );
      expect(result.stdout).toBe("3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle loop with zero iterations", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { for(i=0; i<0; i++) print i; print "done" }'`
      );
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle while with false condition", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { while(0) print "never"; print "done" }'`
      );
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("variable edge cases", () => {
    it("should handle uninitialized variable as number", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print x + 0 }'`);
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle uninitialized variable as string", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "[" x "]" }'`
      );
      expect(result.stdout).toBe("[]\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle variable shadowing built-in", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "a b c" | awk '{ NF = 100; print NF }'`
      );
      expect(result.stdout).toBe("100\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle assignment in condition", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { if (x = 5) print x }'`
      );
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("array edge cases", () => {
    it("should handle empty array iteration", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { for (k in arr) print k; print "done" }'`
      );
      expect(result.stdout).toBe("done\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle numeric string as key", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a["1"] = "one"; a[1] = "ONE"; print a[1] }'`
      );
      expect(result.stdout).toBe("ONE\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle delete on empty array", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { delete arr["x"]; print "ok" }'`
      );
      expect(result.stdout).toBe("ok\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("print edge cases", () => {
    it("should handle print without arguments", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "test" | awk '{ print }'`);
      expect(result.stdout).toBe("test\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle printf without newline", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { printf "no newline" }'`
      );
      expect(result.stdout).toBe("no newline");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple print statements", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "a"; print "b"; print "c" }'`
      );
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("BEGIN/END edge cases", () => {
    it("should run only BEGIN when no input", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo -n "" | awk 'BEGIN { print "begin" } { print "main" } END { print "end" }'`
      );
      expect(result.stdout).toBe("begin\nend\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple BEGIN blocks", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "first" } BEGIN { print "second" }'`
      );
      expect(result.stdout).toBe("first\nsecond\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple END blocks", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "x" | awk 'END { print "first" } END { print "second" }'`
      );
      expect(result.stdout).toBe("first\nsecond\n");
      expect(result.exitCode).toBe(0);
    });

    it("should preserve variables from BEGIN in main", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "test" | awk 'BEGIN { x = 42 } { print x }'`
      );
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should access NR in END", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\n" }
      });
      const result = await env.exec(
        `awk 'END { print "Total lines:", NR }' /data.txt`
      );
      expect(result.stdout).toBe("Total lines: 3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("type coercion edge cases", () => {
    it("should compare string and number", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print ("10" == 10) }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle string in arithmetic", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print "5" + "3" }'`
      );
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle number in string context", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print length(12345) }'`
      );
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
