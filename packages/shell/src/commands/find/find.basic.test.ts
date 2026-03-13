import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("find basic", () => {
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

  it("should find all files and directories from path", async () => {
    const env = createEnv();
    const result = await env.exec("find /project");
    expect(result.stdout).toBe(`/project
/project/README.md
/project/package.json
/project/src
/project/src/index.ts
/project/src/utils
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests
/project/tests/index.test.ts
/project/tsconfig.json
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should find files by name pattern", async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "*.ts"');
    expect(result.stdout).toBe(`/project/src/index.ts
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests/index.test.ts
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should find files only with -type f", async () => {
    const env = createEnv();
    const result = await env.exec("find /project -type f");
    expect(result.stdout).toBe(`/project/README.md
/project/package.json
/project/src/index.ts
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests/index.test.ts
/project/tsconfig.json
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should find directories only with -type d", async () => {
    const env = createEnv();
    const result = await env.exec("find /project -type d");
    expect(result.stdout).toBe(`/project
/project/src
/project/src/utils
/project/tests
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should find files matching JSON pattern", async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "*.json"');
    expect(result.stdout).toBe(`/project/package.json
/project/tsconfig.json
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should find from current directory with .", async () => {
    const env = createEnv();
    const result = await env.exec('find . -name "*.md"');
    expect(result.stdout).toBe("./README.md\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should combine -name and -type", async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "*.ts" -type f');
    expect(result.stdout).toBe(`/project/src/index.ts
/project/src/utils/format.ts
/project/src/utils/helpers.ts
/project/tests/index.test.ts
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should find specific filename", async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "index.ts"');
    expect(result.stdout).toBe("/project/src/index.ts\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should return error for non-existent path", async () => {
    const env = createEnv();
    const result = await env.exec("find /nonexistent");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "find: /nonexistent: No such file or directory\n"
    );
    expect(result.exitCode).toBe(1);
  });

  it("should find test files", async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "*.test.ts"');
    expect(result.stdout).toBe("/project/tests/index.test.ts\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle ? wildcard in name pattern", async () => {
    const env = createEnv();
    const result = await env.exec('find /project -name "???*.json"');
    expect(result.stdout).toBe(`/project/package.json
/project/tsconfig.json
`);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  describe("--help option", () => {
    it("should show help text", async () => {
      const env = createEnv();
      const result = await env.exec("find --help");
      expect(result.stdout).toContain("find");
      expect(result.stdout).toContain("-name");
      expect(result.stdout).toContain("-maxdepth");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("unknown option handling", () => {
    it("should error on unknown predicate", async () => {
      const env = createEnv();
      const result = await env.exec("find /project -unknown");
      expect(result.stderr).toContain("find: unknown predicate '-unknown'");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown long option", async () => {
      const env = createEnv();
      const result = await env.exec("find /project --badoption");
      expect(result.stderr).toContain("find: unknown predicate '--badoption'");
      expect(result.exitCode).toBe(1);
    });

    it("should error on invalid -type argument", async () => {
      const env = createEnv();
      const result = await env.exec("find /project -type x");
      expect(result.stderr).toContain("Unknown argument to -type");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("multiple search paths", () => {
    it("should search multiple paths", async () => {
      const env = new Bash({
        files: {
          "/dir1/a.txt": "a",
          "/dir2/b.txt": "b",
          "/dir3/c.txt": "c"
        }
      });
      const result = await env.exec('find /dir1 /dir2 -name "*.txt"');
      expect(result.stdout).toBe("/dir1/a.txt\n/dir2/b.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle non-existent paths gracefully", async () => {
      const env = new Bash({
        files: {
          "/dir1/a.txt": "a"
        }
      });
      const result = await env.exec("find /dir1 /nonexistent -type f");
      expect(result.stdout).toBe("/dir1/a.txt\n");
      expect(result.stderr).toBe(
        "find: /nonexistent: No such file or directory\n"
      );
      expect(result.exitCode).toBe(1);
    });

    it("should search three paths", async () => {
      const env = new Bash({
        files: {
          "/a/file.txt": "a",
          "/b/file.txt": "b",
          "/c/file.txt": "c"
        }
      });
      const result = await env.exec('find /a /b /c -name "*.txt"');
      expect(result.stdout).toBe("/a/file.txt\n/b/file.txt\n/c/file.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("special characters in filenames", () => {
    it("should find files with spaces in name", async () => {
      const env = new Bash({
        files: {
          "/dir/file with spaces.txt": "content",
          "/dir/normal.txt": "content"
        }
      });
      const result = await env.exec('find /dir -name "file with spaces.txt"');
      expect(result.stdout).toBe("/dir/file with spaces.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files with tabs in name", async () => {
      const env = new Bash({
        files: {
          "/dir/file\twith\ttabs.txt": "content",
          "/dir/normal.txt": "content"
        }
      });
      const result = await env.exec('find /dir -name "file\twith\ttabs.txt"');
      expect(result.stdout).toBe("/dir/file\twith\ttabs.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files with special chars using wildcards", async () => {
      const env = new Bash({
        files: {
          "/dir/file with spaces.txt": "content",
          "/dir/another file.txt": "content",
          "/dir/normal.txt": "content"
        }
      });
      const result = await env.exec('find /dir -name "* *"');
      expect(result.stdout).toBe(
        "/dir/another file.txt\n/dir/file with spaces.txt\n"
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("root directory search", () => {
    it("should find files from root without cutting first character (issue #28)", async () => {
      const env = new Bash({
        files: {
          "src/index.ts": "console.log(1)",
          "src/lib/util.ts": "export const x = 1;",
          "bin/script.sh": "#!/bin/bash"
        },
        cwd: "/"
      });
      const result = await env.exec(
        "find . -type f -path './src/*' -o -type f -path './bin/script.sh' | sort"
      );
      expect(result.stdout).toBe(
        "./bin/script.sh\n./src/index.ts\n./src/lib/util.ts\n"
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should preserve full paths when searching from root with dot", async () => {
      const env = new Bash({
        files: {
          "abc/file.txt": "content"
        },
        cwd: "/"
      });
      const result = await env.exec('find . -name "file.txt"');
      expect(result.stdout).toBe("./abc/file.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should normalize trailing slashes in search path", async () => {
      const env = new Bash({
        files: {
          "/project/src/index.ts": "content"
        },
        cwd: "/project"
      });
      const result = await env.exec('find /project/ -name "*.ts"');
      expect(result.stdout).toBe("/project/src/index.ts\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });
});
