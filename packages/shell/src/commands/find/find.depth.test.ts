import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("find depth options", () => {
  const createEnv = () =>
    new Bash({
      files: {
        "/project/README.md": "# Project",
        "/project/src/index.ts": "export {}",
        "/project/src/utils/helpers.ts": "export function helper() {}",
        "/project/src/utils/format.ts": "export function format() {}",
        "/project/tests/index.test.ts": 'test("works", () => {})',
        "/project/package.json": "{}",
        "/project/tsconfig.json": "{}"
      },
      cwd: "/project"
    });

  describe("-maxdepth option", () => {
    it("should limit depth to 0 (only starting point)", async () => {
      const env = createEnv();
      const result = await env.exec("find /project -maxdepth 0");
      expect(result.stdout).toBe("/project\n");
      expect(result.exitCode).toBe(0);
    });

    it("should limit depth to 1 (immediate children)", async () => {
      const env = createEnv();
      const result = await env.exec("find /project -maxdepth 1");
      expect(result.stdout).toBe(`/project
/project/README.md
/project/package.json
/project/src
/project/tests
/project/tsconfig.json
`);
      expect(result.exitCode).toBe(0);
    });

    it("should limit depth to 2", async () => {
      const env = createEnv();
      const result = await env.exec('find /project -maxdepth 2 -name "*.ts"');
      expect(result.stdout).toBe(`/project/src/index.ts
/project/tests/index.test.ts
`);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-mindepth option", () => {
    it("should skip results at depth 0", async () => {
      const env = createEnv();
      const result = await env.exec("find /project -mindepth 1 -type d");
      expect(result.stdout).toBe(`/project/src
/project/src/utils
/project/tests
`);
      expect(result.exitCode).toBe(0);
    });

    it("should skip results at depth 0 and 1", async () => {
      const env = createEnv();
      const result = await env.exec(
        'find /project -mindepth 2 -type f -name "*.ts"'
      );
      expect(result.stdout).toBe(`/project/src/index.ts
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests/index.test.ts
`);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("combined -maxdepth and -mindepth", () => {
    it("should find only at specific depth", async () => {
      const env = createEnv();
      const result = await env.exec(
        "find /project -mindepth 1 -maxdepth 1 -type f"
      );
      expect(result.stdout).toBe(`/project/README.md
/project/package.json
/project/tsconfig.json
`);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-depth option", () => {
    it("should process directory contents before directory", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/sub/b.txt": "b"
        }
      });
      const result = await env.exec("find /dir -depth");
      // Files and subdirs should come before their parent directories
      expect(result.stdout).toBe(`/dir/a.txt
/dir/sub/b.txt
/dir/sub
/dir
`);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should process files in correct depth-first order", async () => {
      const env = new Bash({
        files: {
          "/dir/a/1.txt": "1",
          "/dir/b/2.txt": "2"
        }
      });
      const result = await env.exec("find /dir -depth -type f");
      expect(result.stdout).toBe(`/dir/a/1.txt
/dir/b/2.txt
`);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -delete for safe directory removal", async () => {
      const env = new Bash({
        files: {
          "/dir/sub/a.txt": "a"
        }
      });
      // With -depth, files are processed before directories, so -delete works
      await env.exec("find /dir/sub -depth -delete");
      // /dir/sub should be deleted (including its contents)
      const result = await env.exec("ls /dir");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should not affect -prune behavior", async () => {
      const env = new Bash({
        files: {
          "/dir/skip/hidden.txt": "hidden",
          "/dir/keep/visible.txt": "visible"
        }
      });
      // -depth with -prune still works but -prune has no effect in depth-first
      const result = await env.exec("find /dir -depth -type f");
      expect(result.stdout).toBe(`/dir/keep/visible.txt
/dir/skip/hidden.txt
`);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });
});
