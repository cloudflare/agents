import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("find patterns", () => {
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

  describe("-iname (case insensitive)", () => {
    it("should find files case insensitively", async () => {
      const env = new Bash({
        files: {
          "/dir/README.md": "",
          "/dir/readme.txt": "",
          "/dir/Readme.rst": "",
          "/dir/other.txt": ""
        }
      });
      const result = await env.exec('find /dir -iname "readme*"');
      expect(result.stdout).toBe(`/dir/README.md
/dir/Readme.rst
/dir/readme.txt
`);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should match uppercase pattern to lowercase file", async () => {
      const env = new Bash({
        files: {
          "/dir/config.json": ""
        }
      });
      const result = await env.exec('find /dir -iname "CONFIG.JSON"');
      expect(result.stdout).toBe("/dir/config.json\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-path option", () => {
    it("should match against full path", async () => {
      const env = createEnv();
      const result = await env.exec('find /project -path "*/utils/*"');
      expect(result.stdout).toBe(`/project/src/utils/format.ts
/project/src/utils/helpers.ts
`);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should match path pattern with extension", async () => {
      const env = createEnv();
      const result = await env.exec('find /project -path "*tests*"');
      expect(result.stdout).toBe(`/project/tests
/project/tests/index.test.ts
`);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-ipath option", () => {
    it("should match path case insensitively", async () => {
      const env = new Bash({
        files: {
          "/Project/SRC/file.ts": "",
          "/Project/src/other.ts": ""
        }
      });
      const result = await env.exec('find /Project -ipath "*src*"');
      expect(result.stdout).toBe(`/Project/SRC
/Project/SRC/file.ts
/Project/src
/Project/src/other.ts
`);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-regex and -iregex", () => {
    it("should match files with -regex", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": "",
          "/dir/file.js": "",
          "/dir/sub/other.txt": ""
        }
      });
      const result = await env.exec('find /dir -regex ".*\\.txt"');
      expect(result.stdout).toBe("/dir/file.txt\n/dir/sub/other.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match full path with -regex", async () => {
      const env = new Bash({
        files: {
          "/dir/src/file.ts": "",
          "/dir/test/file.ts": ""
        }
      });
      const result = await env.exec('find /dir -regex ".*/src/.*"');
      expect(result.stdout).toBe("/dir/src/file.ts\n");
      expect(result.exitCode).toBe(0);
    });

    it("should match case-insensitively with -iregex", async () => {
      const env = new Bash({
        files: {
          "/dir/FILE.TXT": "",
          "/dir/file.txt": "",
          "/dir/other.js": ""
        }
      });
      const result = await env.exec('find /dir -iregex ".*\\.txt"');
      expect(result.stdout).toBe("/dir/FILE.TXT\n/dir/file.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with complex regex patterns", async () => {
      const env = new Bash({
        files: {
          "/dir/test1.ts": "",
          "/dir/test2.ts": "",
          "/dir/test10.ts": "",
          "/dir/other.ts": ""
        }
      });
      const result = await env.exec('find /dir -regex ".*/test[0-9]\\.ts"');
      expect(result.stdout).toBe("/dir/test1.ts\n/dir/test2.ts\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-empty option", () => {
    it("should find empty files", async () => {
      const env = new Bash({
        files: {
          "/dir/empty.txt": "",
          "/dir/notempty.txt": "content"
        }
      });
      const result = await env.exec("find /dir -empty -type f");
      expect(result.stdout).toBe("/dir/empty.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find empty directories", async () => {
      const env = new Bash({
        files: {
          "/dir/notempty/file.txt": "content"
        }
      });
      await env.exec("mkdir /dir/emptydir");
      const result = await env.exec("find /dir -empty -type d");
      expect(result.stdout).toBe("/dir/emptydir\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-prune", () => {
    it("should not descend into pruned directories", async () => {
      const env = new Bash({
        files: {
          "/dir/skip/hidden.txt": "",
          "/dir/skip/inside/nested.txt": "",
          "/dir/include/file.txt": ""
        }
      });
      const result = await env.exec(
        "find /dir -name skip -prune -o -type f -print"
      );
      expect(result.stdout).toBe("/dir/include/file.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should prune multiple directories", async () => {
      const env = new Bash({
        files: {
          "/dir/node_modules/pkg/index.js": "",
          "/dir/.git/objects/abc": "",
          "/dir/src/main.ts": ""
        }
      });
      const result = await env.exec(
        'find /dir \\( -name node_modules -o -name ".git" \\) -prune -o -type f -print'
      );
      expect(result.stdout).toBe("/dir/src/main.ts\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -type d to prune specific directories", async () => {
      const env = new Bash({
        files: {
          "/project/dist/bundle.js": "",
          "/project/src/index.ts": "",
          "/project/README.md": ""
        }
      });
      const result = await env.exec(
        "find /project -type d -name dist -prune -o -type f -print"
      );
      expect(result.stdout).toBe("/project/README.md\n/project/src/index.ts\n");
      expect(result.exitCode).toBe(0);
    });

    it("should allow finding pruned directory itself without -print", async () => {
      const env = new Bash({
        files: {
          "/dir/skip/file.txt": "",
          "/dir/keep/file.txt": ""
        }
      });
      const result = await env.exec("find /dir -name skip -prune");
      expect(result.stdout).toBe("/dir/skip\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-path with directory segments (fast path optimization)", () => {
    it("should find files matching path pattern with specific directory", async () => {
      const env = new Bash({
        files: {
          "/repos/project1/pulls/1.json": "{}",
          "/repos/project1/pulls/2.json": "{}",
          "/repos/project1/issues/1.json": "{}",
          "/repos/project2/pulls/3.json": "{}",
          "/repos/project2/other/4.json": "{}"
        }
      });
      const result = await env.exec(
        'find /repos -path "*/pulls/*.json" -type f'
      );
      expect(result.stdout).toBe(
        "/repos/project1/pulls/1.json\n/repos/project1/pulls/2.json\n/repos/project2/pulls/3.json\n"
      );
      expect(result.exitCode).toBe(0);
    });

    it("should handle path pattern with multiple literal segments", async () => {
      const env = new Bash({
        files: {
          "/a/src/lib/util.ts": "",
          "/a/src/util.ts": "",
          "/a/lib/util.ts": ""
        }
      });
      const result = await env.exec('find /a -path "*/src/lib/*" -type f');
      expect(result.stdout).toBe("/a/src/lib/util.ts\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle path pattern with extension filter", async () => {
      const env = new Bash({
        files: {
          "/data/pulls/1.json": "{}",
          "/data/pulls/2.txt": "",
          "/data/pulls/readme.md": ""
        }
      });
      const result = await env.exec('find /data -path "*/pulls/*.json"');
      expect(result.stdout).toBe("/data/pulls/1.json\n");
      expect(result.exitCode).toBe(0);
    });

    it("should correctly handle path pattern starting with ./", async () => {
      const env = new Bash({
        files: {
          "/project/src/index.ts": "",
          "/project/src/utils.ts": "",
          "/project/lib/index.ts": ""
        },
        cwd: "/project"
      });
      const result = await env.exec('find . -path "./src/*" -type f');
      expect(result.stdout).toBe("./src/index.ts\n./src/utils.ts\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
