import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("grep --exclude and --exclude-dir", () => {
  describe("--exclude", () => {
    it("should exclude files matching pattern", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": "hello world",
          "/dir/file.log": "hello world",
          "/dir/other.txt": "hello world"
        }
      });
      const result = await env.exec('grep -r --exclude="*.log" hello /dir');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("file.txt");
      expect(result.stdout).toContain("other.txt");
      expect(result.stdout).not.toContain("file.log");
    });

    it("should handle multiple --exclude patterns", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": "hello",
          "/dir/file.log": "hello",
          "/dir/file.bak": "hello"
        }
      });
      const result = await env.exec(
        'grep -r --exclude="*.log" --exclude="*.bak" hello /dir'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("/dir/file.txt:hello\n");
    });

    it("should work with non-recursive search", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "hello",
          "/b.log": "hello"
        },
        cwd: "/"
      });
      const result = await env.exec('grep --exclude="*.log" hello a.txt b.log');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a.txt:hello\n");
    });
  });

  describe("--exclude-dir", () => {
    it("should exclude directories matching pattern", async () => {
      const env = new Bash({
        files: {
          "/project/src/main.js": "hello",
          "/project/node_modules/pkg/index.js": "hello",
          "/project/build/out.js": "hello"
        }
      });
      const result = await env.exec(
        "grep -r --exclude-dir=node_modules hello /project"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("src/main.js");
      expect(result.stdout).toContain("build/out.js");
      expect(result.stdout).not.toContain("node_modules");
    });

    it("should handle multiple --exclude-dir patterns", async () => {
      const env = new Bash({
        files: {
          "/project/src/main.js": "hello",
          "/project/node_modules/pkg/index.js": "hello",
          "/project/build/out.js": "hello",
          "/project/.git/objects/abc": "hello"
        }
      });
      const result = await env.exec(
        "grep -r --exclude-dir=node_modules --exclude-dir=build hello /project"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("src/main.js");
      expect(result.stdout).not.toContain("node_modules");
      expect(result.stdout).not.toContain("build");
    });

    it("should combine --exclude and --exclude-dir", async () => {
      const env = new Bash({
        files: {
          "/project/src/main.js": "hello",
          "/project/src/test.spec.js": "hello",
          "/project/node_modules/pkg/index.js": "hello"
        }
      });
      const result = await env.exec(
        'grep -r --exclude-dir=node_modules --exclude="*.spec.js" hello /project'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("/project/src/main.js:hello\n");
    });
  });
});

describe("grep -L (files without match)", () => {
  it("should list files without matches", async () => {
    const env = new Bash({
      files: {
        "/dir/has-match.txt": "hello world",
        "/dir/no-match.txt": "goodbye world",
        "/dir/also-no-match.txt": "nothing here"
      }
    });
    const result = await env.exec(
      "grep -L hello /dir/has-match.txt /dir/no-match.txt /dir/also-no-match.txt"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/dir/no-match.txt\n/dir/also-no-match.txt\n");
  });

  it("should return exit code 0 when files without match found", async () => {
    const env = new Bash({
      files: {
        "/file1.txt": "hello",
        "/file2.txt": "goodbye"
      }
    });
    const result = await env.exec("grep -L hello /file1.txt /file2.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/file2.txt\n");
  });

  it("should return exit code 1 when all files have matches", async () => {
    const env = new Bash({
      files: {
        "/file1.txt": "hello",
        "/file2.txt": "hello"
      }
    });
    const result = await env.exec("grep -L hello /file1.txt /file2.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("should work with recursive search", async () => {
    const env = new Bash({
      files: {
        "/dir/has-hello.txt": "hello",
        "/dir/no-hello.txt": "goodbye",
        "/dir/sub/has-hello2.txt": "hello",
        "/dir/sub/no-hello2.txt": "goodbye"
      }
    });
    const result = await env.exec("grep -rL hello /dir");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no-hello.txt");
    expect(result.stdout).toContain("no-hello2.txt");
    expect(result.stdout).not.toContain("has-hello.txt");
    expect(result.stdout).not.toContain("has-hello2.txt");
  });

  it("should support --files-without-match long form", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "hello",
        "/b.txt": "goodbye"
      }
    });
    const result = await env.exec(
      "grep --files-without-match hello /a.txt /b.txt"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("/b.txt\n");
  });
});
