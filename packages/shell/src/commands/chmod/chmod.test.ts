import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("chmod command", () => {
  describe("octal mode", () => {
    it("should change file permissions with octal mode", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello" }
      });
      const result = await env.exec("chmod 755 /test.txt");
      expect(result.exitCode).toBe(0);

      // Verify mode changed via stat
      const statResult = await env.exec("stat -c %a /test.txt");
      expect(statResult.stdout.trim()).toBe("755");
    });

    it("should change to read-only mode", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello" }
      });
      await env.exec("chmod 444 /test.txt");

      const statResult = await env.exec("stat -c %a /test.txt");
      expect(statResult.stdout.trim()).toBe("444");
    });
  });

  describe("symbolic mode", () => {
    it("should add execute permission with u+x", async () => {
      const env = new Bash({
        files: { "/script.sh": "#!/bin/bash" }
      });
      // Default mode is 644 (rw-r--r--)
      await env.exec("chmod u+x /script.sh");

      const statResult = await env.exec("stat -c %a /script.sh");
      expect(statResult.stdout.trim()).toBe("744");
    });

    it("should add execute for all with a+x", async () => {
      const env = new Bash({
        files: { "/script.sh": "#!/bin/bash" }
      });
      await env.exec("chmod a+x /script.sh");

      const statResult = await env.exec("stat -c %a /script.sh");
      expect(statResult.stdout.trim()).toBe("755");
    });

    it("should remove write permission with g-w", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello" }
      });
      await env.exec("chmod 664 /test.txt"); // rw-rw-r--
      await env.exec("chmod g-w /test.txt");

      const statResult = await env.exec("stat -c %a /test.txt");
      expect(statResult.stdout.trim()).toBe("644");
    });

    it("should set exact permissions with =", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello" }
      });
      await env.exec("chmod u=rwx /test.txt");

      const statResult = await env.exec("stat -c %a /test.txt");
      expect(statResult.stdout.trim()).toBe("744");
    });
  });

  describe("multiple files", () => {
    it("should change permissions on multiple files", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "a",
          "/b.txt": "b"
        }
      });
      const result = await env.exec("chmod 600 /a.txt /b.txt");
      expect(result.exitCode).toBe(0);

      const statA = await env.exec("stat -c %a /a.txt");
      const statB = await env.exec("stat -c %a /b.txt");
      expect(statA.stdout.trim()).toBe("600");
      expect(statB.stdout.trim()).toBe("600");
    });
  });

  describe("recursive mode", () => {
    it("should change permissions recursively with -R", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "a",
          "/dir/sub/b.txt": "b"
        }
      });
      const result = await env.exec("chmod -R 755 /dir");
      expect(result.exitCode).toBe(0);

      const statA = await env.exec("stat -c %a /dir/a.txt");
      const statB = await env.exec("stat -c %a /dir/sub/b.txt");
      expect(statA.stdout.trim()).toBe("755");
      expect(statB.stdout.trim()).toBe("755");
    });
  });

  describe("error handling", () => {
    it("should error on missing operand", async () => {
      const env = new Bash();
      const result = await env.exec("chmod");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing operand");
    });

    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("chmod 755 /nonexistent");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No such file");
    });

    it("should error on invalid mode", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello" }
      });
      const result = await env.exec("chmod xyz /test.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid mode");
    });

    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("chmod --help");
      expect(result.stdout).toContain("chmod");
      expect(result.stdout).toContain("change file mode");
      expect(result.exitCode).toBe(0);
    });
  });
});
