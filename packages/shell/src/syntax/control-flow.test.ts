import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Bash Syntax - Control Flow", () => {
  describe("if statements", () => {
    it("should execute then branch when condition is true", async () => {
      const env = new Bash();
      const result = await env.exec("if true; then echo yes; fi");
      expect(result.stdout).toBe("yes\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not execute then branch when condition is false", async () => {
      const env = new Bash();
      const result = await env.exec("if false; then echo yes; fi");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should execute else branch when condition is false", async () => {
      const env = new Bash();
      const result = await env.exec(
        "if false; then echo yes; else echo no; fi"
      );
      expect(result.stdout).toBe("no\n");
      expect(result.exitCode).toBe(0);
    });

    it("should use command exit code as condition", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world" }
      });
      const result = await env.exec(
        "if grep hello /test.txt > /dev/null; then echo found; fi"
      );
      expect(result.stdout).toBe("found\n");
    });

    it("should handle elif branches", async () => {
      const env = new Bash();
      const result = await env.exec(
        "if false; then echo one; elif true; then echo two; else echo three; fi"
      );
      expect(result.stdout).toBe("two\n");
    });

    it("should handle multiple elif branches", async () => {
      const env = new Bash();
      const result = await env.exec(
        "if false; then echo 1; elif false; then echo 2; elif true; then echo 3; else echo 4; fi"
      );
      expect(result.stdout).toBe("3\n");
    });

    it("should handle commands with pipes in condition", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello\nworld\n" }
      });
      const result = await env.exec(
        "if cat /test.txt | grep world > /dev/null; then echo found; fi"
      );
      expect(result.stdout).toBe("found\n");
    });

    it("should handle multiple commands in body", async () => {
      const env = new Bash();
      const result = await env.exec(
        "if true; then echo one; echo two; echo three; fi"
      );
      expect(result.stdout).toBe("one\ntwo\nthree\n");
    });

    it("should return exit code of last command in body", async () => {
      const env = new Bash();
      const result = await env.exec("if true; then echo hello; false; fi");
      expect(result.stdout).toBe("hello\n");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unclosed if", async () => {
      const env = new Bash();
      const result = await env.exec("if true; then echo hello");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("syntax error");
    });

    it("should handle nested if statements", async () => {
      const env = new Bash();
      const result = await env.exec(
        "if true; then if true; then echo nested; fi; fi"
      );
      expect(result.stdout).toBe("nested\n");
    });

    it("should handle triple nested if statements", async () => {
      const env = new Bash();
      const result = await env.exec(
        "if true; then if true; then if true; then echo deep; fi; fi; fi"
      );
      expect(result.stdout).toBe("deep\n");
    });

    it("should handle if inside function body", async () => {
      const env = new Bash();
      // Define and call function in same exec (each exec is a new shell)
      const result = await env.exec(
        "check() { if true; then echo inside; fi; }; check"
      );
      expect(result.stdout).toBe("inside\n");
    });

    it("should handle if with nested else", async () => {
      const env = new Bash();
      const result = await env.exec(
        "if false; then echo one; else if true; then echo two; fi; fi"
      );
      expect(result.stdout).toBe("two\n");
    });

    it("should handle if after semicolon", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo before; if true; then echo during; fi; echo after"
      );
      expect(result.stdout).toBe("before\nduring\nafter\n");
    });
  });

  describe("functions", () => {
    // Note: Each exec is a new shell, so functions must be defined and called within the same exec

    it("should define and call a function using function keyword", async () => {
      const env = new Bash();
      const result = await env.exec("function greet { echo hello; }; greet");
      expect(result.stdout).toBe("hello\n");
    });

    it("should define and call a function using () syntax", async () => {
      const env = new Bash();
      const result = await env.exec("greet() { echo hello; }; greet");
      expect(result.stdout).toBe("hello\n");
    });

    it("should pass arguments to function as $1, $2, etc.", async () => {
      const env = new Bash();
      const result = await env.exec("greet() { echo Hello $1; }; greet World");
      expect(result.stdout).toBe("Hello World\n");
    });

    it("should support $# for argument count", async () => {
      const env = new Bash();
      const result = await env.exec("count() { echo $#; }; count a b c");
      expect(result.stdout).toBe("3\n");
    });

    it("should support $@ for all arguments", async () => {
      const env = new Bash();
      const result = await env.exec("show() { echo $@; }; show one two three");
      expect(result.stdout).toBe("one two three\n");
    });

    it("should handle functions with multiple commands", async () => {
      const env = new Bash();
      const result = await env.exec(
        "multi() { echo first; echo second; echo third; }; multi"
      );
      expect(result.stdout).toBe("first\nsecond\nthird\n");
    });

    it("should allow function to call other functions", async () => {
      const env = new Bash();
      const result = await env.exec(
        "inner() { echo inside; }; outer() { echo before; inner; echo after; }; outer"
      );
      expect(result.stdout).toBe("before\ninside\nafter\n");
    });

    it("should return exit code from last command", async () => {
      const env = new Bash();
      const result = await env.exec("fail() { echo hi; false; }; fail");
      expect(result.stdout).toBe("hi\n");
      expect(result.exitCode).toBe(1);
    });

    it("should override built-in commands", async () => {
      const env = new Bash();
      // Define echo function then call it
      const result = await env.exec("echo() { true; }; echo hello");
      expect(result.stdout).toBe("");
    });

    it("should work with files", async () => {
      const env = new Bash({
        files: { "/data.txt": "line1\nline2\nline3\n" }
      });
      const result = await env.exec(
        "countlines() { cat $1 | wc -l; }; countlines /data.txt"
      );
      expect(result.stdout.trim()).toBe("3");
    });

    it("function definitions do not persist across exec calls", async () => {
      const env = new Bash();
      await env.exec("greet() { echo hello; }");
      // Each exec is a new shell - function is not defined
      const result = await env.exec("greet");
      expect(result.exitCode).toBe(127); // command not found
    });
  });

  describe("local keyword", () => {
    // Note: Each exec is a new shell, so functions must be defined and called within the same exec

    it("should declare local variable with value", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test_func() { local x=hello; echo $x; }; test_func"
      );
      expect(result.stdout).toBe("hello\n");
    });

    it("should not affect outer scope", async () => {
      const env = new Bash({ env: { x: "outer" } });
      const result = await env.exec(
        "test_func() { local x=inner; echo $x; }; test_func; echo $x"
      );
      expect(result.stdout).toBe("inner\nouter\n");
    });

    it("should shadow outer variable", async () => {
      const env = new Bash({ env: { x: "outer" } });
      const result = await env.exec(
        "test_func() { local x=inner; echo $x; }; test_func"
      );
      expect(result.stdout).toBe("inner\n");
    });

    it("should restore undefined variable after function", async () => {
      const env = new Bash();
      const result = await env.exec(
        'test_func() { local newvar=value; echo $newvar; }; test_func; echo "[$newvar]"'
      );
      expect(result.stdout).toBe("value\n[]\n");
    });

    it("should error when used outside function", async () => {
      const env = new Bash();
      const result = await env.exec("local x=value");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("can only be used in a function");
    });

    it("should handle multiple local declarations", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test_func() { local a=1 b=2 c=3; echo $a $b $c; }; test_func"
      );
      expect(result.stdout).toBe("1 2 3\n");
    });

    it("should declare local without value", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test_func() { local x; x=assigned; echo $x; }; test_func"
      );
      expect(result.stdout).toBe("assigned\n");
    });

    it("should work with nested function calls", async () => {
      const env = new Bash();
      const result = await env.exec(
        "inner() { local x=inner; echo $x; }; outer() { local x=outer; inner; echo $x; }; outer"
      );
      expect(result.stdout).toBe("inner\nouter\n");
    });

    it("should keep local changes within same scope", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test_func() { local x=first; x=second; echo $x; }; test_func"
      );
      expect(result.stdout).toBe("second\n");
    });
  });

  describe("! negation operator", () => {
    it("should negate exit code of true to 1", async () => {
      const env = new Bash();
      const result = await env.exec("! true");
      expect(result.exitCode).toBe(1);
    });

    it("should negate exit code of false to 0", async () => {
      const env = new Bash();
      const result = await env.exec("! false");
      expect(result.exitCode).toBe(0);
    });

    it("should work with && chaining", async () => {
      const env = new Bash();
      const result = await env.exec("! false && echo success");
      expect(result.stdout).toBe("success\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with || chaining", async () => {
      const env = new Bash();
      const result = await env.exec("! true || echo fallback");
      expect(result.stdout).toBe("fallback\n");
      expect(result.exitCode).toBe(0);
    });

    it("should negate grep failure to success", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world" }
      });
      const result = await env.exec("! grep missing /test.txt");
      expect(result.exitCode).toBe(0);
    });

    it("should negate grep success to failure", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world" }
      });
      const result = await env.exec("! grep hello /test.txt > /dev/null");
      expect(result.exitCode).toBe(1);
    });

    it("should work in if condition", async () => {
      const env = new Bash();
      const result = await env.exec("if ! false; then echo yes; fi");
      expect(result.stdout).toBe("yes\n");
    });

    it("should work with find -not equivalent", async () => {
      const env = new Bash({
        files: {
          "/project/src/app.ts": "code",
          "/project/src/utils.ts": "utils",
          "/project/test.json": "{}"
        }
      });
      // Use -not with find (since shell ! passes to find)
      const result = await env.exec(
        'find /project -name "*.ts" -not -name "utils*"'
      );
      expect(result.stdout).toContain("app.ts");
      expect(result.stdout).not.toContain("utils.ts");
    });
  });
});
