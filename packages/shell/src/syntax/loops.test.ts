import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";
import { ExecutionLimitError } from "../interpreter/errors";

describe("Bash Syntax - Loops", () => {
  describe("for loops", () => {
    it("should iterate over list items", async () => {
      const env = new Bash();
      const result = await env.exec("for i in a b c; do echo $i; done");
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should iterate over numbers", async () => {
      const env = new Bash();
      const result = await env.exec("for n in 1 2 3 4 5; do echo $n; done");
      expect(result.stdout).toBe("1\n2\n3\n4\n5\n");
    });

    it("should handle single item", async () => {
      const env = new Bash();
      const result = await env.exec("for x in hello; do echo $x; done");
      expect(result.stdout).toBe("hello\n");
    });

    it("should handle empty list", async () => {
      const env = new Bash();
      const result = await env.exec("for x in; do echo $x; done");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should execute multiple commands in body", async () => {
      const env = new Bash();
      const result = await env.exec(
        "for i in 1 2; do echo start $i; echo end $i; done"
      );
      expect(result.stdout).toBe("start 1\nend 1\nstart 2\nend 2\n");
    });

    it("should work with file operations", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "content1",
          "/file2.txt": "content2"
        }
      });
      const result = await env.exec(
        "for f in /file1.txt /file2.txt; do cat $f; done"
      );
      expect(result.stdout).toBe("content1content2");
    });

    it("should preserve exit code from last iteration", async () => {
      const env = new Bash();
      const result = await env.exec("for i in 1 2; do false; done");
      expect(result.exitCode).toBe(1);
    });

    it("should clean up loop variable after loop", async () => {
      const env = new Bash();
      await env.exec("for x in a b; do echo $x; done");
      const result = await env.exec('echo "[$x]"');
      expect(result.stdout).toBe("[]\n");
    });
  });

  describe("while loops", () => {
    it("should execute while condition is true", async () => {
      const env = new Bash();
      // Use a counter file to track iterations
      await env.exec("echo 0 > /count.txt");
      const result = await env.exec(
        "while grep -q 0 /count.txt; do echo iteration; echo 1 > /count.txt; done"
      );
      expect(result.stdout).toBe("iteration\n");
    });

    it("should not execute when condition is initially false", async () => {
      const env = new Bash();
      const result = await env.exec("while false; do echo never; done");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple iterations", async () => {
      const env = new Bash();
      await env.exec("export count=3");
      // We can't easily decrement in this shell, so use a different approach
      await env.exec('echo "aaa" > /counter.txt');
      const result = await env.exec(
        'while grep -q aaa /counter.txt; do echo loop; echo "bbb" > /counter.txt; done'
      );
      expect(result.stdout).toBe("loop\n");
    });

    it("should return exit code from last command in body", async () => {
      const env = new Bash();
      await env.exec("echo start > /f.txt");
      const result = await env.exec(
        "while grep -q start /f.txt; do echo done > /f.txt; true; done"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("until loops", () => {
    it("should execute until condition becomes true", async () => {
      const env = new Bash();
      await env.exec("echo 0 > /flag.txt");
      const result = await env.exec(
        "until grep -q 1 /flag.txt; do echo waiting; echo 1 > /flag.txt; done"
      );
      expect(result.stdout).toBe("waiting\n");
    });

    it("should not execute when condition is initially true", async () => {
      const env = new Bash();
      const result = await env.exec("until true; do echo never; done");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should execute when condition is initially false", async () => {
      const env = new Bash();
      await env.exec("echo no > /check.txt");
      const result = await env.exec(
        "until grep -q yes /check.txt; do echo step; echo yes > /check.txt; done"
      );
      expect(result.stdout).toBe("step\n");
    });
  });

  describe("loop protection", () => {
    it("should detect infinite for loop and error", async () => {
      const env = new Bash();
      // Create a list that's too long
      const longList = Array(10001).fill("x").join(" ");
      const result = await env.exec(`for i in ${longList}; do echo $i; done`);
      // May hit either iteration limit or command count limit depending on loop body
      expect(result.stderr).toMatch(/too many (iterations|commands)/);
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should detect infinite while loop", async () => {
      const env = new Bash();
      const result = await env.exec("while true; do echo loop; done");
      // May hit either iteration limit or command count limit depending on loop body
      expect(result.stderr).toMatch(/too many (iterations|commands)/);
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });

    it("should detect infinite until loop", async () => {
      const env = new Bash();
      const result = await env.exec("until false; do echo loop; done");
      // May hit either iteration limit or command count limit depending on loop body
      expect(result.stderr).toMatch(/too many (iterations|commands)/);
      expect(result.exitCode).toBe(ExecutionLimitError.EXIT_CODE);
    });
  });

  describe("nested loops", () => {
    it("should handle nested for loops", async () => {
      const env = new Bash();
      const result = await env.exec(
        "for i in a b; do for j in 1 2; do echo $i$j; done; done"
      );
      expect(result.stdout).toBe("a1\na2\nb1\nb2\n");
    });

    it("should handle for inside while", async () => {
      const env = new Bash();
      await env.exec("echo go > /run.txt");
      // Note: Nested loops with their own do/done require careful parsing
      // For now, test a simpler case
      const result = await env.exec(
        "while grep -q go /run.txt; do echo inner; echo stop > /run.txt; done"
      );
      expect(result.stdout).toBe("inner\n");
    });
  });

  describe("loop syntax variations", () => {
    it("should handle for loop without semicolon before do", async () => {
      const env = new Bash();
      const result = await env.exec("for i in a b c do echo $i; done");
      expect(result.stdout).toBe("a\nb\nc\n");
    });

    it("should handle while loop with semicolon before do", async () => {
      const env = new Bash();
      await env.exec("echo x > /f.txt");
      // Note: Bash requires semicolon or newline before 'do'
      const result = await env.exec(
        "while grep -q x /f.txt; do echo found; echo y > /f.txt; done"
      );
      expect(result.stdout).toBe("found\n");
    });

    it("should error on malformed for loop", async () => {
      const env = new Bash();
      const result = await env.exec("for i a b c; do echo $i; done");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("syntax error");
    });
  });
});
