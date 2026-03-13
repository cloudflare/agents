import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Bash Syntax - Operators", () => {
  describe("logical AND (&&)", () => {
    it("should execute second command when first succeeds", async () => {
      const env = new Bash();
      const result = await env.exec("echo first && echo second");
      expect(result.stdout).toBe("first\nsecond\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not execute second command when first fails", async () => {
      const env = new Bash();
      const result = await env.exec("cat /nonexistent && echo second");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    });

    it("should chain multiple && operators", async () => {
      const env = new Bash();
      const result = await env.exec("echo a && echo b && echo c && echo d");
      expect(result.stdout).toBe("a\nb\nc\nd\n");
      expect(result.exitCode).toBe(0);
    });

    it("should stop chain at first failure", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo a && cat /missing && echo b && echo c"
      );
      expect(result.stdout).toBe("a\n");
      expect(result.exitCode).toBe(1);
    });

    it("should work with commands that modify filesystem", async () => {
      const env = new Bash();
      await env.exec("mkdir /test && echo created > /test/file.txt");
      const content = await env.readFile("/test/file.txt");
      expect(content).toBe("created\n");
    });

    it("should not modify filesystem when first command fails", async () => {
      const env = new Bash({
        files: { "/important.txt": "keep this" }
      });
      await env.exec("cat /missing && rm /important.txt");
      const content = await env.readFile("/important.txt");
      expect(content).toBe("keep this");
    });

    it("should handle && with exit codes from pipes", async () => {
      const env = new Bash();
      const result = await env.exec("echo test | grep missing && echo found");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    });

    it("should handle && after successful grep", async () => {
      const env = new Bash();
      const result = await env.exec("echo test | grep test && echo found");
      expect(result.stdout).toBe("test\nfound\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("logical OR (||)", () => {
    it("should execute second command when first fails", async () => {
      const env = new Bash();
      const result = await env.exec("cat /nonexistent || echo fallback");
      expect(result.stdout).toBe("fallback\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not execute second command when first succeeds", async () => {
      const env = new Bash();
      const result = await env.exec("echo success || echo fallback");
      expect(result.stdout).toBe("success\n");
      expect(result.exitCode).toBe(0);
    });

    it("should chain multiple || operators", async () => {
      const env = new Bash();
      const result = await env.exec(
        "cat /a || cat /b || cat /c || echo fallback"
      );
      expect(result.stdout).toBe("fallback\n");
      expect(result.exitCode).toBe(0);
    });

    it("should stop at first success in || chain", async () => {
      const env = new Bash({
        files: { "/exists.txt": "found" }
      });
      const result = await env.exec(
        "cat /missing || cat /exists.txt || echo fallback"
      );
      expect(result.stdout).toBe("found");
      expect(result.exitCode).toBe(0);
    });

    it("should return non-zero if all commands fail", async () => {
      const env = new Bash();
      const result = await env.exec("cat /a || cat /b || cat /c");
      expect(result.exitCode).toBe(1);
    });

    it("should work as error handler pattern", async () => {
      const env = new Bash();
      const result = await env.exec('mkdir /dir || echo "dir already exists"');
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
      // Second call should trigger the || branch
      const result2 = await env.exec('mkdir /dir || echo "dir already exists"');
      expect(result2.stdout).toBe("dir already exists\n");
    });

    it("should handle || with grep no match", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo test | grep missing || echo "not found"'
      );
      expect(result.stdout).toBe("not found\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("semicolon (;) sequential execution", () => {
    it("should execute both commands regardless of first result", async () => {
      const env = new Bash();
      const result = await env.exec("echo first ; echo second");
      expect(result.stdout).toBe("first\nsecond\n");
    });

    it("should execute second even when first fails", async () => {
      const env = new Bash();
      const result = await env.exec("cat /missing ; echo second");
      expect(result.stdout).toBe("second\n");
    });

    it("should chain multiple ; operators", async () => {
      const env = new Bash();
      const result = await env.exec("echo a ; echo b ; echo c");
      expect(result.stdout).toBe("a\nb\nc\n");
    });

    it("should preserve exit code from last command", async () => {
      const env = new Bash();
      const result = await env.exec("echo first ; cat /missing");
      expect(result.stdout).toBe("first\n");
      expect(result.exitCode).toBe(1);
    });

    it("should return success if last command succeeds", async () => {
      const env = new Bash();
      const result = await env.exec("cat /missing ; echo success");
      expect(result.stdout).toBe("success\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle ; without spaces", async () => {
      const env = new Bash();
      const result = await env.exec("echo a;echo b;echo c");
      expect(result.stdout).toBe("a\nb\nc\n");
    });
  });

  describe("mixed operators", () => {
    it("should handle && followed by ||", async () => {
      const env = new Bash();
      const result = await env.exec(
        "cat /missing && echo success || echo failure"
      );
      expect(result.stdout).toBe("failure\n");
    });

    it("should handle || followed by &&", async () => {
      const env = new Bash();
      const result = await env.exec(
        "cat /missing || echo recovered && echo continued"
      );
      expect(result.stdout).toBe("recovered\ncontinued\n");
    });

    it("should handle success && success || fallback", async () => {
      const env = new Bash();
      const result = await env.exec("echo a && echo b || echo c");
      expect(result.stdout).toBe("a\nb\n");
    });

    it("should handle ; with &&", async () => {
      const env = new Bash();
      const result = await env.exec("echo a ; echo b && echo c");
      expect(result.stdout).toBe("a\nb\nc\n");
    });

    it("should handle ; with ||", async () => {
      const env = new Bash();
      const result = await env.exec(
        "cat /missing ; cat /missing2 || echo fallback"
      );
      expect(result.stdout).toBe("fallback\n");
    });

    it("should handle complex chain: fail && x || recover ; continue", async () => {
      const env = new Bash();
      const result = await env.exec(
        "cat /missing && echo success || echo recovered ; echo done"
      );
      expect(result.stdout).toBe("recovered\ndone\n");
    });

    it("should handle complex chain: success && next || x ; continue", async () => {
      const env = new Bash();
      const result = await env.exec(
        "echo ok && echo next || echo skip ; echo done"
      );
      expect(result.stdout).toBe("ok\nnext\ndone\n");
    });
  });

  describe("pipes (|)", () => {
    it("should pipe stdout to stdin", async () => {
      const env = new Bash();
      const result = await env.exec("echo hello | cat");
      expect(result.stdout).toBe("hello\n");
    });

    it("should chain multiple pipes", async () => {
      const env = new Bash();
      const result = await env.exec("echo hello | cat | cat | cat");
      expect(result.stdout).toBe("hello\n");
    });

    it("should filter with grep in pipe", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "foo\\nbar\\nbaz" | grep ba');
      expect(result.stdout).toBe("bar\nbaz\n");
    });

    it("should count lines with wc in pipe", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "a\\nb\\nc" | wc -l');
      expect(result.stdout.trim()).toBe("3");
    });

    it("should get first n lines with head in pipe", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "1\\n2\\n3\\n4\\n5" | head -n 2');
      expect(result.stdout).toBe("1\n2\n");
    });

    it("should get last n lines with tail in pipe", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "1\\n2\\n3\\n4\\n5" | tail -n 2');
      expect(result.stdout).toBe("4\n5\n");
    });

    it("should combine head and tail in pipe", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo -e "1\\n2\\n3\\n4\\n5" | head -n 4 | tail -n 2'
      );
      expect(result.stdout).toBe("3\n4\n");
    });

    it("should pipe file contents through multiple filters", async () => {
      const env = new Bash({
        files: { "/data.txt": "apple\nbanana\napricot\nblueberry\navocado\n" }
      });
      const result = await env.exec("cat /data.txt | grep a | head -n 3");
      expect(result.stdout).toBe("apple\nbanana\napricot\n");
    });

    it("should not confuse || with pipe", async () => {
      const env = new Bash();
      const result = await env.exec("cat /missing || echo fallback");
      expect(result.stdout).toBe("fallback\n");
    });

    it("should handle pipe with && after", async () => {
      const env = new Bash();
      const result = await env.exec("echo test | grep test && echo found");
      expect(result.stdout).toBe("test\nfound\n");
    });

    it("should handle pipe with || after (no match case)", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo test | grep missing || echo "not found"'
      );
      expect(result.stdout).toBe("not found\n");
    });
  });

  describe("output redirection (> and >>)", () => {
    it("should redirect stdout to new file with >", async () => {
      const env = new Bash();
      await env.exec("echo hello > /output.txt");
      expect(await env.readFile("/output.txt")).toBe("hello\n");
    });

    it("should overwrite existing file with >", async () => {
      const env = new Bash({
        files: { "/output.txt": "old\n" }
      });
      await env.exec("echo new > /output.txt");
      expect(await env.readFile("/output.txt")).toBe("new\n");
    });

    it("should append to file with >>", async () => {
      const env = new Bash({
        files: { "/output.txt": "line1\n" }
      });
      await env.exec("echo line2 >> /output.txt");
      expect(await env.readFile("/output.txt")).toBe("line1\nline2\n");
    });

    it("should create file when appending to nonexistent", async () => {
      const env = new Bash();
      await env.exec("echo first >> /new.txt");
      expect(await env.readFile("/new.txt")).toBe("first\n");
    });

    it("should redirect command output", async () => {
      const env = new Bash({
        files: { "/input.txt": "content\n" }
      });
      await env.exec("cat /input.txt > /output.txt");
      expect(await env.readFile("/output.txt")).toBe("content\n");
    });

    it("should redirect pipe output", async () => {
      const env = new Bash();
      await env.exec('echo -e "a\\nb\\nc" | grep b > /output.txt');
      expect(await env.readFile("/output.txt")).toBe("b\n");
    });

    it("should handle multiple appends", async () => {
      const env = new Bash();
      await env.exec("echo a >> /log.txt");
      await env.exec("echo b >> /log.txt");
      await env.exec("echo c >> /log.txt");
      expect(await env.readFile("/log.txt")).toBe("a\nb\nc\n");
    });

    it("should handle > without spaces", async () => {
      const env = new Bash();
      await env.exec("echo test>/output.txt");
      expect(await env.readFile("/output.txt")).toBe("test\n");
    });

    it("should handle >> without spaces", async () => {
      const env = new Bash({
        files: { "/output.txt": "a\n" }
      });
      await env.exec("echo b>>/output.txt");
      expect(await env.readFile("/output.txt")).toBe("a\nb\n");
    });
  });
});
