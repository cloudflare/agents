import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("cp", () => {
  it("should copy file", async () => {
    const env = new Bash({
      files: { "/src.txt": "content" }
    });
    const result = await env.exec("cp /src.txt /dst.txt");
    expect(result.exitCode).toBe(0);
    const content = await env.readFile("/dst.txt");
    expect(content).toBe("content");
  });

  it("should preserve original file", async () => {
    const env = new Bash({
      files: { "/src.txt": "content" }
    });
    await env.exec("cp /src.txt /dst.txt");
    const srcContent = await env.readFile("/src.txt");
    expect(srcContent).toBe("content");
  });

  it("should overwrite existing destination", async () => {
    const env = new Bash({
      files: {
        "/src.txt": "new content",
        "/dst.txt": "old content"
      }
    });
    await env.exec("cp /src.txt /dst.txt");
    const content = await env.readFile("/dst.txt");
    expect(content).toBe("new content");
  });

  it("should copy to directory", async () => {
    const env = new Bash({
      files: {
        "/src.txt": "content",
        "/dir/.keep": ""
      }
    });
    await env.exec("cp /src.txt /dir/");
    const content = await env.readFile("/dir/src.txt");
    expect(content).toBe("content");
  });

  it("should copy multiple files to directory", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "aaa",
        "/b.txt": "bbb",
        "/dir/.keep": ""
      }
    });
    await env.exec("cp /a.txt /b.txt /dir");
    expect(await env.readFile("/dir/a.txt")).toBe("aaa");
    expect(await env.readFile("/dir/b.txt")).toBe("bbb");
  });

  it("should error when copying multiple files to non-directory", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "",
        "/b.txt": ""
      }
    });
    const result = await env.exec("cp /a.txt /b.txt /nonexistent");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a directory");
  });

  it("should error when copying directory without -r", async () => {
    const env = new Bash({
      files: { "/srcdir/file.txt": "content" }
    });
    const result = await env.exec("cp /srcdir /dstdir");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("omitting directory");
  });

  it("should copy directory with -r", async () => {
    const env = new Bash({
      files: { "/srcdir/file.txt": "content" }
    });
    const result = await env.exec("cp -r /srcdir /dstdir");
    expect(result.exitCode).toBe(0);
    const content = await env.readFile("/dstdir/file.txt");
    expect(content).toBe("content");
  });

  it("should copy directory with -R", async () => {
    const env = new Bash({
      files: { "/srcdir/file.txt": "content" }
    });
    await env.exec("cp -R /srcdir /dstdir");
    const content = await env.readFile("/dstdir/file.txt");
    expect(content).toBe("content");
  });

  it("should copy nested directories with -r", async () => {
    const env = new Bash({
      files: {
        "/src/a/b/c.txt": "deep",
        "/src/root.txt": "root"
      }
    });
    await env.exec("cp -r /src /dst");
    expect(await env.readFile("/dst/a/b/c.txt")).toBe("deep");
    expect(await env.readFile("/dst/root.txt")).toBe("root");
  });

  it("should copy with --recursive flag", async () => {
    const env = new Bash({
      files: { "/srcdir/file.txt": "content" }
    });
    await env.exec("cp --recursive /srcdir /dstdir");
    const content = await env.readFile("/dstdir/file.txt");
    expect(content).toBe("content");
  });

  it("should error on missing source", async () => {
    const env = new Bash();
    const result = await env.exec("cp /missing.txt /dst.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "cp: cannot stat '/missing.txt': No such file or directory\n"
    );
  });

  it("should error with missing destination", async () => {
    const env = new Bash({
      files: { "/src.txt": "" }
    });
    const result = await env.exec("cp /src.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("cp: missing destination file operand\n");
  });

  it("should copy with relative paths", async () => {
    const env = new Bash({
      files: { "/home/user/src.txt": "content" },
      cwd: "/home/user"
    });
    await env.exec("cp src.txt dst.txt");
    const content = await env.readFile("/home/user/dst.txt");
    expect(content).toBe("content");
  });
});
