import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("find actions", () => {
  describe("-exec {} + (batch mode)", () => {
    it("should execute command once with all files", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "aaa",
          "/dir/b.txt": "bbb",
          "/dir/c.txt": "ccc"
        }
      });
      const result = await env.exec(
        'find /dir -type f -name "*.txt" -exec cat {} +'
      );
      // All files should be passed to cat at once - output is concatenated
      expect(result.stdout).toBe("aaabbbccc");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should work with wc -l to count all lines at once", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "line1\nline2\n",
          "/dir/b.txt": "line1\nline2\nline3\n"
        }
      });
      const result = await env.exec(
        'find /dir -type f -name "*.txt" -exec wc -l {} +'
      );
      // wc -l with multiple files shows per-file counts and total
      expect(result.stdout).toBe(`  2 /dir/a.txt
  3 /dir/b.txt
  5 total
`);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should pass multiple files to grep", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "hello world",
          "/dir/b.txt": "hello there",
          "/dir/c.txt": "goodbye"
        }
      });
      const result = await env.exec(
        "find /dir -type f -exec grep -l hello {} +"
      );
      expect(result.stdout).toBe("/dir/a.txt\n/dir/b.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-exec {} ; (single file mode)", () => {
    it("should execute command for each file separately", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "aaa",
          "/dir/b.txt": "bbb"
        }
      });
      // Using echo to see each file is processed separately
      const result = await env.exec(
        'find /dir -type f -name "*.txt" -exec echo FILE: {} \\;'
      );
      expect(result.stdout).toBe("FILE: /dir/a.txt\nFILE: /dir/b.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-print0", () => {
    it("should output null-terminated filenames", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/b.txt": "b"
        }
      });
      const result = await env.exec('find /dir -type f -name "*.txt" -print0');
      expect(result.stdout).toBe("/dir/a.txt\0/dir/b.txt\0");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should work with xargs -0", async () => {
      const env = new Bash({
        files: {
          "/dir/file with spaces.txt": "content",
          "/dir/normal.txt": "content"
        }
      });
      const result = await env.exec(
        "find /dir -type f -print0 | xargs -0 echo"
      );
      expect(result.stdout).toBe("/dir/file with spaces.txt /dir/normal.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-delete", () => {
    it("should delete found files", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/b.txt": "b",
          "/dir/keep.md": "keep"
        }
      });
      await env.exec('find /dir -type f -name "*.txt" -delete');

      // Check that .txt files are gone
      const result = await env.exec("ls /dir");
      expect(result.stdout).toBe("keep.md\n");
      expect(result.stderr).toBe("");
    });

    it("should delete empty directories", async () => {
      const env = new Bash({
        files: {
          "/dir/subdir/.keep": ""
        }
      });
      // First delete the file, then the empty directory
      await env.exec("rm /dir/subdir/.keep");
      await env.exec("find /dir -type d -empty -delete");

      const result = await env.exec("ls /dir");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });

    it("should not delete non-empty directories", async () => {
      const env = new Bash({
        files: {
          "/dir/subdir/file.txt": "content"
        }
      });
      const result = await env.exec("find /dir -type d -name subdir -delete");
      // Should fail because directory is not empty
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        "find: cannot delete '/dir/subdir': ENOTEMPTY: directory not empty, rm '/dir/subdir'\n"
      );
    });

    it("should delete files sorted by depth (deepest first)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/sub/b.txt": "b",
          "/dir/sub/deep/c.txt": "c"
        }
      });
      // Delete all .txt files - should work because files are deleted deepest-first
      await env.exec('find /dir -name "*.txt" -delete');

      const result = await env.exec("find /dir -type f");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-print (explicit)", () => {
    it("should only print when -print is reached in expression", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/b.md": "b"
        }
      });
      // Only print .txt files explicitly
      const result = await env.exec('find /dir -name "*.txt" -print');
      expect(result.stdout).toBe("/dir/a.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should work with OR and selective printing", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/b.md": "b",
          "/dir/c.json": "c"
        }
      });
      // Complex expression: print .txt OR process .md silently
      const result = await env.exec(
        'find /dir -name "*.txt" -print -o -name "*.md"'
      );
      // Only .txt files are printed because -print is in that branch
      expect(result.stdout).toBe("/dir/a.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });
});
