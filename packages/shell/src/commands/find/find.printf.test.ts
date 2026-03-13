import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("find -printf", () => {
  describe("basic directives", () => {
    it("should format with %f (filename)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "aaa",
          "/dir/b.txt": "bbb"
        }
      });
      const result = await env.exec(
        'find /dir -type f -name "*.txt" -printf "%f\\n"'
      );
      expect(result.stdout).toBe("a.txt\nb.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %p (full path)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "aaa"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%p\\n"');
      expect(result.stdout).toBe("/dir/a.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %h (dirname)", async () => {
      const env = new Bash({
        files: {
          "/dir/sub/file.txt": "content"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%h\\n"');
      expect(result.stdout).toBe("/dir/sub\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %s (size)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "hello"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%f %s\\n"');
      expect(result.stdout).toBe("a.txt 5\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %d (depth)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/sub/b.txt": "b",
          "/dir/sub/deep/c.txt": "c"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%d %f\\n"');
      expect(result.stdout).toBe("1 a.txt\n2 b.txt\n3 c.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %m (octal mode)", async () => {
      const env = new Bash({
        files: {
          "/dir/exec.sh": { content: "#!/bin/bash", mode: 0o755 },
          "/dir/file.txt": { content: "text", mode: 0o644 }
        }
      });
      const result = await env.exec('find /dir -type f -printf "%f %m\\n"');
      expect(result.stdout).toBe("exec.sh 755\nfile.txt 644\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %M (symbolic mode)", async () => {
      const env = new Bash({
        files: {
          "/dir/exec.sh": { content: "#!/bin/bash", mode: 0o755 }
        }
      });
      const result = await env.exec('find /dir -type f -printf "%M %f\\n"');
      expect(result.stdout).toBe("-rwxr-xr-x exec.sh\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %P (path without starting point)", async () => {
      const env = new Bash({
        files: {
          "/dir/sub/file.txt": "content"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%P\\n"');
      expect(result.stdout).toBe("sub/file.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %% (literal percent)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec(
        'find /dir -type f -printf "100%% done\\n"'
      );
      expect(result.stdout).toBe("100% done\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple format directives", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": "hello"
        }
      });
      const result = await env.exec(
        'find /dir -type f -printf "%f: %s bytes at %p\\n"'
      );
      expect(result.stdout).toBe("file.txt: 5 bytes at /dir/file.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format directories with %M showing d prefix", async () => {
      const env = new Bash({
        files: {
          "/dir/sub/file.txt": "content"
        }
      });
      const result = await env.exec('find /dir -type d -printf "%M %f\\n"');
      expect(result.stdout).toBe("drwxr-xr-x dir\ndrwxr-xr-x sub\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("width modifiers", () => {
    it("should right-justify with width (%10f)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "[%10f]\\n"');
      expect(result.stdout).toBe("[     a.txt]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should left-justify with negative width (%-10f)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "[%-10f]\\n"');
      expect(result.stdout).toBe("[a.txt     ]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should truncate with precision (%.3f)", async () => {
      const env = new Bash({
        files: {
          "/dir/longfilename.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "[%.3f]\\n"');
      expect(result.stdout).toBe("[lon]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should combine width and precision (%-10.5f)", async () => {
      const env = new Bash({
        files: {
          "/dir/longfilename.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "[%-10.5f]\\n"');
      expect(result.stdout).toBe("[longf     ]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should apply width to %s (size)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "hello"
        }
      });
      const result = await env.exec('find /dir -type f -printf "[%10s]\\n"');
      expect(result.stdout).toBe("[         5]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should apply width to %d (depth)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "[%5d]\\n"');
      expect(result.stdout).toBe("[    1]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should apply width to %m (mode)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": { content: "a", mode: 0o644 }
        }
      });
      const result = await env.exec('find /dir -type f -printf "[%5m]\\n"');
      expect(result.stdout).toBe("[  644]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should apply width to %M (symbolic mode)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": { content: "a", mode: 0o644 }
        }
      });
      const result = await env.exec('find /dir -type f -printf "[%15M]\\n"');
      // -rw-r--r-- is 10 chars, width 15 means 5 spaces prefix
      expect(result.stdout).toBe("[     -rw-r--r--]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should apply width to %p (path)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "[%-20p]\\n"');
      // /dir/a.txt is 10 chars, width 20 means 10 spaces after (left-justified)
      expect(result.stdout).toBe("[/dir/a.txt          ]\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("escape sequences", () => {
    it("should handle \\n (newline)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/b.txt": "b"
        }
      });
      const result = await env.exec(
        'find /dir -type f -name "*.txt" -printf "%f\\n"'
      );
      expect(result.stdout).toBe("a.txt\nb.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle \\t (tab)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "hello"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%f\\t%s\\n"');
      expect(result.stdout).toBe("a.txt\t5\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle \\\\ (backslash)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      // To get a literal backslash in output, we need \\\\ in bash double quotes
      // which becomes \\ after shell parsing, which processEscapes turns into \
      const result = await env.exec(
        'find /dir -type f -printf "%f\\\\\\\\\\n"'
      );
      expect(result.stdout).toBe("a.txt\\\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle \\0 in format (NUL character)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/b.txt": "b"
        }
      });
      const result = await env.exec(
        'find /dir -type f -name "*.txt" -printf "%f\\0"'
      );
      expect(result.stdout).toBe("a.txt\0b.txt\0");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle \\e escape for ANSI colors", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec(
        'find /dir -type f -printf "\\e[32m%f\\e[0m\\n"'
      );
      expect(result.stdout).toBe("\x1b[32ma.txt\x1b[0m\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle \\u unicode escape", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec(
        'find /dir -type f -printf "\\u2714 %f\\n"'
      );
      expect(result.stdout).toBe("✔ a.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle \\U unicode escape for emoji", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec(
        'find /dir -type f -printf "\\U1F4C4 %f\\n"'
      );
      expect(result.stdout).toBe("📄 a.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("time directives", () => {
    it("should format with %T@ (epoch seconds)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%T@\\n"');
      // Should be a number (epoch timestamp)
      expect(result.stdout).toMatch(/^\d+(\.\d+)?\n$/);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %TY (year)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%TY\\n"');
      // Should be a 4-digit year
      expect(result.stdout).toMatch(/^\d{4}\n$/);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %Tm (month)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%Tm\\n"');
      // Should be 01-12
      expect(result.stdout).toMatch(/^(0[1-9]|1[0-2])\n$/);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %Td (day)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%Td\\n"');
      // Should be 01-31
      expect(result.stdout).toMatch(/^(0[1-9]|[12][0-9]|3[01])\n$/);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %TH:%TM:%TS (time)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec(
        'find /dir -type f -printf "%TH:%TM:%TS\\n"'
      );
      // Should be HH:MM:SS format
      expect(result.stdout).toMatch(/^\d{2}:\d{2}:\d{2}\n$/);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %TT (time as HH:MM:SS)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%TT\\n"');
      expect(result.stdout).toMatch(/^\d{2}:\d{2}:\d{2}\n$/);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %TF (date as YYYY-MM-DD)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%TF\\n"');
      expect(result.stdout).toMatch(/^\d{4}-\d{2}-\d{2}\n$/);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should format with %t (ctime format)", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a"
        }
      });
      const result = await env.exec('find /dir -type f -printf "%t\\n"');
      // Should match ctime format: "Wed Dec 25 12:34:56 2024"
      expect(result.stdout).toMatch(
        /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-3]\d \d{2}:\d{2}:\d{2} \d{4}\n$/
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("combined with other predicates", () => {
    it("should work with -name filter", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "aaa",
          "/dir/b.md": "bbb",
          "/dir/c.txt": "ccc"
        }
      });
      const result = await env.exec(
        'find /dir -type f -name "*.txt" -printf "%f\\n"'
      );
      expect(result.stdout).toBe("a.txt\nc.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -size filter", async () => {
      const env = new Bash({
        files: {
          "/dir/small.txt": "a",
          "/dir/large.txt": "aaaaaaaaaa"
        }
      });
      const result = await env.exec(
        'find /dir -type f -size +5c -printf "%f: %s bytes\\n"'
      );
      expect(result.stdout).toBe("large.txt: 10 bytes\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should work with -maxdepth", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/sub/b.txt": "b",
          "/dir/sub/deep/c.txt": "c"
        }
      });
      const result = await env.exec(
        'find /dir -maxdepth 2 -type f -printf "%f\\n"'
      );
      expect(result.stdout).toBe("a.txt\nb.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });
});
