import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("grep advanced", () => {
  // Piping tests
  describe("piping", () => {
    it("should work in middle of pipe chain", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\nline4\nline5\n" }
      });
      const result = await env.exec("cat /test.txt | grep line | head -n 2");
      expect(result.stdout).toBe("line1\nline2\n");
    });

    it("should filter ls output", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": "",
          "/dir/file.md": "",
          "/dir/other.js": ""
        }
      });
      const result = await env.exec("ls /dir | grep txt");
      expect(result.stdout).toBe("file.txt\n");
    });

    it("should chain multiple greps", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "apple pie\nbanana bread\napple tart\norange juice\n"
        }
      });
      const result = await env.exec("cat /test.txt | grep apple | grep pie");
      expect(result.stdout).toBe("apple pie\n");
    });

    it("should work with wc after grep", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "error: one\ninfo: two\nerror: three\nwarn: four\n"
        }
      });
      const result = await env.exec("grep error /test.txt | wc -l");
      expect(result.stdout.trim()).toBe("2");
    });
  });

  // Only matching (-o) tests
  describe("-o flag (only matching)", () => {
    it("should output only matching parts with -o", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world hello\nfoo bar\n" }
      });
      const result = await env.exec("grep -o hello /test.txt");
      expect(result.stdout).toBe("hello\nhello\n");
      expect(result.exitCode).toBe(0);
    });

    it("should output only matching parts with --only-matching", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat dog cat\n" }
      });
      const result = await env.exec("grep --only-matching cat /test.txt");
      expect(result.stdout).toBe("cat\ncat\n");
      expect(result.exitCode).toBe(0);
    });

    it("should include filename with -o for multiple files", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "test one test\n",
          "/b.txt": "test two\n"
        }
      });
      const result = await env.exec("grep -o test /a.txt /b.txt");
      expect(result.stdout).toBe("/a.txt:test\n/a.txt:test\n/b.txt:test\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with regex patterns and -o", async () => {
      const env = new Bash({
        files: { "/test.txt": "price: 100 and 200 dollars\n" }
      });
      const result = await env.exec('grep -Eo "[0-9]+" /test.txt');
      expect(result.stdout).toBe("100\n200\n");
      expect(result.exitCode).toBe(0);
    });

    it("should suppress filename with -h and -o", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "foo bar foo\n",
          "/b.txt": "foo baz\n"
        }
      });
      const result = await env.exec("grep -oh foo /a.txt /b.txt");
      expect(result.stdout).toBe("foo\nfoo\nfoo\n");
      expect(result.exitCode).toBe(0);
    });
  });

  // Context flags (-A, -B, -C) tests
  describe("context flags (-A, -B, -C)", () => {
    const contextEnv = () =>
      new Bash({
        files: {
          "/test.txt": "line1\nline2\nmatch\nline4\nline5\n"
        }
      });

    it("should show lines after match with -A", async () => {
      const env = contextEnv();
      const result = await env.exec("grep -A2 match /test.txt");
      expect(result.stdout).toBe("match\nline4\nline5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should show lines before match with -B", async () => {
      const env = contextEnv();
      const result = await env.exec("grep -B2 match /test.txt");
      expect(result.stdout).toBe("line1\nline2\nmatch\n");
      expect(result.exitCode).toBe(0);
    });

    it("should show lines before and after with -C", async () => {
      const env = contextEnv();
      const result = await env.exec("grep -C1 match /test.txt");
      expect(result.stdout).toBe("line2\nmatch\nline4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -A N syntax (space)", async () => {
      const env = contextEnv();
      const result = await env.exec("grep -A 1 match /test.txt");
      expect(result.stdout).toBe("match\nline4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should show context with line numbers", async () => {
      const env = contextEnv();
      const result = await env.exec("grep -n -B1 -A1 match /test.txt");
      expect(result.stdout).toBe("2-line2\n3:match\n4-line4\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple matches with context", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "a\nmatch1\nb\nc\nmatch2\nd\n"
        }
      });
      const result = await env.exec("grep -A1 match /test.txt");
      // Separator between non-contiguous groups (GNU grep behavior)
      expect(result.stdout).toBe("match1\nb\n--\nmatch2\nd\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle overlapping context ranges", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "a\nmatch1\nb\nmatch2\nc\n"
        }
      });
      const result = await env.exec("grep -C1 match /test.txt");
      expect(result.stdout).toBe("a\nmatch1\nb\nmatch2\nc\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-m flag (max count)", () => {
    it("should stop after -m matches", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\nline4\nline5\n" }
      });
      const result = await env.exec("grep -m 2 line /test.txt");
      expect(result.stdout).toBe("line1\nline2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with --max-count=N syntax", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\nd\n" }
      });
      const result = await env.exec("grep --max-count=1 '[a-z]' /test.txt");
      expect(result.stdout).toBe("a\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -mN syntax", async () => {
      const env = new Bash({
        files: { "/test.txt": "match1\nmatch2\nmatch3\n" }
      });
      const result = await env.exec("grep -m3 match /test.txt");
      expect(result.stdout).toBe("match1\nmatch2\nmatch3\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with context options", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nmatch1\nb\nmatch2\nc\nmatch3\nd\n" }
      });
      const result = await env.exec("grep -m 1 -A1 match /test.txt");
      expect(result.stdout).toBe("match1\nb\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with line numbers", async () => {
      const env = new Bash({
        files: { "/test.txt": "a\nb\nc\nd\ne\n" }
      });
      const result = await env.exec("grep -n -m 2 '[a-e]' /test.txt");
      expect(result.stdout).toBe("1:a\n2:b\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-x flag (line regexp)", () => {
    it("should match only whole lines with -x", async () => {
      const env = new Bash({
        files: { "/test.txt": "foo\nfoobar\nfoo\n" }
      });
      const result = await env.exec("grep -x foo /test.txt");
      expect(result.stdout).toBe("foo\nfoo\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with --line-regexp", async () => {
      const env = new Bash({
        files: { "/test.txt": "test\ntesting\ntest\n" }
      });
      const result = await env.exec("grep --line-regexp test /test.txt");
      expect(result.stdout).toBe("test\ntest\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with regex patterns", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc\nabcd\nabc\n" }
      });
      const result = await env.exec('grep -Ex "a.c" /test.txt');
      expect(result.stdout).toBe("abc\nabc\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with case insensitive matching", async () => {
      const env = new Bash({
        files: { "/test.txt": "Hello\nHELLO World\nhello\n" }
      });
      const result = await env.exec("grep -ix hello /test.txt");
      expect(result.stdout).toBe("Hello\nhello\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-h flag (no filename)", () => {
    it("should suppress filename with -h", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "match\n",
          "/b.txt": "match\n"
        }
      });
      const result = await env.exec("grep -h match /a.txt /b.txt");
      expect(result.stdout).toBe("match\nmatch\n");
      expect(result.exitCode).toBe(0);
    });

    it("should suppress filename with --no-filename", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "test\n",
          "/b.txt": "test\n"
        }
      });
      const result = await env.exec("grep --no-filename test /a.txt /b.txt");
      expect(result.stdout).toBe("test\ntest\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -h and -n", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "line1\nmatch\nline3\n",
          "/b.txt": "match\n"
        }
      });
      const result = await env.exec("grep -hn match /a.txt /b.txt");
      expect(result.stdout).toBe("2:match\n1:match\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -h and recursive", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "content\n",
          "/dir/b.txt": "content\n"
        }
      });
      const result = await env.exec("grep -rh content /dir");
      expect(result.stdout).toBe("content\ncontent\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("--include flag", () => {
    it("should only search files matching pattern", async () => {
      const env = new Bash({
        files: {
          "/dir/a.ts": "test\n",
          "/dir/b.js": "test\n",
          "/dir/c.ts": "test\n"
        }
      });
      const result = await env.exec('grep -r --include="*.ts" test /dir');
      expect(result.stdout).toBe("/dir/a.ts:test\n/dir/c.ts:test\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with multiple file types", async () => {
      const env = new Bash({
        files: {
          "/dir/a.ts": "test\n",
          "/dir/b.js": "test\n",
          "/dir/c.py": "test\n"
        }
      });
      // Only searching .ts files
      const result = await env.exec('grep -r --include="*.ts" test /dir');
      expect(result.stdout).toBe("/dir/a.ts:test\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with nested directories", async () => {
      const env = new Bash({
        files: {
          "/dir/a.ts": "match\n",
          "/dir/sub/b.ts": "match\n",
          "/dir/sub/c.js": "match\n"
        }
      });
      const result = await env.exec('grep -r --include="*.ts" match /dir');
      expect(result.stdout).toBe("/dir/a.ts:match\n/dir/sub/b.ts:match\n");
      expect(result.exitCode).toBe(0);
    });
  });

  // Glob expansion tests
  describe("glob expansion", () => {
    it("should expand *.ts to match files", async () => {
      const env = new Bash({
        files: {
          "/dir/a.ts": "foo\n",
          "/dir/b.ts": "bar\n",
          "/dir/c.js": "foo\n"
        },
        cwd: "/dir"
      });
      const result = await env.exec("grep foo *.ts");
      expect(result.stdout).toBe("a.ts:foo\n");
      expect(result.exitCode).toBe(0);
    });

    it("should expand path/*.ts pattern", async () => {
      const env = new Bash({
        files: {
          "/src/a.ts": "test\n",
          "/src/b.ts": "test\n",
          "/src/c.js": "test\n"
        }
      });
      const result = await env.exec("grep test /src/*.ts");
      expect(result.stdout).toBe("/src/a.ts:test\n/src/b.ts:test\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle no matches from glob", async () => {
      const env = new Bash({
        files: {
          "/dir/file.js": "content\n"
        }
      });
      const result = await env.exec("grep test /dir/*.ts");
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(1);
    });
  });

  // BRE alternation tests
  describe("BRE alternation (\\|)", () => {
    it("should support alternation with \\|", async () => {
      const env = new Bash({
        files: { "/test.txt": "cat\ndog\nbird\n" }
      });
      const result = await env.exec('grep "cat\\|dog" /test.txt');
      expect(result.stdout).toBe("cat\ndog\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support multiple alternations", async () => {
      const env = new Bash({
        files: { "/test.txt": "red\ngreen\nblue\nyellow\n" }
      });
      const result = await env.exec('grep "red\\|green\\|blue" /test.txt');
      expect(result.stdout).toBe("red\ngreen\nblue\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work case insensitively with alternation", async () => {
      const env = new Bash({
        files: { "/test.txt": "PASSWORD\npassword\nsecret\n" }
      });
      const result = await env.exec('grep -i "PASSWORD\\|secret" /test.txt');
      expect(result.stdout).toBe("PASSWORD\npassword\nsecret\n");
      expect(result.exitCode).toBe(0);
    });
  });

  // Real-world scenarios
  describe("real-world scenarios", () => {
    it("should search for function definitions", async () => {
      const env = new Bash({
        files: {
          "/code.js":
            'function hello() {\n  return "hello";\n}\nfunction world() {\n  return "world";\n}\n'
        }
      });
      const result = await env.exec('grep "function" /code.js');
      expect(result.stdout).toBe("function hello() {\nfunction world() {\n");
    });

    it("should search log files for errors", async () => {
      const env = new Bash({
        files: {
          "/app.log":
            "[INFO] Starting app\n[ERROR] Connection failed\n[INFO] Retrying\n[ERROR] Timeout\n[INFO] Success\n"
        }
      });
      const result = await env.exec("grep ERROR /app.log");
      expect(result.stdout).toBe(
        "[ERROR] Connection failed\n[ERROR] Timeout\n"
      );
    });

    it("should find TODO comments", async () => {
      const env = new Bash({
        files: {
          "/src/a.js": "// TODO: fix this\ncode here\n",
          "/src/b.js": "// Regular comment\n// TODO: implement\n"
        }
      });
      const result = await env.exec("grep -r TODO /src");
      expect(result.stdout).toContain("TODO");
    });

    it("should search config files", async () => {
      const env = new Bash({
        files: {
          "/config.json":
            '{\n  "port": 3000,\n  "host": "localhost",\n  "debug": true\n}\n'
        }
      });
      const result = await env.exec('grep "port" /config.json');
      expect(result.stdout).toBe('  "port": 3000,\n');
    });

    it("should find import statements", async () => {
      const env = new Bash({
        files: {
          "/index.ts":
            "import { foo } from './foo';\nimport { bar } from './bar';\nconst x = 1;\n"
        }
      });
      const result = await env.exec('grep "^import" /index.ts');
      expect(result.stdout).toBe(
        "import { foo } from './foo';\nimport { bar } from './bar';\n"
      );
    });

    it("should search for IP addresses", async () => {
      const env = new Bash({
        files: {
          "/hosts.txt":
            "localhost 127.0.0.1\nserver 192.168.1.100\ngateway 10.0.0.1\n"
        }
      });
      const result = await env.exec(
        'grep -E "[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+" /hosts.txt'
      );
      expect(result.stdout).toBe(
        "localhost 127.0.0.1\nserver 192.168.1.100\ngateway 10.0.0.1\n"
      );
    });

    it("should find class definitions", async () => {
      const env = new Bash({
        files: {
          "/code.ts":
            "class User {\n  name: string;\n}\nclass Admin extends User {\n}\n"
        }
      });
      const result = await env.exec('grep "^class" /code.ts');
      expect(result.stdout).toBe("class User {\nclass Admin extends User {\n");
    });
  });
});
