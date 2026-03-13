import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("test command", () => {
  describe("file tests", () => {
    it("-e returns 0 for existing file", async () => {
      const env = new Bash({ files: { "/file.txt": "content" } });
      const result = await env.exec("test -e /file.txt");
      expect(result.exitCode).toBe(0);
    });

    it("-e returns 1 for non-existing file", async () => {
      const env = new Bash();
      const result = await env.exec("test -e /nonexistent");
      expect(result.exitCode).toBe(1);
    });

    it("-f returns 0 for regular file", async () => {
      const env = new Bash({ files: { "/file.txt": "content" } });
      const result = await env.exec("test -f /file.txt");
      expect(result.exitCode).toBe(0);
    });

    it("-f returns 1 for directory", async () => {
      const env = new Bash({ files: { "/dir/file.txt": "content" } });
      const result = await env.exec("test -f /dir");
      expect(result.exitCode).toBe(1);
    });

    it("-d returns 0 for directory", async () => {
      const env = new Bash({ files: { "/dir/file.txt": "content" } });
      const result = await env.exec("test -d /dir");
      expect(result.exitCode).toBe(0);
    });

    it("-d returns 1 for regular file", async () => {
      const env = new Bash({ files: { "/file.txt": "content" } });
      const result = await env.exec("test -d /file.txt");
      expect(result.exitCode).toBe(1);
    });

    it("-s returns 0 for non-empty file", async () => {
      const env = new Bash({ files: { "/file.txt": "content" } });
      const result = await env.exec("test -s /file.txt");
      expect(result.exitCode).toBe(0);
    });

    it("-s returns 1 for empty file", async () => {
      const env = new Bash({ files: { "/empty.txt": "" } });
      const result = await env.exec("test -s /empty.txt");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("string tests", () => {
    it("-z returns 0 for empty string", async () => {
      const env = new Bash();
      const result = await env.exec('test -z ""');
      expect(result.exitCode).toBe(0);
    });

    it("-z returns 1 for non-empty string", async () => {
      const env = new Bash();
      const result = await env.exec('test -z "hello"');
      expect(result.exitCode).toBe(1);
    });

    it("-n returns 0 for non-empty string", async () => {
      const env = new Bash();
      const result = await env.exec('test -n "hello"');
      expect(result.exitCode).toBe(0);
    });

    it("-n returns 1 for empty string", async () => {
      const env = new Bash();
      const result = await env.exec('test -n ""');
      expect(result.exitCode).toBe(1);
    });

    it("= returns 0 for equal strings", async () => {
      const env = new Bash();
      const result = await env.exec('test "abc" = "abc"');
      expect(result.exitCode).toBe(0);
    });

    it("= returns 1 for unequal strings", async () => {
      const env = new Bash();
      const result = await env.exec('test "abc" = "def"');
      expect(result.exitCode).toBe(1);
    });

    it("!= returns 0 for unequal strings", async () => {
      const env = new Bash();
      const result = await env.exec('test "abc" != "def"');
      expect(result.exitCode).toBe(0);
    });

    it("!= returns 1 for equal strings", async () => {
      const env = new Bash();
      const result = await env.exec('test "abc" != "abc"');
      expect(result.exitCode).toBe(1);
    });
  });

  describe("numeric tests", () => {
    it("-eq returns 0 for equal numbers", async () => {
      const env = new Bash();
      const result = await env.exec("test 5 -eq 5");
      expect(result.exitCode).toBe(0);
    });

    it("-eq returns 1 for unequal numbers", async () => {
      const env = new Bash();
      const result = await env.exec("test 5 -eq 6");
      expect(result.exitCode).toBe(1);
    });

    it("-ne returns 0 for unequal numbers", async () => {
      const env = new Bash();
      const result = await env.exec("test 5 -ne 6");
      expect(result.exitCode).toBe(0);
    });

    it("-lt returns 0 when left < right", async () => {
      const env = new Bash();
      const result = await env.exec("test 3 -lt 5");
      expect(result.exitCode).toBe(0);
    });

    it("-lt returns 1 when left >= right", async () => {
      const env = new Bash();
      const result = await env.exec("test 5 -lt 3");
      expect(result.exitCode).toBe(1);
    });

    it("-le returns 0 when left <= right", async () => {
      const env = new Bash();
      const result = await env.exec("test 5 -le 5");
      expect(result.exitCode).toBe(0);
    });

    it("-gt returns 0 when left > right", async () => {
      const env = new Bash();
      const result = await env.exec("test 5 -gt 3");
      expect(result.exitCode).toBe(0);
    });

    it("-ge returns 0 when left >= right", async () => {
      const env = new Bash();
      const result = await env.exec("test 5 -ge 5");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("logical operators", () => {
    it("! negates expression", async () => {
      const env = new Bash();
      const result = await env.exec('test ! -z "hello"');
      expect(result.exitCode).toBe(0);
    });

    it("-a requires both to be true", async () => {
      const env = new Bash({ files: { "/a.txt": "a", "/b.txt": "b" } });
      const result = await env.exec("test -f /a.txt -a -f /b.txt");
      expect(result.exitCode).toBe(0);
    });

    it("-a fails if one is false", async () => {
      const env = new Bash({ files: { "/a.txt": "a" } });
      const result = await env.exec("test -f /a.txt -a -f /nonexistent");
      expect(result.exitCode).toBe(1);
    });

    it("-o succeeds if either is true", async () => {
      const env = new Bash({ files: { "/a.txt": "a" } });
      const result = await env.exec("test -f /nonexistent -o -f /a.txt");
      expect(result.exitCode).toBe(0);
    });

    it("-o fails if both are false", async () => {
      const env = new Bash();
      const result = await env.exec("test -f /a -o -f /b");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("bracket syntax [ ]", () => {
    it("works with closing bracket", async () => {
      const env = new Bash({ files: { "/file.txt": "content" } });
      const result = await env.exec("[ -f /file.txt ]");
      expect(result.exitCode).toBe(0);
    });

    it("fails without closing bracket", async () => {
      const env = new Bash({ files: { "/file.txt": "content" } });
      const result = await env.exec("[ -f /file.txt");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("missing `]'");
    });

    it("works with string comparison", async () => {
      const env = new Bash();
      const result = await env.exec('[ "foo" = "foo" ]');
      expect(result.exitCode).toBe(0);
    });

    it("works with numeric comparison", async () => {
      const env = new Bash();
      const result = await env.exec("[ 10 -gt 5 ]");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("no arguments", () => {
    it("returns 1 with no arguments", async () => {
      const env = new Bash();
      const result = await env.exec("test");
      expect(result.exitCode).toBe(1);
    });

    it("[ ] returns 1 with empty expression", async () => {
      const env = new Bash();
      const result = await env.exec("[ ]");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("single argument", () => {
    it("returns 0 for non-empty string", async () => {
      const env = new Bash();
      const result = await env.exec('test "hello"');
      expect(result.exitCode).toBe(0);
    });

    it("returns 1 for empty string", async () => {
      const env = new Bash();
      const result = await env.exec('test ""');
      expect(result.exitCode).toBe(1);
    });
  });

  describe("conditional execution", () => {
    it("works with && for true condition", async () => {
      const env = new Bash({ files: { "/file.txt": "content" } });
      const result = await env.exec(
        "test -f /file.txt && echo exists || echo missing"
      );
      expect(result.stdout).toBe("exists\n");
    });

    it("works with || for false condition", async () => {
      const env = new Bash();
      const result = await env.exec(
        "test -f /nonexistent && echo exists || echo missing"
      );
      expect(result.stdout).toBe("missing\n");
    });

    it("[ ] works with && and ||", async () => {
      const env = new Bash({ files: { "/dir/file": "x" } });
      const result = await env.exec("[ -d /dir ] && echo is_dir || echo not");
      expect(result.stdout).toBe("is_dir\n");
    });
  });
});
