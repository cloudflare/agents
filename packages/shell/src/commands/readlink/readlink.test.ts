import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("readlink", () => {
  describe("basic usage", () => {
    it("should read symlink target", async () => {
      const env = new Bash();
      await env.exec("echo content > /tmp/target.txt");
      await env.exec("ln -s /tmp/target.txt /tmp/link");
      const result = await env.exec("readlink /tmp/link");
      expect(result.stdout).toBe("/tmp/target.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should read relative symlink target", async () => {
      const env = new Bash();
      await env.exec("echo content > /tmp/target.txt");
      await env.exec("ln -s target.txt /tmp/link");
      const result = await env.exec("readlink /tmp/link");
      expect(result.stdout).toBe("target.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should handle multiple files", async () => {
      const env = new Bash();
      await env.exec("echo a > /tmp/a.txt && echo b > /tmp/b.txt");
      await env.exec("ln -s /tmp/a.txt /tmp/link1");
      await env.exec("ln -s /tmp/b.txt /tmp/link2");
      const result = await env.exec("readlink /tmp/link1 /tmp/link2");
      expect(result.stdout).toBe("/tmp/a.txt\n/tmp/b.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should fail for non-symlink file", async () => {
      const env = new Bash();
      await env.exec("echo content > /tmp/regular.txt");
      const result = await env.exec("readlink /tmp/regular.txt");
      expect(result.exitCode).toBe(1);
    });

    it("should fail for non-existent file", async () => {
      const env = new Bash();
      const result = await env.exec("readlink /tmp/nonexistent");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("-f (canonicalize)", () => {
    it("should canonicalize path through symlinks", async () => {
      const env = new Bash();
      await env.exec("echo content > /tmp/real.txt");
      await env.exec("ln -s /tmp/real.txt /tmp/link1");
      await env.exec("ln -s /tmp/link1 /tmp/link2");
      const result = await env.exec("readlink -f /tmp/link2");
      expect(result.stdout).toBe("/tmp/real.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return path for regular file", async () => {
      const env = new Bash();
      await env.exec("echo content > /tmp/file.txt");
      const result = await env.exec("readlink -f /tmp/file.txt");
      expect(result.stdout).toBe("/tmp/file.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should canonicalize with relative symlink components", async () => {
      const env = new Bash();
      await env.exec("mkdir -p /tmp/dir");
      await env.exec("echo content > /tmp/dir/target.txt");
      await env.exec("ln -s dir/target.txt /tmp/link");
      const result = await env.exec("readlink -f /tmp/link");
      expect(result.stdout).toBe("/tmp/dir/target.txt\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return resolved path for nonexistent file with -f", async () => {
      const env = new Bash();
      const result = await env.exec("readlink -f /tmp/nonexistent");
      expect(result.stdout).toBe("/tmp/nonexistent\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error handling", () => {
    it("should error on missing operand", async () => {
      const env = new Bash();
      const result = await env.exec("readlink");
      expect(result.stderr).toBe("readlink: missing operand\n");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown option", async () => {
      const env = new Bash();
      const result = await env.exec("readlink -x /tmp/link");
      expect(result.stderr).toContain("invalid option");
      expect(result.exitCode).toBe(1);
    });

    it("should handle -- to end options", async () => {
      const env = new Bash();
      await env.exec("ln -s target /tmp/-f");
      const result = await env.exec("readlink -- /tmp/-f");
      expect(result.stdout).toBe("target\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("--help", () => {
    it("should display help", async () => {
      const env = new Bash();
      const result = await env.exec("readlink --help");
      expect(result.stdout).toContain("readlink");
      expect(result.stdout).toContain("-f");
      expect(result.exitCode).toBe(0);
    });
  });
});
