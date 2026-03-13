import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Bash Syntax - Variables and Quoting", () => {
  describe("environment variable expansion", () => {
    it("should expand $VAR", async () => {
      const env = new Bash({ env: { NAME: "world" } });
      const result = await env.exec("echo hello $NAME");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should expand ${VAR}", async () => {
      const env = new Bash({ env: { NAME: "world" } });
      const result = await env.exec("echo hello ${NAME}");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should expand ${VAR} adjacent to text", async () => {
      const env = new Bash({ env: { PREFIX: "pre" } });
      const result = await env.exec("echo ${PREFIX}fix");
      expect(result.stdout).toBe("prefix\n");
    });

    it("should expand multiple variables", async () => {
      const env = new Bash({ env: { A: "hello", B: "world" } });
      const result = await env.exec("echo $A $B");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should handle unset variable as empty", async () => {
      const env = new Bash();
      const result = await env.exec('echo "[$UNSET]"');
      expect(result.stdout).toBe("[]\n");
    });

    it("should handle ${VAR:-default} with unset variable", async () => {
      const env = new Bash();
      const result = await env.exec("echo ${MISSING:-default}");
      expect(result.stdout).toBe("default\n");
    });

    it("should handle ${VAR:-default} with set variable", async () => {
      const env = new Bash({ env: { SET: "value" } });
      const result = await env.exec("echo ${SET:-default}");
      expect(result.stdout).toBe("value\n");
    });

    it("should expand in double quotes", async () => {
      const env = new Bash({ env: { VAR: "value" } });
      const result = await env.exec('echo "the $VAR is here"');
      expect(result.stdout).toBe("the value is here\n");
    });

    it("should not expand in single quotes", async () => {
      const env = new Bash({ env: { VAR: "value" } });
      const result = await env.exec("echo 'the $VAR is here'");
      expect(result.stdout).toBe("the $VAR is here\n");
    });

    it("should expand in file paths", async () => {
      const env = new Bash({
        files: { "/home/user/file.txt": "content" },
        env: { HOME: "/home/user" }
      });
      const result = await env.exec("cat $HOME/file.txt");
      expect(result.stdout).toBe("content");
    });

    it("should handle export command (within same exec)", async () => {
      const env = new Bash();
      const result = await env.exec("export FOO=bar; echo $FOO");
      expect(result.stdout).toBe("bar\n");
    });

    it("should handle export with multiple assignments (within same exec)", async () => {
      const env = new Bash();
      const result = await env.exec("export A=1 B=2 C=3; echo $A $B $C");
      expect(result.stdout).toBe("1 2 3\n");
    });

    it("should handle unset command (within same exec)", async () => {
      const env = new Bash({ env: { FOO: "bar" } });
      const result = await env.exec('unset FOO; echo "[$FOO]"');
      expect(result.stdout).toBe("[]\n");
    });
  });

  describe("quoting", () => {
    it("should preserve spaces in double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo "hello   world"');
      expect(result.stdout).toBe("hello   world\n");
    });

    it("should preserve spaces in single quotes", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'hello   world'");
      expect(result.stdout).toBe("hello   world\n");
    });

    it("should handle single quote inside double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo "it\'s working"');
      expect(result.stdout).toBe("it's working\n");
    });

    it("should handle escaped double quote inside double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('echo "say \\"hello\\""');
      expect(result.stdout).toBe('say "hello"\n');
    });

    it("should handle empty string argument", async () => {
      const env = new Bash();
      const result = await env.exec('echo ""');
      expect(result.stdout).toBe("\n");
    });

    it("should handle adjacent quoted strings", async () => {
      const env = new Bash();
      const result = await env.exec("echo \"hello\"'world'");
      expect(result.stdout).toBe("helloworld\n");
    });

    it("should preserve special chars in single quotes", async () => {
      const env = new Bash();
      const result = await env.exec("echo 'hello $VAR && test'");
      expect(result.stdout).toBe("hello $VAR && test\n");
    });

    it("should handle newline in quoted string with $", async () => {
      const env = new Bash();
      const result = await env.exec('echo "line1\nline2"');
      expect(result.stdout).toBe("line1\nline2\n");
    });
  });

  describe("escape sequences", () => {
    it("should handle \\n with echo -e", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "hello\\nworld"');
      expect(result.stdout).toBe("hello\nworld\n");
    });

    it("should handle \\t with echo -e", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "col1\\tcol2"');
      expect(result.stdout).toBe("col1\tcol2\n");
    });

    it("should handle multiple escape sequences", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "a\\nb\\nc\\nd"');
      expect(result.stdout).toBe("a\nb\nc\nd\n");
    });

    it("should handle \\\\ for literal backslash", async () => {
      const env = new Bash();
      // In bash: echo -e "path\\\\to\\\\file" outputs path\to\file
      // Because \\\\ in double quotes -> \\ after quote processing -> \ after echo -e
      const result = await env.exec('echo -e "path\\\\\\\\to\\\\\\\\file"');
      expect(result.stdout).toBe("path\\to\\file\n");
    });

    it("should not interpret escapes without -e", async () => {
      const env = new Bash();
      const result = await env.exec('echo "hello\\nworld"');
      expect(result.stdout).toBe("hello\\nworld\n");
    });
  });

  describe("exit command", () => {
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
  });

  describe("unknown commands", () => {
    it("should return 127 for unknown command", async () => {
      const env = new Bash();
      const result = await env.exec("unknowncommand");
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("command not found");
    });

    it("should include command name in error", async () => {
      const env = new Bash();
      const result = await env.exec("foobar");
      expect(result.stderr).toContain("foobar");
    });
  });

  describe("whitespace handling", () => {
    it("should handle empty command", async () => {
      const env = new Bash();
      const result = await env.exec("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("should handle whitespace-only command", async () => {
      const env = new Bash();
      const result = await env.exec("   ");
      expect(result.exitCode).toBe(0);
    });

    it("should trim leading/trailing whitespace", async () => {
      const env = new Bash();
      const result = await env.exec("   echo hello   ");
      expect(result.stdout).toBe("hello\n");
    });

    it("should collapse multiple spaces between args", async () => {
      const env = new Bash();
      const result = await env.exec("echo   hello   world");
      expect(result.stdout).toBe("hello world\n");
    });

    it("should handle tabs", async () => {
      const env = new Bash();
      const result = await env.exec("echo\thello\tworld");
      expect(result.stdout).toBe("hello world\n");
    });
  });

  describe("variable assignments", () => {
    it("should assign value with double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('MYVAR="hello"; echo $MYVAR');
      expect(result.stdout).toBe("hello\n");
    });

    it("should assign value with single quotes", async () => {
      const env = new Bash();
      const result = await env.exec("MYVAR='hello'; echo $MYVAR");
      expect(result.stdout).toBe("hello\n");
    });

    it("should assign empty string with double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('MYVAR=""; echo "value:$MYVAR:"');
      expect(result.stdout).toBe("value::\n");
      expect(result.stderr).toBe("");
    });

    it("should assign empty string with single quotes", async () => {
      const env = new Bash();
      const result = await env.exec("MYVAR=''; echo \"value:$MYVAR:\"");
      expect(result.stdout).toBe("value::\n");
      expect(result.stderr).toBe("");
    });

    it("should assign empty string without quotes", async () => {
      const env = new Bash();
      const result = await env.exec('MYVAR=; echo "value:$MYVAR:"');
      expect(result.stdout).toBe("value::\n");
    });

    it("should handle value with spaces in double quotes", async () => {
      const env = new Bash();
      const result = await env.exec('MYVAR="hello world"; echo "$MYVAR"');
      expect(result.stdout).toBe("hello world\n");
    });

    it("should handle export with empty double-quoted value", async () => {
      const env = new Bash();
      const result = await env.exec('export MYVAR=""; echo "value:$MYVAR:"');
      expect(result.stdout).toBe("value::\n");
      expect(result.stderr).toBe("");
    });
  });
});
