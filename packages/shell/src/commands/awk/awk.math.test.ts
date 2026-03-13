import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk math functions", () => {
  describe("basic math functions", () => {
    it("int() truncates to integer", async () => {
      const env = new Bash();
      const result = await env.exec("echo '3.7' | awk '{ print int($1) }'");
      expect(result.stdout).toBe("3\n");
    });

    it("int() handles negative numbers", async () => {
      const env = new Bash();
      const result = await env.exec("echo '-3.7' | awk '{ print int($1) }'");
      expect(result.stdout).toBe("-4\n");
    });

    it("sqrt() calculates square root", async () => {
      const env = new Bash();
      const result = await env.exec("echo '16' | awk '{ print sqrt($1) }'");
      expect(result.stdout).toBe("4\n");
    });

    it("exp() calculates e^x", async () => {
      const env = new Bash();
      const result = await env.exec("echo '0' | awk '{ print exp($1) }'");
      expect(result.stdout).toBe("1\n");
    });

    it("log() calculates natural logarithm", async () => {
      const env = new Bash();
      const result = await env.exec("echo '1' | awk '{ print log($1) }'");
      expect(result.stdout).toBe("0\n");
    });
  });

  describe("trigonometric functions", () => {
    it("sin(0) returns 0", async () => {
      const env = new Bash();
      const result = await env.exec("echo '0' | awk '{ print sin($1) }'");
      expect(result.stdout).toBe("0\n");
    });

    it("cos(0) returns 1", async () => {
      const env = new Bash();
      const result = await env.exec("echo '0' | awk '{ print cos($1) }'");
      expect(result.stdout).toBe("1\n");
    });

    it("atan2(1, 1) returns pi/4", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '1 1' | awk '{ print atan2($1, $2) }'"
      );
      const value = parseFloat(result.stdout.trim());
      expect(value).toBeCloseTo(Math.PI / 4, 5);
    });

    it("atan2(0, 1) returns 0", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '0 1' | awk '{ print atan2($1, $2) }'"
      );
      expect(result.stdout).toBe("0\n");
    });
  });

  describe("random functions", () => {
    it("rand() returns a value between 0 and 1", async () => {
      const env = new Bash();
      const result = await env.exec("echo '' | awk '{ print rand() }'");
      const value = parseFloat(result.stdout.trim());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    });

    it("srand() can be called with a seed", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '' | awk '{ srand(42); print rand() }'"
      );
      const value = parseFloat(result.stdout.trim());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    });
  });

  describe("combined calculations", () => {
    it("calculates hypotenuse using sqrt", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo '3 4' | awk '{ print sqrt($1*$1 + $2*$2) }'"
      );
      expect(result.stdout).toBe("5\n");
    });

    it("calculates distance using atan2", async () => {
      const env = new Bash();
      // atan2(1, 0) = pi/2
      const result = await env.exec(
        "echo '1 0' | awk '{ print atan2($1, $2) }'"
      );
      const value = parseFloat(result.stdout.trim());
      expect(value).toBeCloseTo(Math.PI / 2, 5);
    });
  });
});
