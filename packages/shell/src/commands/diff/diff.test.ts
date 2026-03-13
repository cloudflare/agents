import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("diff", () => {
  describe("basic comparison", () => {
    it("should return 0 for identical files", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "line1\nline2\nline3\n",
          "/b.txt": "line1\nline2\nline3\n"
        }
      });
      const result = await env.exec("diff /a.txt /b.txt");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should return 1 for different files", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "line1\n",
          "/b.txt": "line2\n"
        }
      });
      const result = await env.exec("diff /a.txt /b.txt");
      expect(result.exitCode).toBe(1);
    });

    it("should show unified diff output by default", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "hello\n",
          "/b.txt": "world\n"
        }
      });
      const result = await env.exec("diff /a.txt /b.txt");
      expect(result.stdout).toContain("---");
      expect(result.stdout).toContain("+++");
      expect(result.stdout).toContain("-hello");
      expect(result.stdout).toContain("+world");
      expect(result.exitCode).toBe(1);
    });

    it("should show added lines", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "line1\n",
          "/b.txt": "line1\nline2\n"
        }
      });
      const result = await env.exec("diff /a.txt /b.txt");
      expect(result.stdout).toContain("+line2");
      expect(result.exitCode).toBe(1);
    });

    it("should show removed lines", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "line1\nline2\n",
          "/b.txt": "line1\n"
        }
      });
      const result = await env.exec("diff /a.txt /b.txt");
      expect(result.stdout).toContain("-line2");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("brief mode (-q)", () => {
    it("should report files differ with -q", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "aaa\n",
          "/b.txt": "bbb\n"
        }
      });
      const result = await env.exec("diff -q /a.txt /b.txt");
      expect(result.stdout).toBe("Files /a.txt and /b.txt differ\n");
      expect(result.exitCode).toBe(1);
    });

    it("should output nothing for identical files with -q", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "same\n",
          "/b.txt": "same\n"
        }
      });
      const result = await env.exec("diff -q /a.txt /b.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should work with --brief", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "aaa\n",
          "/b.txt": "bbb\n"
        }
      });
      const result = await env.exec("diff --brief /a.txt /b.txt");
      expect(result.stdout).toBe("Files /a.txt and /b.txt differ\n");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("report identical (-s)", () => {
    it("should report when files are identical with -s", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "same\n",
          "/b.txt": "same\n"
        }
      });
      const result = await env.exec("diff -s /a.txt /b.txt");
      expect(result.stdout).toBe("Files /a.txt and /b.txt are identical\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with --report-identical-files", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "same\n",
          "/b.txt": "same\n"
        }
      });
      const result = await env.exec(
        "diff --report-identical-files /a.txt /b.txt"
      );
      expect(result.stdout).toBe("Files /a.txt and /b.txt are identical\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("ignore case (-i)", () => {
    it("should ignore case differences with -i", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "Hello World\n",
          "/b.txt": "hello world\n"
        }
      });
      const result = await env.exec("diff -i /a.txt /b.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should show diff without -i for case differences", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "Hello\n",
          "/b.txt": "hello\n"
        }
      });
      const result = await env.exec("diff /a.txt /b.txt");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("stdin support", () => {
    it("should read first file from stdin with -", async () => {
      const env = new Bash({
        files: {
          "/b.txt": "from file\n"
        }
      });
      const result = await env.exec('echo "from stdin" | diff - /b.txt');
      expect(result.stdout).toContain("-from stdin");
      expect(result.stdout).toContain("+from file");
      expect(result.exitCode).toBe(1);
    });

    it("should read second file from stdin with -", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "from file\n"
        }
      });
      const result = await env.exec('echo "from stdin" | diff /a.txt -');
      expect(result.stdout).toContain("-from file");
      expect(result.stdout).toContain("+from stdin");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("error handling", () => {
    it("should error on missing file", async () => {
      const env = new Bash({
        files: { "/exists.txt": "content\n" }
      });
      const result = await env.exec("diff /missing.txt /exists.txt");
      expect(result.stderr).toBe(
        "diff: /missing.txt: No such file or directory\n"
      );
      expect(result.exitCode).toBe(2);
    });

    it("should error on missing second file", async () => {
      const env = new Bash({
        files: { "/exists.txt": "content\n" }
      });
      const result = await env.exec("diff /exists.txt /missing.txt");
      expect(result.stderr).toBe(
        "diff: /missing.txt: No such file or directory\n"
      );
      expect(result.exitCode).toBe(2);
    });

    it("should error with missing operand", async () => {
      const env = new Bash();
      const result = await env.exec("diff /a.txt");
      expect(result.stderr).toContain("missing operand");
      expect(result.exitCode).toBe(2);
    });

    it("should error on unknown option", async () => {
      const env = new Bash();
      const result = await env.exec("diff --unknown /a.txt /b.txt");
      expect(result.stderr).toContain("unrecognized option");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown short option", async () => {
      const env = new Bash();
      const result = await env.exec("diff -z /a.txt /b.txt");
      expect(result.stderr).toContain("invalid option");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("help", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("diff --help");
      expect(result.stdout).toContain("diff");
      expect(result.stdout).toContain("compare");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("multiline diffs", () => {
    it("should handle multiple changed lines", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "line1\nline2\nline3\n",
          "/b.txt": "line1\nmodified\nline3\n"
        }
      });
      const result = await env.exec("diff /a.txt /b.txt");
      expect(result.stdout).toContain("-line2");
      expect(result.stdout).toContain("+modified");
      expect(result.exitCode).toBe(1);
    });

    it("should show context around changes", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "1\n2\n3\n4\n5\n",
          "/b.txt": "1\n2\nX\n4\n5\n"
        }
      });
      const result = await env.exec("diff /a.txt /b.txt");
      expect(result.stdout).toContain("@@");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("empty files", () => {
    it("should handle empty vs non-empty", async () => {
      const env = new Bash({
        files: {
          "/empty.txt": "",
          "/content.txt": "has content\n"
        }
      });
      const result = await env.exec("diff /empty.txt /content.txt");
      expect(result.stdout).toContain("+has content");
      expect(result.exitCode).toBe(1);
    });

    it("should handle both empty files", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "",
          "/b.txt": ""
        }
      });
      const result = await env.exec("diff /a.txt /b.txt");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });
});
