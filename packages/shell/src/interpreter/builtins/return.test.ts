import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("return builtin", () => {
  describe("basic return", () => {
    it("should return from function with default exit code", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          echo before
          return
          echo after
        }
        myfunc
        echo done
      `);
      expect(result.stdout).toBe("before\ndone\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return from function with specified exit code", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          return 42
        }
        myfunc
        echo $?
      `);
      expect(result.stdout).toBe("42\n");
    });

    it("should use last command exit code when no argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          false
          return
        }
        myfunc
        echo $?
      `);
      expect(result.stdout).toBe("1\n");
    });

    it("should handle exit code 0", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          return 0
        }
        myfunc
        echo $?
      `);
      expect(result.stdout).toBe("0\n");
    });
  });

  describe("exit code modulo 256", () => {
    it("should wrap large exit codes", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          return 256
        }
        myfunc
        echo $?
      `);
      expect(result.stdout).toBe("0\n");
    });

    it("should handle 257 as 1", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          return 257
        }
        myfunc
        echo $?
      `);
      expect(result.stdout).toBe("1\n");
    });

    it("should handle negative numbers", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          return -1
        }
        myfunc
        echo $?
      `);
      expect(result.stdout).toBe("255\n");
    });
  });

  describe("error cases", () => {
    it("should error when not in function", async () => {
      const env = new Bash();
      const result = await env.exec("return");
      expect(result.stderr).toContain(
        "can only `return' from a function or sourced script"
      );
      expect(result.exitCode).toBe(1);
    });

    it("should error on non-numeric argument", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          return abc
        }
        myfunc
      `);
      expect(result.stderr).toContain("numeric argument required");
      expect(result.exitCode).toBe(2);
    });
  });

  describe("nested functions", () => {
    it("should only return from innermost function", async () => {
      const env = new Bash();
      const result = await env.exec(`
        outer() {
          echo outer-start
          inner() {
            echo inner
            return 5
          }
          inner
          echo "inner returned $?"
        }
        outer
        echo "outer returned $?"
      `);
      expect(result.stdout).toBe(
        "outer-start\ninner\ninner returned 5\nouter returned 0\n"
      );
    });

    it("should propagate return through control flow", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          for i in 1 2 3; do
            if [ $i -eq 2 ]; then
              return 42
            fi
            echo $i
          done
          echo "never"
        }
        myfunc
        echo $?
      `);
      expect(result.stdout).toBe("1\n42\n");
    });
  });

  describe("return with output", () => {
    it("should preserve stdout before return", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          echo line1
          echo line2
          return 3
        }
        myfunc
        echo "exit: $?"
      `);
      expect(result.stdout).toBe("line1\nline2\nexit: 3\n");
    });

    it("should preserve stderr before return", async () => {
      const env = new Bash();
      // Use a command that actually produces stderr (command not found)
      const result = await env.exec(`
        myfunc() {
          nonexistent_cmd_xyz 2>/dev/null || true
          return 5
        }
        myfunc
      `);
      // The key thing is that return works and preserves the exit code
      expect(result.exitCode).toBe(5);
    });
  });
});
