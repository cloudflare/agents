import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("mkdir", () => {
  it("should create directory", async () => {
    const env = new Bash({ cwd: "/" });
    const result = await env.exec("mkdir /newdir");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const ls = await env.exec("ls /");
    // /bin, /usr, /dev, /proc always exist
    expect(ls.stdout).toBe("bin\ndev\nnewdir\nproc\nusr\n");
  });

  it("should create multiple directories", async () => {
    const env = new Bash({ cwd: "/" });
    await env.exec("mkdir /dir1 /dir2 /dir3");
    const ls = await env.exec("ls /");
    // /bin, /usr, /dev, /proc always exist
    expect(ls.stdout).toBe("bin\ndev\ndir1\ndir2\ndir3\nproc\nusr\n");
  });

  it("should create nested directories with -p", async () => {
    const env = new Bash();
    const result = await env.exec("mkdir -p /a/b/c");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const ls = await env.exec("ls /a/b");
    expect(ls.stdout).toBe("c\n");
  });

  it("should create deeply nested directories with -p", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /one/two/three/four/five");
    const ls = await env.exec("ls /one/two/three/four");
    expect(ls.stdout).toBe("five\n");
  });

  it("should create nested directories with --parents", async () => {
    const env = new Bash();
    await env.exec("mkdir --parents /x/y/z");
    const ls = await env.exec("ls /x/y");
    expect(ls.stdout).toBe("z\n");
  });

  it("should fail without -p for nested dirs", async () => {
    const env = new Bash();
    const result = await env.exec("mkdir /a/b/c");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "mkdir: cannot create directory '/a/b/c': No such file or directory\n"
    );
    expect(result.exitCode).toBe(1);
  });

  it("should not error if directory exists with -p", async () => {
    const env = new Bash({
      files: { "/existing/file.txt": "" }
    });
    const result = await env.exec("mkdir -p /existing");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should error if file exists at path", async () => {
    const env = new Bash({
      files: { "/file": "content" }
    });
    const result = await env.exec("mkdir /file");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });

  it("should error with no arguments", async () => {
    const env = new Bash();
    const result = await env.exec("mkdir");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("mkdir: missing operand\n");
    expect(result.exitCode).toBe(1);
  });

  it("should create directory with relative path", async () => {
    const env = new Bash({
      files: { "/home/user/.keep": "" },
      cwd: "/home/user"
    });
    await env.exec("mkdir projects");
    const ls = await env.exec("ls /home/user");
    expect(ls.stdout).toBe("projects\n");
  });

  it("should create multiple nested paths with -p", async () => {
    const env = new Bash();
    await env.exec("mkdir -p /a/b /c/d");
    const lsA = await env.exec("ls /a");
    const lsC = await env.exec("ls /c");
    expect(lsA.stdout).toBe("b\n");
    expect(lsC.stdout).toBe("d\n");
  });
});
