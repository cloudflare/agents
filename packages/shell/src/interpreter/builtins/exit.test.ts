import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("exit builtin", () => {
  describe("basic exit", () => {
    it("should exit with code 0 by default", async () => {
      const env = new Bash();
      const result = await env.exec("exit");
      expect(result.exitCode).toBe(0);
    });

    it("should exit with specified code", async () => {
      const env = new Bash();
      const result = await env.exec("exit 42");
      expect(result.exitCode).toBe(42);
    });

    it("should exit with code 1", async () => {
      const env = new Bash();
      const result = await env.exec("exit 1");
      expect(result.exitCode).toBe(1);
    });

    it("should stop execution after exit", async () => {
      const env = new Bash();
      const result = await env.exec(`
        echo before
        exit 0
        echo after
      `);
      expect(result.stdout).toBe("before\n");
      expect(result.stdout).not.toContain("after");
    });
  });

  describe("exit code modulo 256", () => {
    it("should wrap exit code 256 to 0", async () => {
      const env = new Bash();
      const result = await env.exec("exit 256");
      expect(result.exitCode).toBe(0);
    });

    it("should wrap exit code 257 to 1", async () => {
      const env = new Bash();
      const result = await env.exec("exit 257");
      expect(result.exitCode).toBe(1);
    });

    it("should handle negative exit codes", async () => {
      const env = new Bash();
      const result = await env.exec("exit -1");
      expect(result.exitCode).toBe(255);
    });
  });

  describe("exit in different contexts", () => {
    it("should exit from function", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          echo "in func"
          exit 5
          echo "never"
        }
        myfunc
        echo "also never"
      `);
      expect(result.stdout).toBe("in func\n");
      expect(result.exitCode).toBe(5);
    });

    it("should exit from loop", async () => {
      const env = new Bash();
      const result = await env.exec(`
        for i in 1 2 3; do
          echo $i
          exit 10
        done
        echo "never"
      `);
      expect(result.stdout).toBe("1\n");
      expect(result.exitCode).toBe(10);
    });

    it("should exit from if block", async () => {
      const env = new Bash();
      const result = await env.exec(`
        if true; then
          echo "in if"
          exit 7
          echo "never"
        fi
        echo "also never"
      `);
      expect(result.stdout).toBe("in if\n");
      expect(result.exitCode).toBe(7);
    });
  });

  describe("exit uses last exit code", () => {
    it("should use last command exit code when no argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        false
        exit
      `);
      expect(result.exitCode).toBe(1);
    });

    it("should use success code after true", async () => {
      const env = new Bash();
      const result = await env.exec(`
        true
        exit
      `);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("exit error handling", () => {
    it("should handle non-numeric argument", async () => {
      const env = new Bash();
      const result = await env.exec("exit abc");
      expect(result.stderr).toContain("numeric argument required");
      expect(result.exitCode).toBe(2);
    });
  });
});
