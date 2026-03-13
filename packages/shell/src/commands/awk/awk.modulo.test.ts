import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk modulo operator", () => {
  describe("basic modulo", () => {
    it("should compute modulo with %", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 17 % 5 }'`);
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should compute modulo of exact division", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 10 % 2 }'`);
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle modulo with floating point", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 5.5 % 2 }'`);
      expect(result.stdout).toBe("1.5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle zero dividend", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 0 % 5 }'`);
      expect(result.stdout).toBe("0\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("modulo assignment", () => {
    it("should compute modulo with %=", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { x = 17; x %= 5; print x }'`
      );
      expect(result.stdout).toBe("2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with variables", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { a = 25; b = 7; a %= b; print a }'`
      );
      expect(result.stdout).toBe("4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with array elements", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { arr[1] = 100; arr[1] %= 30; print arr[1] }'`
      );
      expect(result.stdout).toBe("10\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("modulo in conditions", () => {
    it("should check even numbers", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n4\n5\n6\n" }
      });
      const result = await env.exec(`awk '$1 % 2 == 0 { print }' /data.txt`);
      expect(result.stdout).toBe("2\n4\n6\n");
      expect(result.exitCode).toBe(0);
    });

    it("should check odd numbers", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n4\n5\n6\n" }
      });
      const result = await env.exec(`awk '$1 % 2 == 1 { print }' /data.txt`);
      expect(result.stdout).toBe("1\n3\n5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should check every Nth line", async () => {
      const env = new Bash({
        files: { "/data.txt": "a\nb\nc\nd\ne\nf\n" }
      });
      const result = await env.exec(`awk 'NR % 3 == 0 { print }' /data.txt`);
      expect(result.stdout).toBe("c\nf\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("modulo in loops", () => {
    it("should use modulo in for loop", async () => {
      const env = new Bash();
      const result = await env.exec(
        `echo "" | awk 'BEGIN { for(i=1; i<=10; i++) if(i%3==0) print i }'`
      );
      expect(result.stdout).toBe("3\n6\n9\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("modulo with negative numbers", () => {
    it("should handle negative dividend", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print -7 % 3 }'`);
      // Note: AWK behavior with negative numbers may vary
      expect(result.stdout).toBe("-1\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle negative divisor", async () => {
      const env = new Bash();
      const result = await env.exec(`echo "" | awk 'BEGIN { print 7 % -3 }'`);
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
