import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("split", () => {
  describe("basic functionality", () => {
    it("splits file into 1000-line chunks by default", async () => {
      // Create a file with 2500 lines
      const lines =
        Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n") +
        "\n";
      const bash = new Bash({
        files: {
          "/test.txt": lines
        }
      });
      const result = await bash.exec("split /test.txt && ls -1 x*");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("xaa");
      expect(result.stdout).toContain("xab");
      expect(result.stdout).toContain("xac");
    });

    it("uses x as default prefix", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "line1\nline2\nline3\n"
        }
      });
      const result = await bash.exec("split -l 1 /test.txt && ls -1 x*");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("xaa");
      expect(result.stdout).toContain("xab");
      expect(result.stdout).toContain("xac");
    });

    it("uses custom prefix", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "line1\nline2\nline3\n"
        }
      });
      const result = await bash.exec(
        "split -l 1 /test.txt part_ && ls -1 part_*"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("part_aa");
      expect(result.stdout).toContain("part_ab");
      expect(result.stdout).toContain("part_ac");
    });

    it("reads from stdin when no file specified", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf 'a\\nb\\nc\\n' | split -l 1");
      expect(result.exitCode).toBe(0);
      const content = await bash.readFile("xaa");
      expect(content).toBe("a\n");
    });

    it("handles empty input", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf '' | split");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-l option", () => {
    it("splits by specified number of lines", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "1\n2\n3\n4\n5\n"
        }
      });
      const result = await bash.exec(
        "split -l 2 /test.txt && cat xaa && cat xab && cat xac"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("1\n2\n");
      expect(result.stdout).toContain("3\n4\n");
      expect(result.stdout).toContain("5\n");
    });

    it("supports -lN attached form", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "1\n2\n3\n4\n"
        }
      });
      const result = await bash.exec("split -l2 /test.txt && cat xaa");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("1\n2\n");
    });

    it("errors on invalid line count", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | split -l abc");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid number of lines");
    });

    it("errors on zero line count", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | split -l 0");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid number of lines");
    });
  });

  describe("-b option", () => {
    it("splits by specified number of bytes", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "abcdefghij"
        }
      });
      const result = await bash.exec(
        "split -b 4 /test.txt && cat xaa && echo '---' && cat xab && echo '---' && cat xac"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("abcd");
      expect(result.stdout).toContain("efgh");
      expect(result.stdout).toContain("ij");
    });

    it("supports K suffix for kilobytes", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "a".repeat(2048)
        }
      });
      const result = await bash.exec("split -b 1K /test.txt && wc -c xaa");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/1024/);
    });

    it("supports M suffix for megabytes", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "a".repeat(100)
        }
      });
      // File is smaller than 1M, so it should all be in one chunk
      const result = await bash.exec("split -b 1M /test.txt && ls x* | wc -l");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("1");
    });

    it("supports attached form -bSIZE", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "abcdefghij"
        }
      });
      const result = await bash.exec("split -b5 /test.txt && cat xaa");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("abcde");
    });

    it("errors on invalid byte size", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | split -b xyz");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid number of bytes");
    });
  });

  describe("-n option", () => {
    it("splits into specified number of chunks", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "abcdefghij"
        }
      });
      const result = await bash.exec(
        "split -n 2 /test.txt && cat xaa && echo '---' && cat xab"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("abcde");
      expect(result.stdout).toContain("fghij");
    });

    it("handles uneven division", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "abcdefg"
        }
      });
      const result = await bash.exec("split -n 3 /test.txt uneven_");
      expect(result.exitCode).toBe(0);
      // Check that 3 files were created
      const aa = await bash.readFile("uneven_aa");
      const ab = await bash.readFile("uneven_ab");
      const ac = await bash.readFile("uneven_ac");
      expect(aa).toBeDefined();
      expect(ab).toBeDefined();
      expect(ac).toBeDefined();
      // Verify content is distributed
      expect(aa + ab + ac).toBe("abcdefg");
    });

    it("supports attached form -nCHUNKS", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "abcd"
        }
      });
      const result = await bash.exec("split -n2 /test.txt && cat xaa");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ab");
    });

    it("errors on invalid chunk count", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | split -n abc");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid number of chunks");
    });
  });

  describe("-d option", () => {
    it("uses numeric suffixes", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "1\n2\n3\n"
        }
      });
      const result = await bash.exec("split -d -l 1 /test.txt && ls -1 x*");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("x00");
      expect(result.stdout).toContain("x01");
      expect(result.stdout).toContain("x02");
    });

    it("works with --numeric-suffixes", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "a\nb\n"
        }
      });
      const result = await bash.exec(
        "split --numeric-suffixes -l 1 /test.txt && ls -1 x*"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("x00");
      expect(result.stdout).toContain("x01");
    });
  });

  describe("-a option", () => {
    it("changes suffix length", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "1\n2\n"
        }
      });
      const result = await bash.exec("split -a 3 -l 1 /test.txt && ls -1 x*");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("xaaa");
      expect(result.stdout).toContain("xaab");
    });

    it("works with numeric suffixes", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "1\n2\n"
        }
      });
      const result = await bash.exec(
        "split -a 3 -d -l 1 /test.txt && ls -1 x*"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("x000");
      expect(result.stdout).toContain("x001");
    });

    it("supports attached form -aLENGTH", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "1\n2\n"
        }
      });
      const result = await bash.exec("split -a4 -l 1 /test.txt && ls -1 x*");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("xaaaa");
    });

    it("errors on invalid suffix length", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | split -a 0");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid suffix length");
    });
  });

  describe("--additional-suffix option", () => {
    it("appends suffix to filenames", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "1\n2\n"
        }
      });
      const result = await bash.exec(
        "split --additional-suffix=.txt -l 1 /test.txt && ls -1 x*.txt"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("xaa.txt");
      expect(result.stdout).toContain("xab.txt");
    });
  });

  describe("edge cases", () => {
    it("handles -- to end options", async () => {
      const bash = new Bash({
        files: {
          "/-test": "content\n"
        }
      });
      const result = await bash.exec("split -l 1 -- /-test && cat xaa");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("content\n");
    });

    it("handles file with no trailing newline", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "line1\nline2"
        }
      });
      const result = await bash.exec("split -l 1 /test.txt && cat xab");
      expect(result.exitCode).toBe(0);
      // Last chunk preserves original trailing newline behavior (no newline)
      expect(result.stdout).toBe("line2");
    });
  });

  describe("error handling", () => {
    it("errors on unknown flag", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | split -z");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid option");
    });

    it("errors on unknown long flag", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | split --unknown");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unrecognized option");
    });

    it("errors on missing file", async () => {
      const bash = new Bash();
      const result = await bash.exec("split /nonexistent");
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain(
        "no such file or directory"
      );
    });

    it("shows help with --help", async () => {
      const bash = new Bash();
      const result = await bash.exec("split --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("split");
      expect(result.stdout).toContain("Usage");
    });
  });

  describe("security limits", () => {
    it("should reject excessive chunk count", async () => {
      const bash = new Bash({
        files: { "/test.txt": "hello\n" }
      });
      const result = await bash.exec("split -n 200000 /test.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("too many output files");
    });
  });
});
