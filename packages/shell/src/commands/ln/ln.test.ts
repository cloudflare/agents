import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("ln command", () => {
  describe("symbolic links (-s)", () => {
    it("should create a symbolic link", async () => {
      const env = new Bash({
        files: { "/target.txt": "hello world\n" }
      });
      const result = await env.exec("ln -s /target.txt /link.txt");
      expect(result.exitCode).toBe(0);

      // Verify link exists and points to target
      const catResult = await env.exec("cat /link.txt");
      expect(catResult.stdout).toBe("hello world\n");
    });

    it("should create a relative symbolic link", async () => {
      const env = new Bash({
        files: { "/dir/target.txt": "content\n" }
      });
      const result = await env.exec("ln -s target.txt /dir/link.txt");
      expect(result.exitCode).toBe(0);

      const catResult = await env.exec("cat /dir/link.txt");
      expect(catResult.stdout).toBe("content\n");
    });

    it("should allow dangling symlinks", async () => {
      const env = new Bash();
      // ln -s should succeed even if target doesn't exist
      const result = await env.exec("ln -s /nonexistent /link.txt");
      expect(result.exitCode).toBe(0);

      // But trying to read it should fail
      const catResult = await env.exec("cat /link.txt");
      expect(catResult.exitCode).toBe(1);
    });

    it("should error if link already exists", async () => {
      const env = new Bash({
        files: {
          "/target.txt": "hello\n",
          "/link.txt": "existing\n"
        }
      });
      const result = await env.exec("ln -s /target.txt /link.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("File exists");
    });

    it("should overwrite with -f flag", async () => {
      const env = new Bash({
        files: {
          "/target.txt": "new content\n",
          "/link.txt": "old content\n"
        }
      });
      const result = await env.exec("ln -sf /target.txt /link.txt");
      expect(result.exitCode).toBe(0);

      const catResult = await env.exec("cat /link.txt");
      expect(catResult.stdout).toBe("new content\n");
    });
  });

  describe("hard links", () => {
    it("should create a hard link", async () => {
      const env = new Bash({
        files: { "/original.txt": "hello world\n" }
      });
      const result = await env.exec("ln /original.txt /hardlink.txt");
      expect(result.exitCode).toBe(0);

      // Verify both files have same content
      const orig = await env.exec("cat /original.txt");
      const link = await env.exec("cat /hardlink.txt");
      expect(link.stdout).toBe(orig.stdout);
    });

    it("should error when target does not exist", async () => {
      const env = new Bash();
      const result = await env.exec("ln /nonexistent.txt /link.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No such file");
    });

    it("should error when trying to hard link a directory", async () => {
      const env = new Bash({
        files: { "/dir/file.txt": "test\n" }
      });
      const result = await env.exec("ln /dir /dirlink");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not allowed");
    });
  });

  describe("error handling", () => {
    it("should error on missing operand", async () => {
      const env = new Bash();
      const result = await env.exec("ln");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing file operand");
    });

    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("ln --help");
      expect(result.stdout).toContain("ln");
      expect(result.stdout).toContain("link");
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("readlink command", () => {
  it("should read symbolic link target", async () => {
    const env = new Bash({
      files: { "/target.txt": "hello\n" }
    });
    await env.exec("ln -s /target.txt /link.txt");
    const result = await env.exec("readlink /link.txt");
    expect(result.stdout).toBe("/target.txt\n");
    expect(result.exitCode).toBe(0);
  });

  it("should read relative symbolic link target", async () => {
    const env = new Bash({
      files: { "/dir/target.txt": "hello\n" }
    });
    await env.exec("ln -s target.txt /dir/link.txt");
    const result = await env.exec("readlink /dir/link.txt");
    expect(result.stdout).toBe("target.txt\n");
    expect(result.exitCode).toBe(0);
  });

  it("should resolve with -f flag", async () => {
    const env = new Bash({
      files: { "/dir/target.txt": "hello\n" }
    });
    await env.exec("ln -s target.txt /dir/link.txt");
    const result = await env.exec("readlink -f /dir/link.txt");
    expect(result.stdout).toBe("/dir/target.txt\n");
    expect(result.exitCode).toBe(0);
  });

  it("should error on non-symlink without -f", async () => {
    const env = new Bash({
      files: { "/regular.txt": "hello\n" }
    });
    const result = await env.exec("readlink /regular.txt");
    expect(result.exitCode).toBe(1);
  });

  it("should show help with --help", async () => {
    const env = new Bash();
    const result = await env.exec("readlink --help");
    expect(result.stdout).toContain("readlink");
    expect(result.exitCode).toBe(0);
  });
});
