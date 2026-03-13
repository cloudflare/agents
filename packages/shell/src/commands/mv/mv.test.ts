import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("mv", () => {
  it("should move file", async () => {
    const env = new Bash({
      files: { "/old.txt": "content" }
    });
    const result = await env.exec("mv /old.txt /new.txt");
    expect(result.exitCode).toBe(0);
    const content = await env.readFile("/new.txt");
    expect(content).toBe("content");
  });

  it("should remove source after move", async () => {
    const env = new Bash({
      files: { "/old.txt": "content" }
    });
    await env.exec("mv /old.txt /new.txt");
    const cat = await env.exec("cat /old.txt");
    expect(cat.exitCode).toBe(1);
  });

  it("should rename file in same directory", async () => {
    const env = new Bash({
      files: { "/dir/oldname.txt": "content" }
    });
    await env.exec("mv /dir/oldname.txt /dir/newname.txt");
    const content = await env.readFile("/dir/newname.txt");
    expect(content).toBe("content");
  });

  it("should move file to directory", async () => {
    const env = new Bash({
      files: {
        "/file.txt": "content",
        "/dir/.keep": ""
      }
    });
    await env.exec("mv /file.txt /dir/");
    const content = await env.readFile("/dir/file.txt");
    expect(content).toBe("content");
  });

  it("should move multiple files to directory", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "aaa",
        "/b.txt": "bbb",
        "/dir/.keep": ""
      }
    });
    await env.exec("mv /a.txt /b.txt /dir");
    expect(await env.readFile("/dir/a.txt")).toBe("aaa");
    expect(await env.readFile("/dir/b.txt")).toBe("bbb");
  });

  it("should error when moving multiple files to non-directory", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "",
        "/b.txt": ""
      }
    });
    const result = await env.exec("mv /a.txt /b.txt /nonexistent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a directory");
  });

  it("should move directory", async () => {
    const env = new Bash({
      files: { "/srcdir/file.txt": "content" }
    });
    await env.exec("mv /srcdir /dstdir");
    const content = await env.readFile("/dstdir/file.txt");
    expect(content).toBe("content");
    const ls = await env.exec("ls /srcdir");
    expect(ls.exitCode).not.toBe(0);
  });

  it("should move nested directories", async () => {
    const env = new Bash({
      files: {
        "/src/a/b/c.txt": "deep",
        "/src/root.txt": "root"
      }
    });
    await env.exec("mv /src /dst");
    expect(await env.readFile("/dst/a/b/c.txt")).toBe("deep");
    expect(await env.readFile("/dst/root.txt")).toBe("root");
  });

  it("should overwrite destination file", async () => {
    const env = new Bash({
      files: {
        "/src.txt": "new",
        "/dst.txt": "old"
      }
    });
    await env.exec("mv /src.txt /dst.txt");
    const content = await env.readFile("/dst.txt");
    expect(content).toBe("new");
  });

  it("should error on missing source", async () => {
    const env = new Bash();
    const result = await env.exec("mv /missing.txt /dst.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "mv: cannot stat '/missing.txt': No such file or directory\n"
    );
  });

  it("should error with missing destination", async () => {
    const env = new Bash({
      files: { "/src.txt": "" }
    });
    const result = await env.exec("mv /src.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("mv: missing destination file operand\n");
  });

  it("should move with relative paths", async () => {
    const env = new Bash({
      files: { "/home/user/old.txt": "content" },
      cwd: "/home/user"
    });
    await env.exec("mv old.txt new.txt");
    const content = await env.readFile("/home/user/new.txt");
    expect(content).toBe("content");
  });

  it("should move directory into existing directory", async () => {
    const env = new Bash({
      files: {
        "/src/file.txt": "content",
        "/dst/.keep": ""
      }
    });
    await env.exec("mv /src /dst/");
    const content = await env.readFile("/dst/src/file.txt");
    expect(content).toBe("content");
  });

  describe("flags", () => {
    it("should accept -f flag (force)", async () => {
      const env = new Bash({
        files: {
          "/src.txt": "new",
          "/dst.txt": "old"
        }
      });
      const result = await env.exec("mv -f /src.txt /dst.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const content = await env.readFile("/dst.txt");
      expect(content).toBe("new");
    });

    it("should skip existing file with -n flag (no-clobber)", async () => {
      const env = new Bash({
        files: {
          "/src.txt": "new",
          "/dst.txt": "old"
        }
      });
      const result = await env.exec("mv -n /src.txt /dst.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      // Source should still exist since move was skipped
      const srcExists = await env.exec("cat /src.txt");
      expect(srcExists.exitCode).toBe(0);
      // Destination should be unchanged
      const content = await env.readFile("/dst.txt");
      expect(content).toBe("old");
    });

    it("should move when destination doesn't exist with -n flag", async () => {
      const env = new Bash({
        files: { "/src.txt": "content" }
      });
      const result = await env.exec("mv -n /src.txt /dst.txt");
      expect(result.exitCode).toBe(0);
      const content = await env.readFile("/dst.txt");
      expect(content).toBe("content");
    });

    it("should show verbose output with -v flag", async () => {
      const env = new Bash({
        files: { "/old.txt": "content" }
      });
      const result = await env.exec("mv -v /old.txt /new.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("renamed '/old.txt' -> '/new.txt'\n");
    });

    it("should handle combined flags -fv", async () => {
      const env = new Bash({
        files: {
          "/src.txt": "new",
          "/dst.txt": "old"
        }
      });
      const result = await env.exec("mv -fv /src.txt /dst.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("renamed '/src.txt' -> '/dst.txt'\n");
    });

    it("should let -n take precedence over -f", async () => {
      const env = new Bash({
        files: {
          "/src.txt": "new",
          "/dst.txt": "old"
        }
      });
      const result = await env.exec("mv -fn /src.txt /dst.txt");
      expect(result.exitCode).toBe(0);
      // Source should still exist (no-clobber took precedence)
      const srcContent = await env.readFile("/src.txt");
      expect(srcContent).toBe("new");
    });

    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("mv --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("mv");
      expect(result.stdout).toContain("--force");
      expect(result.stdout).toContain("--no-clobber");
      expect(result.stdout).toContain("--verbose");
    });

    it("should error on unknown flag", async () => {
      const env = new Bash({
        files: { "/src.txt": "content" }
      });
      const result = await env.exec("mv -x /src.txt /dst.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid option");
    });
  });
});
