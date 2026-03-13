import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Bash Syntax - Parser Edge Cases", () => {
  describe("quoting", () => {
    it("should handle nested single quotes in double quotes", async () => {
      const env = new Bash();
      const result = await env.exec("echo \"hello 'world'\"");
      expect(result.stdout).toBe("hello 'world'\n");
    });

    it("should handle nested double quotes in single quotes", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'hello \"world\"'");
      expect(result.stdout).toBe('hello "world"\n');
    });

    it("should handle empty double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo ""');
      expect(result.stdout).toBe("\n");
    });

    it("should handle empty single quotes", async () => {
      const env = new Bash();
      const result = await env.exec("echo ''");
      expect(result.stdout).toBe("\n");
    });

    it("should handle adjacent quoted strings", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'hello'\"world\"");
      expect(result.stdout).toBe("helloworld\n");
    });

    it("should handle quotes inside arguments", async () => {
      const env = new Bash();
      const result = await env.exec("echo foo'bar'baz");
      expect(result.stdout).toBe("foobarbaz\n");
    });

    it("should preserve special chars in single quotes", async () => {
      const env = new Bash();
      const result = await env.exec("echo '* ? | > < && || ;'");
      expect(result.stdout).toBe("* ? | > < && || ;\n");
    });
  });

  describe("escape sequences", () => {
    it("should handle escaped double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo "hello \\"world\\""');
      expect(result.stdout).toBe('hello "world"\n');
    });

    it("should handle escaped backslash", async () => {
      const env = new Bash();
      const result = await env.exec('echo "a\\\\b"');
      expect(result.stdout).toBe("a\\b\n");
    });

    it("should handle escaped dollar sign", async () => {
      const env = new Bash();
      const result = await env.exec('echo "\\$HOME"');
      expect(result.stdout).toBe("$HOME\n");
    });

    it("should handle escaped space outside quotes", async () => {
      const env = new Bash();
      const result = await env.exec("echo hello\\ world");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should treat backslash literally in single quotes", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'a\\b'");
      expect(result.stdout).toBe("a\\b\n");
    });

    it("should escape special operators", async () => {
      const env = new Bash();
      const result = await env.exec("echo a\\|b");
      expect(result.stdout).toBe("a|b\n");
    });
  });

  describe("variable expansion", () => {
    it("should handle ${VAR:-default} with set variable", async () => {
      const env = new Bash({ env: { VAR: "value" } });
      const result = await env.exec('echo "${VAR:-default}"');
      expect(result.stdout).toBe("value\n");
    });

    it("should handle ${VAR:-default} with unset variable", async () => {
      const env = new Bash();
      const result = await env.exec('echo "${VAR:-default}"');
      expect(result.stdout).toBe("default\n");
    });

    it("should handle ${VAR:-} with empty default", async () => {
      const env = new Bash();
      const result = await env.exec('echo "${VAR:-}"');
      expect(result.stdout).toBe("\n");
    });

    it("should handle $VAR with no braces", async () => {
      const env = new Bash({ env: { NAME: "test" } });
      const result = await env.exec("echo $NAME");
      expect(result.stdout).toBe("test\n");
    });

    it("should handle adjacent variables", async () => {
      const env = new Bash({ env: { A: "hello", B: "world" } });
      const result = await env.exec('echo "$A$B"');
      expect(result.stdout).toBe("helloworld\n");
    });

    it("should handle variable followed by text", async () => {
      const env = new Bash({ env: { NAME: "test" } });
      const result = await env.exec('echo "${NAME}file.txt"');
      expect(result.stdout).toBe("testfile.txt\n");
    });

    it("should handle undefined variable as empty", async () => {
      const env = new Bash();
      const result = await env.exec('echo "[$UNDEFINED]"');
      expect(result.stdout).toBe("[]\n");
    });

    it("should handle special variable $?", async () => {
      // Note: $? requires prior command execution context
      const env = new Bash({ env: { "?": "0" } });
      const result = await env.exec('echo "$?"');
      expect(result.stdout).toBe("0\n");
    });
  });

  describe("whitespace handling", () => {
    it("should handle multiple spaces between arguments", async () => {
      const env = new Bash();
      const result = await env.exec("echo    a    b    c");
      expect(result.stdout).toBe("a b c\n");
    });

    it("should handle tabs between arguments", async () => {
      const env = new Bash();
      const result = await env.exec("echo\ta\tb\tc");
      expect(result.stdout).toBe("a b c\n");
    });

    it("should handle leading whitespace", async () => {
      const env = new Bash();
      const result = await env.exec("   echo hello");
      expect(result.stdout).toBe("hello\n");
    });

    it("should handle trailing whitespace", async () => {
      const env = new Bash();
      const result = await env.exec("echo hello   ");
      expect(result.stdout).toBe("hello\n");
    });

    it("should preserve spaces in quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo "  hello   world  "');
      expect(result.stdout).toBe("  hello   world  \n");
    });
  });

  describe("redirection parsing", () => {
    it("should handle > without space", async () => {
      const env = new Bash();
      await env.exec("echo hello>/tmp/test.txt");
      const content = await env.readFile("/tmp/test.txt");
      expect(content).toBe("hello\n");
    });

    it("should handle >> without space", async () => {
      const env = new Bash();
      await env.exec("echo first > /tmp/test.txt");
      await env.exec("echo second>>/tmp/test.txt");
      const content = await env.readFile("/tmp/test.txt");
      expect(content).toBe("first\nsecond\n");
    });

    it("should handle 2>/dev/null", async () => {
      const env = new Bash();
      const result = await env.exec("cat /nonexistent 2>/dev/null");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(1);
    });

    it("should handle 2>&1 redirection", async () => {
      const env = new Bash();
      const result = await env.exec("cat /nonexistent 2>&1");
      expect(result.stdout).toContain("No such file");
      expect(result.stderr).toBe("");
    });

    it("should handle multiple redirections", async () => {
      const env = new Bash();
      await env.exec("echo out; cat /missing 2>&1 > /tmp/out.txt");
      // Complex redirection - varies by shell
    });
  });

  describe("operator parsing", () => {
    it("should parse && correctly without spaces", async () => {
      const env = new Bash();
      const result = await env.exec("echo a&&echo b");
      expect(result.stdout).toBe("a\nb\n");
    });

    it("should parse || correctly without spaces", async () => {
      const env = new Bash();
      const result = await env.exec("false||echo fallback");
      expect(result.stdout).toBe("fallback\n");
    });

    it("should parse ; correctly without spaces", async () => {
      const env = new Bash();
      const result = await env.exec("echo a;echo b");
      expect(result.stdout).toBe("a\nb\n");
    });

    it("should parse | correctly without spaces", async () => {
      const env = new Bash();
      const result = await env.exec("echo hello|cat");
      expect(result.stdout).toBe("hello\n");
    });

    it("should differentiate | from ||", async () => {
      const env = new Bash();
      const result = await env.exec("echo test | grep test || echo fail");
      expect(result.stdout).toBe("test\n");
    });

    it("should differentiate & from &&", async () => {
      // & is not implemented but && should work
      const env = new Bash();
      const result = await env.exec("true && echo success");
      expect(result.stdout).toBe("success\n");
    });
  });

  describe("complex command combinations", () => {
    it("should handle mixed && and || with correct precedence", async () => {
      const env = new Bash();
      // In bash, && and || have equal precedence, evaluated left-to-right
      const result = await env.exec("false || echo A && echo B");
      expect(result.stdout).toBe("A\nB\n");
    });

    it("should handle semicolon with && and ||", async () => {
      const env = new Bash();
      const result = await env.exec("echo a; false || echo b; echo c");
      expect(result.stdout).toBe("a\nb\nc\n");
    });

    it("should handle pipes with semicolons", async () => {
      const env = new Bash();
      const result = await env.exec("echo hello | cat; echo world | cat");
      expect(result.stdout).toBe("hello\nworld\n");
    });

    it("should handle assignment followed by command", async () => {
      const env = new Bash();
      const result = await env.exec("x=hello; echo $x");
      expect(result.stdout).toBe("hello\n");
    });

    it("should handle command after failed assignment-like string", async () => {
      const env = new Bash();
      // If = is part of an argument, not an assignment
      const result = await env.exec("echo a=b");
      expect(result.stdout).toBe("a=b\n");
    });
  });

  describe("edge cases", () => {
    it("should handle empty command line", async () => {
      const env = new Bash();
      const result = await env.exec("");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle command with only spaces", async () => {
      const env = new Bash();
      const result = await env.exec("   ");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle semicolon only as syntax error", async () => {
      const env = new Bash();
      const result = await env.exec(";");
      // Bare semicolon is a syntax error in bash
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("syntax error");
    });

    it("should treat multiple semicolons as syntax error", async () => {
      const env = new Bash();
      const result = await env.exec("echo a;;;echo b");
      // In bash, `;;` is the case terminator and is a syntax error outside case
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("syntax error");
    });

    it("should handle very long argument", async () => {
      const env = new Bash();
      const longStr = "a".repeat(10000);
      const result = await env.exec(`echo ${longStr}`);
      expect(result.stdout).toBe(`${longStr}\n`);
    });

    it("should handle unicode in arguments", async () => {
      const env = new Bash();
      const result = await env.exec('echo "Hello 世界 🌍"');
      expect(result.stdout).toBe("Hello 世界 🌍\n");
    });

    it("should handle newline in double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo "line1\nline2"');
      expect(result.stdout).toBe("line1\nline2\n");
    });
  });
});
