import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("seq", () => {
  describe("basic sequences", () => {
    it("should print numbers from 1 to N", async () => {
      const env = new Bash();
      const result = await env.exec("seq 5");
      expect(result.stdout).toBe("1\n2\n3\n4\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should print numbers from FIRST to LAST", async () => {
      const env = new Bash();
      const result = await env.exec("seq 3 7");
      expect(result.stdout).toBe("3\n4\n5\n6\n7\n");
      expect(result.exitCode).toBe(0);
    });

    it("should print numbers with INCREMENT", async () => {
      const env = new Bash();
      const result = await env.exec("seq 1 2 10");
      expect(result.stdout).toBe("1\n3\n5\n7\n9\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle single number 1", async () => {
      const env = new Bash();
      const result = await env.exec("seq 1");
      expect(result.stdout).toBe("1\n");
    });

    it("should handle start greater than end (empty output)", async () => {
      const env = new Bash();
      const result = await env.exec("seq 5 1");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("negative numbers and decrements", () => {
    it("should handle negative increment (decrementing)", async () => {
      const env = new Bash();
      const result = await env.exec("seq 5 -1 1");
      expect(result.stdout).toBe("5\n4\n3\n2\n1\n");
    });

    it("should handle negative start", async () => {
      const env = new Bash();
      const result = await env.exec("seq -3 3");
      expect(result.stdout).toBe("-3\n-2\n-1\n0\n1\n2\n3\n");
    });

    it("should handle negative end", async () => {
      const env = new Bash();
      const result = await env.exec("seq 2 -1 -2");
      expect(result.stdout).toBe("2\n1\n0\n-1\n-2\n");
    });

    it("should handle all negative range", async () => {
      const env = new Bash();
      const result = await env.exec("seq -5 -1 -10");
      expect(result.stdout).toBe("-5\n-6\n-7\n-8\n-9\n-10\n");
    });
  });

  describe("floating point numbers", () => {
    it("should handle floating point increment", async () => {
      const env = new Bash();
      const result = await env.exec("seq 1 0.5 3");
      expect(result.stdout).toBe("1.0\n1.5\n2.0\n2.5\n3.0\n");
    });

    it("should handle floating point start and end", async () => {
      const env = new Bash();
      const result = await env.exec("seq 1.5 3.5");
      expect(result.stdout).toBe("1.5\n2.5\n3.5\n");
    });
  });

  describe("separator option", () => {
    it("should use custom separator with -s", async () => {
      const env = new Bash();
      const result = await env.exec("seq -s ' ' 5");
      expect(result.stdout).toBe("1 2 3 4 5\n");
    });

    it("should use comma separator", async () => {
      const env = new Bash();
      const result = await env.exec("seq -s ',' 3");
      expect(result.stdout).toBe("1,2,3\n");
    });

    it("should handle empty separator", async () => {
      const env = new Bash();
      const result = await env.exec("seq -s '' 3");
      expect(result.stdout).toBe("123\n");
    });
  });

  describe("width option", () => {
    it("should pad with zeros using -w", async () => {
      const env = new Bash();
      const result = await env.exec("seq -w 8 12");
      expect(result.stdout).toBe("08\n09\n10\n11\n12\n");
    });

    it("should pad larger range", async () => {
      const env = new Bash();
      const result = await env.exec("seq -w 1 100");
      const lines = result.stdout.trim().split("\n");
      expect(lines[0]).toBe("001");
      expect(lines[9]).toBe("010");
      expect(lines[99]).toBe("100");
    });
  });

  describe("error cases", () => {
    it("should error on missing operand", async () => {
      const env = new Bash();
      const result = await env.exec("seq");
      expect(result.stderr).toContain("missing operand");
      expect(result.exitCode).toBe(1);
    });

    it("should error on invalid number", async () => {
      const env = new Bash();
      const result = await env.exec("seq abc");
      expect(result.stderr).toContain("invalid");
      expect(result.exitCode).toBe(1);
    });

    it("should error on zero increment", async () => {
      const env = new Bash();
      const result = await env.exec("seq 1 0 5");
      expect(result.stderr).toContain("Zero increment");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("use in pipelines", () => {
    it("should work with while read", async () => {
      const env = new Bash();
      const result = await env.exec(`
        seq 3 | while read n; do
          echo "line $n"
        done
      `);
      expect(result.stdout).toBe("line 1\nline 2\nline 3\n");
    });

    it("should work with head", async () => {
      const env = new Bash();
      const result = await env.exec("seq 10 | head -3");
      expect(result.stdout).toBe("1\n2\n3\n");
    });

    it("should work with tail", async () => {
      const env = new Bash();
      const result = await env.exec("seq 10 | tail -3");
      expect(result.stdout).toBe("8\n9\n10\n");
    });

    it("should work with wc -l", async () => {
      const env = new Bash();
      const result = await env.exec("seq 5 | wc -l");
      expect(result.stdout.trim()).toBe("5");
    });
  });
});
