import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk ternary operator", () => {
  describe("basic ternary", () => {
    it("should return true branch when condition is true", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print 1 ? "yes" : "no" }'`
      );
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return false branch when condition is false", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print 0 ? "yes" : "no" }'`
      );
      expect(result.stdout).toBe("no\n");
      expect(result.exitCode).toBe(0);
    });

    it("should evaluate expressions in branches", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 5; print x > 3 ? x * 2 : x / 2 }'`
      );
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ternary with comparisons", () => {
    it("should work with numeric comparison", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { n = 10; print n > 5 ? "big" : "small" }'`
      );
      expect(result.stdout).toBe("big\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with string comparison", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { s = "hello"; print s == "hello" ? "match" : "no match" }'`
      );
      expect(result.stdout).toBe("match\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with equality check", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n" }
      });
      const result = await env.exec(
        `awk '{ print $1 == 2 ? "two" : "not two" }' /data.txt`
      );
      expect(result.stdout).toBe("not two\ntwo\nnot two\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("nested ternary", () => {
    it("should handle nested ternary", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 0; print x > 0 ? "positive" : x < 0 ? "negative" : "zero" }'`
      );
      expect(result.stdout).toBe("zero\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple nesting", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 5; print x == 1 ? "one" : x == 2 ? "two" : x == 3 ? "three" : "other" }'`
      );
      expect(result.stdout).toBe("other\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ternary in assignments", () => {
    it("should assign ternary result to variable", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a = 10; b = a > 5 ? "high" : "low"; print b }'`
      );
      expect(result.stdout).toBe("high\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use ternary in compound expression", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 3; y = (x > 2 ? 10 : 1) + 5; print y }'`
      );
      expect(result.stdout).toBe("15\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ternary with functions", () => {
    it("should call function in condition", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print length("abc") > 2 ? "long" : "short" }'`
      );
      expect(result.stdout).toBe("long\n");
      expect(result.exitCode).toBe(0);
    });

    it("should call function in branches", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 1; print x ? toupper("yes") : tolower("NO") }'`
      );
      expect(result.stdout).toBe("YES\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ternary with fields", () => {
    it("should use field in condition", async () => {
      const env = new Bash({
        files: { "/data.txt": "10\n5\n20\n" }
      });
      const result = await env.exec(
        `awk '{ print $1 > 10 ? "big" : "small" }' /data.txt`
      );
      expect(result.stdout).toBe("small\nsmall\nbig\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use field in branches", async () => {
      const env = new Bash({
        files: { "/data.txt": "a 1\nb 2\nc 3\n" }
      });
      const result = await env.exec(
        `awk '{ print $2 % 2 == 0 ? $1 : toupper($1) }' /data.txt`
      );
      expect(result.stdout).toBe("A\nb\nC\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ternary truthiness", () => {
    it("should treat empty string as false", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = ""; print x ? "truthy" : "falsy" }'`
      );
      expect(result.stdout).toBe("falsy\n");
      expect(result.exitCode).toBe(0);
    });

    it("should treat non-empty string as true", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = "hello"; print x ? "truthy" : "falsy" }'`
      );
      expect(result.stdout).toBe("truthy\n");
      expect(result.exitCode).toBe(0);
    });

    it("should treat non-zero number as true", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { print -5 ? "truthy" : "falsy" }'`
      );
      expect(result.stdout).toBe("truthy\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ternary with async expressions", () => {
    it("should await getline in consequent branch", async () => {
      const env = new Bash({
        files: { "/data.txt": "hello world\n" }
      });
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 1 ? (getline line < "/data.txt") : 0; print line }'`
      );
      expect(result.stdout).toBe("hello world\n");
      expect(result.exitCode).toBe(0);
    });

    it("should await getline in alternate branch", async () => {
      const env = new Bash({
        files: { "/data.txt": "test data\n" }
      });
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 0 ? 0 : (getline line < "/data.txt"); print line }'`
      );
      expect(result.stdout).toBe("test data\n");
      expect(result.exitCode).toBe(0);
    });

    it("should await nested ternary with getline", async () => {
      const env = new Bash({
        files: {
          "/data1.txt": "first\n",
          "/data2.txt": "second\n"
        }
      });
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 1 ? (getline a < "/data1.txt") : (getline b < "/data2.txt"); print a }'`
      );
      expect(result.stdout).toBe("first\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
