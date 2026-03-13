import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("cat", () => {
  it("should read file contents", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello world" }
    });
    const result = await env.exec("cat /test.txt");
    expect(result.stdout).toBe("hello world");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should read file with newline at end", async () => {
    const env = new Bash({
      files: { "/test.txt": "hello world\n" }
    });
    const result = await env.exec("cat /test.txt");
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("");
  });

  it("should concatenate multiple files", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "aaa\n",
        "/b.txt": "bbb\n"
      }
    });
    const result = await env.exec("cat /a.txt /b.txt");
    expect(result.stdout).toBe("aaa\nbbb\n");
    expect(result.stderr).toBe("");
  });

  it("should concatenate three files", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "A",
        "/b.txt": "B",
        "/c.txt": "C"
      }
    });
    const result = await env.exec("cat /a.txt /b.txt /c.txt");
    expect(result.stdout).toBe("ABC");
    expect(result.stderr).toBe("");
  });

  it("should show line numbers with -n", async () => {
    const env = new Bash({
      files: { "/test.txt": "line1\nline2\nline3\n" }
    });
    const result = await env.exec("cat -n /test.txt");
    expect(result.stdout).toBe("     1\tline1\n     2\tline2\n     3\tline3\n");
    expect(result.stderr).toBe("");
  });

  it("should show padded line numbers", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\n" }
    });
    const result = await env.exec("cat -n /test.txt");
    expect(result.stdout).toBe("     1\ta\n");
    expect(result.stderr).toBe("");
  });

  it("should error on missing file", async () => {
    const env = new Bash();
    const result = await env.exec("cat /missing.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "cat: /missing.txt: No such file or directory\n"
    );
    expect(result.exitCode).toBe(1);
  });

  it("should continue after missing file with other files", async () => {
    const env = new Bash({
      files: { "/exists.txt": "content" }
    });
    const result = await env.exec("cat /missing.txt /exists.txt");
    expect(result.stdout).toBe("content");
    expect(result.stderr).toBe(
      "cat: /missing.txt: No such file or directory\n"
    );
    expect(result.exitCode).toBe(1);
  });

  it("should read from stdin when no file specified", async () => {
    const env = new Bash();
    const result = await env.exec('echo "hello" | cat');
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
  });

  it("should read empty file", async () => {
    const env = new Bash({
      files: { "/empty.txt": "" }
    });
    const result = await env.exec("cat /empty.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle file with special characters", async () => {
    const env = new Bash({
      files: { "/special.txt": "tab:\there\nnewline above" }
    });
    const result = await env.exec("cat /special.txt");
    expect(result.stdout).toBe("tab:\there\nnewline above");
    expect(result.stderr).toBe("");
  });

  it("should handle relative paths", async () => {
    const env = new Bash({
      files: { "/home/user/file.txt": "content" },
      cwd: "/home/user"
    });
    const result = await env.exec("cat file.txt");
    expect(result.stdout).toBe("content");
    expect(result.stderr).toBe("");
  });

  it("should show line numbers from stdin with -n", async () => {
    const env = new Bash();
    const result = await env.exec('echo -e "a\\nb\\nc" | cat -n');
    expect(result.stdout).toBe("     1\ta\n     2\tb\n     3\tc\n");
    expect(result.stderr).toBe("");
  });

  describe("stdin placeholder (-)", () => {
    it("should read stdin when - is specified", async () => {
      const env = new Bash();
      const result = await env.exec('echo "from stdin" | cat -');
      expect(result.stdout).toBe("from stdin\n");
      expect(result.stderr).toBe("");
    });

    it("should combine stdin with file", async () => {
      const env = new Bash({
        files: { "/file.txt": "from file\n" },
        cwd: "/"
      });
      const result = await env.exec('echo "from stdin" | cat - /file.txt');
      expect(result.stdout).toBe("from stdin\nfrom file\n");
      expect(result.stderr).toBe("");
    });

    it("should combine file with stdin", async () => {
      const env = new Bash({
        files: { "/file.txt": "from file\n" },
        cwd: "/"
      });
      const result = await env.exec('echo "from stdin" | cat /file.txt -');
      expect(result.stdout).toBe("from file\nfrom stdin\n");
      expect(result.stderr).toBe("");
    });

    it("should handle stdin placeholder with line numbers", async () => {
      const env = new Bash({
        files: { "/file.txt": "line1\n" },
        cwd: "/"
      });
      const result = await env.exec('echo "line2" | cat -n /file.txt -');
      // Linux bash continues line numbers across input sources
      expect(result.stdout).toBe("     1\tline1\n     2\tline2\n");
      expect(result.stderr).toBe("");
    });
  });
});
