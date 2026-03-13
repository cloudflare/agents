import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("find -exec", () => {
  describe("-exec command {} ;", () => {
    it("should execute command for each found file", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "content a",
          "/dir/b.txt": "content b"
        }
      });
      const result = await env.exec('find /dir -name "*.txt" -exec cat {} \\;');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("content acontent b");
      expect(result.stderr).toBe("");
    });

    it("should execute echo for each file", async () => {
      const env = new Bash({
        files: {
          "/dir/file1.txt": "",
          "/dir/file2.txt": ""
        }
      });
      const result = await env.exec(
        'find /dir -name "*.txt" -exec echo Found: {} \\;'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "Found: /dir/file1.txt\nFound: /dir/file2.txt\n"
      );
      expect(result.stderr).toBe("");
    });

    it("should handle multiple {} replacements", async () => {
      const env = new Bash({
        files: { "/dir/test.txt": "" }
      });
      const result = await env.exec(
        'find /dir -name "test.txt" -exec echo {} is {} \\;'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("/dir/test.txt is /dir/test.txt\n");
      expect(result.stderr).toBe("");
    });

    it("should propagate command exit codes", async () => {
      const env = new Bash({
        files: { "/dir/file.txt": "" }
      });
      const result = await env.exec(
        'find /dir -name "file.txt" -exec cat /nonexistent \\;'
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("No such file");
    });
  });

  describe("-exec command {} +", () => {
    it("should execute command once with all files", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "",
          "/dir/b.txt": "",
          "/dir/c.txt": ""
        }
      });
      const result = await env.exec('find /dir -name "*.txt" -exec echo {} +');
      expect(result.exitCode).toBe(0);
      // All files should be in a single echo output
      expect(result.stdout).toBe("/dir/a.txt /dir/b.txt /dir/c.txt\n");
      expect(result.stderr).toBe("");
    });

    it("should work with ls command in batch mode", async () => {
      const env = new Bash({
        files: {
          "/dir/file1.txt": "content1",
          "/dir/file2.txt": "content2"
        }
      });
      const result = await env.exec("find /dir -type f -exec ls {} +");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("/dir/file1.txt\n\n/dir/file2.txt\n");
      expect(result.stderr).toBe("");
    });
  });

  describe("error handling", () => {
    it("should error on missing terminator", async () => {
      const env = new Bash({
        files: { "/dir/file.txt": "" }
      });
      const result = await env.exec(
        'find /dir -name "*.txt" -exec echo {} foo'
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("-exec");
    });

    it("should not print files when -exec is used", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "",
          "/dir/b.txt": ""
        }
      });
      const result = await env.exec(
        'find /dir -name "*.txt" -exec echo found \\;'
      );
      expect(result.exitCode).toBe(0);
      // Should only contain "found" messages, not the file paths from default print
      expect(result.stdout).toBe("found\nfound\n");
    });

    it("should handle no matching files", async () => {
      const env = new Bash({
        files: { "/dir/file.txt": "" }
      });
      const result = await env.exec(
        'find /dir -name "*.log" -exec echo {} \\;'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });
  });

  describe("combined with other predicates", () => {
    it("should work with -type f", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": "content",
          "/dir/subdir/nested.txt": ""
        }
      });
      const result = await env.exec(
        'find /dir -type f -name "*.txt" -exec cat {} \\;'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("content");
      expect(result.stderr).toBe("");
    });

    it("should work with -maxdepth", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": "top",
          "/dir/sub/file.txt": "nested"
        }
      });
      const result = await env.exec(
        "find /dir -maxdepth 1 -type f -exec cat {} \\;"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("top");
    });
  });
});
