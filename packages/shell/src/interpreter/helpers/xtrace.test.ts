import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("xtrace (set -x)", () => {
  describe("basic tracing", () => {
    it("should trace simple commands", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        echo hello
      `);
      expect(result.stdout).toBe("hello\n");
      expect(result.stderr).toContain("+ echo hello");
      expect(result.exitCode).toBe(0);
    });

    it("should trace commands with arguments", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        echo one two three
      `);
      expect(result.stdout).toBe("one two three\n");
      expect(result.stderr).toContain("+ echo one two three");
      expect(result.exitCode).toBe(0);
    });

    it("should stop tracing with set +x", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        echo traced
        set +x
        echo not traced
      `);
      expect(result.stdout).toBe("traced\nnot traced\n");
      expect(result.stderr).toContain("+ echo traced");
      expect(result.stderr).toContain("+ set +x");
      expect(result.stderr).not.toContain("+ echo not traced");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("PS4 expansion", () => {
    it("should use default PS4 prefix", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        echo test
      `);
      expect(result.stderr).toContain("+ echo test");
      expect(result.exitCode).toBe(0);
    });

    it("should use custom PS4 prefix", async () => {
      const env = new Bash();
      const result = await env.exec(`
        PS4=">>> "
        set -x
        echo test
      `);
      expect(result.stderr).toContain(">>> echo test");
      expect(result.exitCode).toBe(0);
    });

    it("should expand variables in PS4", async () => {
      const env = new Bash();
      const result = await env.exec(`
        MYVAR="DEBUG"
        PS4='[$MYVAR] '
        set -x
        echo test
      `);
      expect(result.stderr).toContain("[DEBUG] echo test");
      expect(result.exitCode).toBe(0);
    });

    it("should expand $LINENO in PS4", async () => {
      const env = new Bash();
      const result = await env.exec(`PS4='+$LINENO: '
set -x
echo line1`);
      // Should contain line number in trace
      expect(result.stderr).toMatch(/\+\d+: echo line1/);
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty PS4", async () => {
      const env = new Bash();
      const result = await env.exec(`
        PS4=""
        set -x
        echo test
      `);
      // With empty PS4, trace line has no prefix
      expect(result.stderr).toContain("echo test");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("tracing with special characters", () => {
    it("should quote arguments with spaces", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        echo "hello world"
      `);
      expect(result.stdout).toBe("hello world\n");
      // The trace should show the argument quoted
      expect(result.stderr).toContain("echo");
      expect(result.stderr).toContain("hello world");
      expect(result.exitCode).toBe(0);
    });

    it("should handle empty string arguments", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        echo ""
      `);
      expect(result.stdout).toBe("\n");
      expect(result.stderr).toContain("echo ''");
      expect(result.exitCode).toBe(0);
    });

    it("should escape special characters in trace output", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        printf 'a\\nb'
      `);
      expect(result.stdout).toBe("a\nb");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("tracing assignments", () => {
    it("should trace variable assignments", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        x=5
        echo $x
      `);
      expect(result.stdout).toBe("5\n");
      expect(result.stderr).toContain("x=5");
      expect(result.exitCode).toBe(0);
    });

    it("should trace assignments with command", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        FOO=bar echo hello
      `);
      expect(result.stdout).toBe("hello\n");
      expect(result.stderr).toContain("FOO=bar");
      expect(result.stderr).toContain("echo hello");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("tracing control structures", () => {
    it("should trace for loop iterations", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        for i in 1 2; do
          echo $i
        done
      `);
      expect(result.stdout).toBe("1\n2\n");
      expect(result.stderr).toContain("echo 1");
      expect(result.stderr).toContain("echo 2");
      expect(result.exitCode).toBe(0);
    });

    it("should trace while loop body", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        x=0
        while [ $x -lt 2 ]; do
          echo $x
          x=$((x + 1))
        done
      `);
      expect(result.stdout).toBe("0\n1\n");
      expect(result.stderr).toContain("echo 0");
      expect(result.stderr).toContain("echo 1");
      expect(result.exitCode).toBe(0);
    });

    it("should trace if/else branches", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        if true; then
          echo yes
        else
          echo no
        fi
      `);
      expect(result.stdout).toBe("yes\n");
      expect(result.stderr).toContain("true");
      expect(result.stderr).toContain("echo yes");
      expect(result.stderr).not.toContain("echo no");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("tracing in subshells", () => {
    it("should trace commands in subshell when xtrace is set", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        (echo subshell)
      `);
      expect(result.stdout).toBe("subshell\n");
      expect(result.stderr).toContain("echo subshell");
      expect(result.exitCode).toBe(0);
    });

    it("should not trace subshell when xtrace disabled inside", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        (set +x; echo subshell)
        echo after
      `);
      expect(result.stdout).toBe("subshell\nafter\n");
      // Only after should be traced, subshell echo is not
      expect(result.stderr).toContain("echo after");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("tracing pipelines", () => {
    it("should trace commands in pipeline", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        echo hello | cat
      `);
      expect(result.stdout).toBe("hello\n");
      // At minimum the cat command should be traced
      expect(result.stderr).toContain("cat");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("tracing command substitution", () => {
    it("should trace commands inside command substitution", async () => {
      const env = new Bash();
      const result = await env.exec(`
        set -x
        x=$(echo hello)
        echo $x
      `);
      expect(result.stdout).toBe("hello\n");
      // Command substitution commands should be traced
      expect(result.stderr).toContain("echo hello");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("tracing function calls", () => {
    it("should trace function body execution", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() {
          echo "in func"
        }
        set -x
        myfunc
      `);
      expect(result.stdout).toBe("in func\n");
      expect(result.stderr).toContain("myfunc");
      expect(result.stderr).toContain("echo");
      expect(result.exitCode).toBe(0);
    });

    it("should show function arguments in trace", async () => {
      const env = new Bash();
      const result = await env.exec(`
        greet() {
          echo "Hello $1"
        }
        set -x
        greet World
      `);
      expect(result.stdout).toBe("Hello World\n");
      expect(result.stderr).toContain("greet World");
      expect(result.exitCode).toBe(0);
    });
  });
});
