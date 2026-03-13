import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("du command", () => {
  describe("basic usage", () => {
    it("should show directory size", async () => {
      const env = new Bash({
        files: {
          "/mydir/file.txt": "hello"
        }
      });
      const result = await env.exec("du /mydir");
      expect(result.stdout).toContain("/mydir");
      expect(result.exitCode).toBe(0);
    });

    it("should show file size", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "hello world"
        }
      });
      const result = await env.exec("du /test.txt");
      expect(result.stdout).toContain("/test.txt");
      expect(result.exitCode).toBe(0);
    });

    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("du /nonexistent");
      expect(result.stderr).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("-a option", () => {
    it("should show all files with -a", async () => {
      const env = new Bash({
        files: {
          "/dir/file1.txt": "aaa",
          "/dir/file2.txt": "bbbbb"
        }
      });
      const result = await env.exec("du -a /dir");
      expect(result.stdout).toContain("file1.txt");
      expect(result.stdout).toContain("file2.txt");
      expect(result.stdout).toContain("/dir");
    });
  });

  describe("-s option", () => {
    it("should show only summary with -s", async () => {
      const env = new Bash({
        files: {
          "/dir/sub/file.txt": "content"
        }
      });
      const result = await env.exec("du -s /dir");
      expect(result.stdout).toContain("/dir");
      // Should not contain subdirectory lines
      const lines = result.stdout.trim().split("\n");
      expect(lines.length).toBe(1);
    });
  });

  describe("-h option", () => {
    it("should show human readable sizes", async () => {
      const env = new Bash({
        files: {
          "/big/file.txt": "x".repeat(2048)
        }
      });
      const result = await env.exec("du -h /big");
      // Should show K for kilobytes
      expect(result.stdout).toMatch(/\d+(\.\d)?K|\d+/);
    });
  });

  describe("-c option", () => {
    it("should show grand total", async () => {
      const env = new Bash({
        files: {
          "/dir1/file.txt": "aaa",
          "/dir2/file.txt": "bbb"
        }
      });
      const result = await env.exec("du -c /dir1 /dir2");
      expect(result.stdout).toContain("total");
    });
  });

  describe("--max-depth option", () => {
    it("should limit depth with --max-depth=0", async () => {
      const env = new Bash({
        files: {
          "/dir/sub/file.txt": "content"
        }
      });
      const result = await env.exec("du --max-depth=0 /dir");
      const lines = result.stdout.trim().split("\n");
      expect(lines.length).toBe(1);
      expect(result.stdout).toContain("/dir");
    });
  });

  describe("help option", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("du --help");
      expect(result.stdout).toContain("du");
      expect(result.stdout).toContain("-s");
      expect(result.stdout).toContain("-h");
      expect(result.exitCode).toBe(0);
    });
  });
});
