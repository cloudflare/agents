import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("eval builtin", () => {
  describe("basic evaluation", () => {
    it("should execute a simple command", async () => {
      const env = new Bash();
      const result = await env.exec('eval "echo hello"');
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should execute multiple words as single command", async () => {
      const env = new Bash();
      const result = await env.exec("eval echo hello world");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should return 0 for empty argument", async () => {
      const env = new Bash();
      const result = await env.exec('eval ""');
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should return 0 for no arguments", async () => {
      const env = new Bash();
      const result = await env.exec("eval");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("variable expansion", () => {
    it("should expand variables before execution", async () => {
      const env = new Bash();
      const result = await env.exec(`
        cmd="echo hello"
        eval $cmd
      `);
      expect(result.stdout).toBe("hello\n");
    });

    it("should allow dynamic variable names", async () => {
      const env = new Bash();
      const result = await env.exec(`
        name="FOO"
        FOO="bar"
        eval "echo \\$$name"
      `);
      expect(result.stdout).toBe("bar\n");
    });

    it("should allow setting variables dynamically", async () => {
      const env = new Bash();
      const result = await env.exec(`
        name="MYVAR"
        eval "$name=hello"
        echo $MYVAR
      `);
      expect(result.stdout).toBe("hello\n");
    });
  });

  describe("command construction", () => {
    it("should handle command from array-like variables", async () => {
      const env = new Bash();
      const result = await env.exec(`
        args="a b c"
        eval "for x in $args; do echo item: \\$x; done"
      `);
      expect(result.stdout).toBe("item: a\nitem: b\nitem: c\n");
    });

    it("should execute piped commands", async () => {
      const env = new Bash();
      const result = await env.exec('eval "echo hello | tr a-z A-Z"');
      expect(result.stdout).toBe("HELLO\n");
    });

    it("should handle command substitution", async () => {
      const env = new Bash();
      const result = await env.exec('eval "echo $(echo nested)"');
      expect(result.stdout).toBe("nested\n");
    });
  });

  describe("exit codes", () => {
    it("should return exit code of executed command", async () => {
      const env = new Bash();
      const result = await env.exec("eval false");
      expect(result.exitCode).toBe(1);
    });

    it("should return exit code of last command", async () => {
      const env = new Bash();
      const result = await env.exec('eval "true; false; true"');
      expect(result.exitCode).toBe(0);
    });

    it("should return 1 for syntax errors", async () => {
      const env = new Bash();
      // Use "for do done" which is a syntax error (missing variable name)
      // Bash returns exit code 1 for eval syntax errors
      const result = await env.exec('eval "for do done"');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Parse error");
    });
  });

  describe("scope and environment", () => {
    it("should execute in current environment", async () => {
      const env = new Bash();
      const result = await env.exec(`
        FOO=original
        eval "FOO=modified"
        echo $FOO
      `);
      expect(result.stdout).toBe("modified\n");
    });

    it("should have access to functions", async () => {
      const env = new Bash();
      const result = await env.exec(`
        myfunc() { echo "called"; }
        eval "myfunc"
      `);
      expect(result.stdout).toBe("called\n");
    });

    it("should define functions that persist", async () => {
      const env = new Bash();
      const result = await env.exec(`
        eval 'greet() { echo "hello $1"; }'
        greet world
      `);
      expect(result.stdout).toBe("hello world\n");
    });
  });

  describe("quoting and escaping", () => {
    it("should handle single quotes", async () => {
      const env = new Bash();
      const result = await env.exec(`eval "echo 'single quoted'"`);
      expect(result.stdout).toBe("single quoted\n");
    });

    it("should handle double quotes", async () => {
      const env = new Bash();
      const result = await env.exec(`eval 'echo "double quoted"'`);
      expect(result.stdout).toBe("double quoted\n");
    });

    it("should handle escaped characters", async () => {
      const env = new Bash();
      const result = await env.exec('eval "echo hello\\\\nworld"');
      // The \\n should be interpreted as literal backslash-n
      expect(result.stdout).toContain("hello");
    });
  });
});
