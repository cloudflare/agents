import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk operators", () => {
  describe("arithmetic operators", () => {
    it("should perform addition", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 5 + 3 }'`);
      expect(result.stdout).toBe("8\n");
      expect(result.exitCode).toBe(0);
    });

    it("should perform subtraction", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 10 - 4 }'`);
      expect(result.stdout).toBe("6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should perform multiplication", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 6 * 7 }'`);
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should perform division", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 20 / 4 }'`);
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should perform modulo", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 17 % 5 }'`);
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle negative modulo", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print -17 % 5 }'`);
      expect(result.stdout).toBe("-2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should perform exponentiation with ^", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 2 ^ 8 }'`);
      expect(result.stdout).toBe("256\n");
      expect(result.exitCode).toBe(0);
    });

    it("should perform exponentiation with **", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 3 ** 3 }'`);
      expect(result.stdout).toBe("27\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle unary minus", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 5; print -x }'`
      );
      expect(result.stdout).toBe("-5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle unary plus", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = "42"; print +x }'`
      );
      expect(result.stdout).toBe("42\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle division by zero", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 10 / 0 }'`);
      // AWK typically returns inf or 0 for division by zero
      expect(result.exitCode).toBe(0);
    });
  });

  describe("comparison operators", () => {
    it("should compare with ==", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (5 == 5), (5 == 6) }'`
      );
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compare with !=", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (5 != 6), (5 != 5) }'`
      );
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compare with <", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (3 < 5), (5 < 3) }'`
      );
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compare with <=", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (3 <= 5), (5 <= 5), (6 <= 5) }'`
      );
      expect(result.stdout).toBe("1 1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compare with >", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (5 > 3), (3 > 5) }'`
      );
      expect(result.stdout).toBe("1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compare with >=", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (5 >= 3), (5 >= 5), (3 >= 5) }'`
      );
      expect(result.stdout).toBe("1 1 0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("logical operators", () => {
    it("should evaluate && (AND)", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (1 && 1), (1 && 0), (0 && 1), (0 && 0) }'`
      );
      expect(result.stdout).toBe("1 0 0 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate || (OR)", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (1 || 1), (1 || 0), (0 || 1), (0 || 0) }'`
      );
      expect(result.stdout).toBe("1 1 1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate ! (NOT)", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print !1, !0, !"", !"x" }'`
      );
      expect(result.stdout).toBe("0 1 1 0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should short-circuit &&", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x=0; (0 && (x=1)); print x }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should short-circuit ||", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x=0; (1 || (x=1)); print x }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("regex match operators", () => {
    it("should match with ~ operator", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello world" | awk '{ print ($0 ~ /world/) }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not match with ~ operator", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello world" | awk '{ print ($0 ~ /foo/) }'`
      );
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use !~ for negative match", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "hello world" | awk '{ print ($0 !~ /foo/) }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use ~ in condition", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple\nbanana\napricot\ncherry\n" }
      });
      const result = await env.exec(`awk '$0 ~ /^a/ { print }' /data.txt`);
      expect(result.stdout).toBe("apple\napricot\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use !~ in condition", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple\nbanana\napricot\ncherry\n" }
      });
      const result = await env.exec(`awk '$0 !~ /^a/ { print }' /data.txt`);
      expect(result.stdout).toBe("banana\ncherry\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match field with regex", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "123 abc 456" | awk '{ print ($2 ~ /[a-z]+/) }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ternary operator", () => {
    it("should evaluate true branch", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (1 ? "yes" : "no") }'`
      );
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate false branch", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (0 ? "yes" : "no") }'`
      );
      expect(result.stdout).toBe("no\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with expressions", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x=5; print (x > 3 ? "big" : "small") }'`
      );
      expect(result.stdout).toBe("big\n");
      expect(result.exitCode).toBe(0);
    });

    it("should nest ternary operators", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x=5; print (x<3 ? "low" : (x<7 ? "mid" : "high")) }'`
      );
      expect(result.stdout).toBe("mid\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use ternary with fields", async () => {
      const env = new Bash({
        files: { "/data.txt": "10\n25\n5\n" }
      });
      const result = await env.exec(
        `awk '{ print ($1 > 15 ? "high" : "low") }' /data.txt`
      );
      expect(result.stdout).toBe("low\nhigh\nlow\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work in print arguments", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "5" | awk '{ print "Value is " ($1 % 2 == 0 ? "even" : "odd") }'`
      );
      expect(result.stdout).toBe("Value is odd\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("assignment operators", () => {
    it("should handle = assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 10; print x }'`
      );
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle += compound assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 10; x += 5; print x }'`
      );
      expect(result.stdout).toBe("15\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle -= compound assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 10; x -= 3; print x }'`
      );
      expect(result.stdout).toBe("7\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle *= compound assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 4; x *= 3; print x }'`
      );
      expect(result.stdout).toBe("12\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle /= compound assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 20; x /= 4; print x }'`
      );
      expect(result.stdout).toBe("5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle %= compound assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 17; x %= 5; print x }'`
      );
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle ^= compound assignment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 2; x ^= 4; print x }'`
      );
      expect(result.stdout).toBe("16\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("increment/decrement operators", () => {
    it("should handle pre-increment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 5; print ++x, x }'`
      );
      expect(result.stdout).toBe("6 6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle post-increment", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 5; print x++, x }'`
      );
      expect(result.stdout).toBe("5 6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle pre-decrement", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 5; print --x, x }'`
      );
      expect(result.stdout).toBe("4 4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle post-decrement", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 5; print x--, x }'`
      );
      expect(result.stdout).toBe("5 4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should chain increments in expression", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 1; y = x++ + ++x; print y, x }'`
      );
      // x starts at 1, x++ returns 1 (x becomes 2), ++x returns 3 (x becomes 3)
      // y = 1 + 3 = 4
      expect(result.stdout).toBe("4 3\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("operator precedence", () => {
    it("should handle multiplication before addition", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print 2 + 3 * 4 }'`
      );
      expect(result.stdout).toBe("14\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle parentheses for grouping", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print (2 + 3) * 4 }'`
      );
      expect(result.stdout).toBe("20\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle exponent before multiplication", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print 2 * 3 ^ 2 }'`
      );
      expect(result.stdout).toBe("18\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle comparison before logical", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print 1 < 2 && 3 < 4 }'`
      );
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle complex precedence", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print 2 + 3 * 4 ^ 2 - 10 / 2 }'`
      );
      // 4^2 = 16, 3*16 = 48, 10/2 = 5, 2 + 48 - 5 = 45
      expect(result.stdout).toBe("45\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle unary minus precedence", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print -2 ^ 2 }'`);
      // In AWK, -2^2 is -(2^2) = -4
      expect(result.stdout).toBe("-4\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
