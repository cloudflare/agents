import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Bash Syntax - source and . builtins", () => {
  describe("source builtin", () => {
    it("should execute commands from file in current environment", async () => {
      const env = new Bash();
      await env.exec('echo "x=123" > /tmp/test.sh');
      const result = await env.exec(`
        source /tmp/test.sh
        echo "x is: $x"
      `);
      expect(result.stdout).toBe("x is: 123\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support functions from sourced file", async () => {
      const env = new Bash();
      await env.exec('echo "greet() { echo Hello \\$1; }" > /tmp/funcs.sh');
      const result = await env.exec(`
        source /tmp/funcs.sh
        greet World
      `);
      expect(result.stdout).toBe("Hello World\n");
      expect(result.exitCode).toBe(0);
    });

    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("source /nonexistent/file.sh");
      expect(result.stderr).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });

    it("should error with no arguments", async () => {
      const env = new Bash();
      const result = await env.exec("source");
      expect(result.stderr).toContain("filename argument required");
      expect(result.exitCode).toBe(2);
    });
  });

  describe(". (dot) builtin", () => {
    it("should work same as source", async () => {
      const env = new Bash();
      await env.exec('echo "y=456" > /tmp/test2.sh');
      const result = await env.exec(`
        . /tmp/test2.sh
        echo "y is: $y"
      `);
      expect(result.stdout).toBe("y is: 456\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("sourced script with arguments", () => {
    it("should pass arguments to sourced script", async () => {
      const env = new Bash();
      await env.exec('echo "echo args: \\$1 \\$2 \\$#" > /tmp/args.sh');
      const result = await env.exec("source /tmp/args.sh foo bar");
      expect(result.stdout).toBe("args: foo bar 2\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
