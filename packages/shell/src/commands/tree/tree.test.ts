import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("tree command", () => {
  describe("basic usage", () => {
    it("should display directory tree", async () => {
      const env = new Bash({
        files: {
          "/project/src/main.ts": "code",
          "/project/src/utils.ts": "utils",
          "/project/README.md": "readme"
        }
      });
      const result = await env.exec("tree /project");
      expect(result.stdout).toContain("/project");
      expect(result.stdout).toContain("src");
      expect(result.stdout).toContain("main.ts");
      expect(result.stdout).toContain("README.md");
      expect(result.exitCode).toBe(0);
    });

    it("should show summary at end", async () => {
      const env = new Bash({
        files: {
          "/dir/file1.txt": "a",
          "/dir/file2.txt": "b",
          "/dir/subdir/file3.txt": "c"
        }
      });
      const result = await env.exec("tree /dir");
      expect(result.stdout).toContain("director");
      expect(result.stdout).toContain("file");
    });

    it("should handle empty directory", async () => {
      const env = new Bash();
      await env.exec("mkdir /empty");
      const result = await env.exec("tree /empty");
      expect(result.stdout).toContain("/empty");
      expect(result.stdout).toContain("0 directories");
      expect(result.exitCode).toBe(0);
    });

    it("should error on missing directory", async () => {
      const env = new Bash();
      const result = await env.exec("tree /nonexistent");
      expect(result.stderr).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("-a option", () => {
    it("should show hidden files with -a", async () => {
      const env = new Bash({
        files: {
          "/dir/.hidden": "hidden",
          "/dir/visible.txt": "visible"
        }
      });
      const result = await env.exec("tree -a /dir");
      expect(result.stdout).toContain(".hidden");
      expect(result.stdout).toContain("visible.txt");
    });

    it("should hide hidden files without -a", async () => {
      const env = new Bash({
        files: {
          "/dir/.hidden": "hidden",
          "/dir/visible.txt": "visible"
        }
      });
      const result = await env.exec("tree /dir");
      expect(result.stdout).not.toContain(".hidden");
      expect(result.stdout).toContain("visible.txt");
    });
  });

  describe("-d option", () => {
    it("should show only directories with -d", async () => {
      const env = new Bash({
        files: {
          "/project/src/main.ts": "code",
          "/project/lib/helper.ts": "helper"
        }
      });
      const result = await env.exec("tree -d /project");
      expect(result.stdout).toContain("src");
      expect(result.stdout).toContain("lib");
      expect(result.stdout).not.toContain("main.ts");
      expect(result.stdout).not.toContain("helper.ts");
    });
  });

  describe("-L option", () => {
    it("should limit depth with -L 1", async () => {
      const env = new Bash({
        files: {
          "/deep/level1/level2/file.txt": "deep"
        }
      });
      const result = await env.exec("tree -L 1 /deep");
      expect(result.stdout).toContain("level1");
      expect(result.stdout).not.toContain("level2");
    });

    it("should limit depth with -L 2", async () => {
      const env = new Bash({
        files: {
          "/deep/level1/level2/level3/file.txt": "deep"
        }
      });
      const result = await env.exec("tree -L 2 /deep");
      expect(result.stdout).toContain("level1");
      expect(result.stdout).toContain("level2");
      expect(result.stdout).not.toContain("level3");
    });
  });

  describe("-f option", () => {
    it("should show full path with -f", async () => {
      const env = new Bash({
        files: {
          "/project/src/main.ts": "code"
        }
      });
      const result = await env.exec("tree -f /project");
      expect(result.stdout).toContain("/project/src");
      expect(result.stdout).toContain("/project/src/main.ts");
    });
  });

  describe("help option", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("tree --help");
      expect(result.stdout).toContain("tree");
      expect(result.stdout).toContain("-a");
      expect(result.stdout).toContain("-d");
      expect(result.stdout).toContain("-L");
      expect(result.exitCode).toBe(0);
    });
  });
});
