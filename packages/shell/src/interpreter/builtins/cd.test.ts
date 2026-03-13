import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("cd builtin", () => {
  describe("basic cd", () => {
    it("should change to specified directory", async () => {
      const env = new Bash();
      await env.exec("mkdir -p /tmp/testdir");
      const result = await env.exec(`
        cd /tmp/testdir
        pwd
      `);
      expect(result.stdout).toBe("/tmp/testdir\n");
    });

    it("should change to home directory without argument", async () => {
      const env = new Bash({ env: { HOME: "/tmp" } });
      const result = await env.exec(`
        cd
        pwd
      `);
      expect(result.stdout).toBe("/tmp\n");
    });

    it("should update PWD environment variable", async () => {
      const env = new Bash();
      await env.exec("mkdir -p /tmp/pwdtest");
      const result = await env.exec(`
        cd /tmp/pwdtest
        echo $PWD
      `);
      expect(result.stdout).toBe("/tmp/pwdtest\n");
    });

    it("should update OLDPWD environment variable", async () => {
      const env = new Bash();
      await env.exec("mkdir -p /tmp/dir1 /tmp/dir2");
      const result = await env.exec(`
        cd /tmp/dir1
        cd /tmp/dir2
        echo $OLDPWD
      `);
      expect(result.stdout).toBe("/tmp/dir1\n");
    });
  });

  describe("cd with special paths", () => {
    it("should handle cd -", async () => {
      const env = new Bash();
      await env.exec("mkdir -p /tmp/orig /tmp/new");
      const result = await env.exec(`
        cd /tmp/orig
        cd /tmp/new
        cd -
        pwd
      `);
      expect(result.stdout).toContain("/tmp/orig");
    });

    it("should handle cd with ..", async () => {
      const env = new Bash();
      await env.exec("mkdir -p /tmp/parent/child");
      const result = await env.exec(`
        cd /tmp/parent/child
        cd ..
        pwd
      `);
      expect(result.stdout).toBe("/tmp/parent\n");
    });

    it("should handle cd with absolute path", async () => {
      const env = new Bash();
      const result = await env.exec(`
        cd /tmp
        pwd
      `);
      expect(result.stdout).toBe("/tmp\n");
    });
  });

  describe("virtual isolation", () => {
    it("should not change real process.cwd() when cd is executed", async () => {
      const realCwd = process.cwd();
      const env = new Bash();
      await env.exec("cd /tmp");
      expect(process.cwd()).toBe(realCwd);
    });
  });

  describe("error cases", () => {
    it("should error on non-existent directory", async () => {
      const env = new Bash();
      const result = await env.exec("cd /nonexistent/directory");
      expect(result.stderr).toContain("No such file or directory");
      expect(result.exitCode).toBe(1);
    });

    it("should error when cd to a file", async () => {
      const env = new Bash();
      await env.exec("touch /tmp/testfile");
      const result = await env.exec("cd /tmp/testfile");
      expect(result.stderr).toContain("Not a directory");
      expect(result.exitCode).toBe(1);
    });
  });
});
