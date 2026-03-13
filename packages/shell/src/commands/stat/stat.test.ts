import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("stat command", () => {
  describe("basic usage", () => {
    it("should display file info", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "hello world"
        }
      });
      const result = await env.exec("stat /test.txt");
      expect(result.stdout).toContain("File: /test.txt");
      expect(result.stdout).toContain("Size: 11");
      expect(result.exitCode).toBe(0);
    });

    it("should display directory info", async () => {
      const env = new Bash({
        files: {
          "/mydir/file.txt": "content"
        }
      });
      const result = await env.exec("stat /mydir");
      expect(result.stdout).toContain("File: /mydir");
      expect(result.stdout).toContain("drwx");
      expect(result.exitCode).toBe(0);
    });

    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("stat /nonexistent");
      expect(result.stderr).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });

    it("should error without operand", async () => {
      const env = new Bash();
      const result = await env.exec("stat");
      expect(result.stderr).toContain("missing operand");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("-c option (format)", () => {
    it("should format with %n (filename)", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello" }
      });
      const result = await env.exec('stat -c "%n" /test.txt');
      expect(result.stdout.trim()).toBe("/test.txt");
    });

    it("should format with %s (size)", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello" }
      });
      const result = await env.exec('stat -c "%s" /test.txt');
      expect(result.stdout.trim()).toBe("5");
    });

    it("should format with %F (file type)", async () => {
      const env = new Bash({
        files: { "/mydir/file.txt": "content" }
      });
      const fileResult = await env.exec('stat -c "%F" /mydir/file.txt');
      expect(fileResult.stdout.trim()).toBe("regular file");

      const dirResult = await env.exec('stat -c "%F" /mydir');
      expect(dirResult.stdout.trim()).toBe("directory");
    });

    it("should format with combined specifiers", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello world" }
      });
      const result = await env.exec('stat -c "%n: %s bytes" /test.txt');
      expect(result.stdout.trim()).toBe("/test.txt: 11 bytes");
    });
  });

  describe("multiple files", () => {
    it("should stat multiple files", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "aaa",
          "/b.txt": "bbbbb"
        }
      });
      const result = await env.exec("stat /a.txt /b.txt");
      expect(result.stdout).toContain("File: /a.txt");
      expect(result.stdout).toContain("File: /b.txt");
    });

    it("should continue on error", async () => {
      const env = new Bash({
        files: { "/exists.txt": "yes" }
      });
      const result = await env.exec("stat /exists.txt /missing.txt");
      expect(result.stdout).toContain("File: /exists.txt");
      expect(result.stderr).toContain("missing.txt");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("help option", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("stat --help");
      expect(result.stdout).toContain("stat");
      expect(result.stdout).toContain("-c");
      expect(result.exitCode).toBe(0);
    });
  });
});
