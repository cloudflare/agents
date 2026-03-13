import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("paste command", () => {
  const createEnv = () =>
    new Bash({
      files: {
        "/test/file1.txt": "a\nb\nc\n",
        "/test/file2.txt": "1\n2\n3\n",
        "/test/file3.txt": "x\ny\nz\n",
        "/test/uneven1.txt": "a\nb\n",
        "/test/uneven2.txt": "1\n2\n3\n4\n",
        "/test/single.txt": "hello\nworld\n",
        "/test/empty.txt": ""
      },
      cwd: "/test"
    });

  describe("basic functionality", () => {
    it("should paste two files side by side with tab delimiter", async () => {
      const env = createEnv();
      const result = await env.exec("paste file1.txt file2.txt");
      expect(result.stdout).toBe("a\t1\nb\t2\nc\t3\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should paste three files side by side", async () => {
      const env = createEnv();
      const result = await env.exec("paste file1.txt file2.txt file3.txt");
      expect(result.stdout).toBe("a\t1\tx\nb\t2\ty\nc\t3\tz\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle files with uneven line counts", async () => {
      const env = createEnv();
      const result = await env.exec("paste uneven1.txt uneven2.txt");
      expect(result.stdout).toBe("a\t1\nb\t2\n\t3\n\t4\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle single file", async () => {
      const env = createEnv();
      const result = await env.exec("paste file1.txt");
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-d (delimiter)", () => {
    it("should use custom delimiter", async () => {
      const env = createEnv();
      const result = await env.exec("paste -d, file1.txt file2.txt");
      expect(result.stdout).toBe("a,1\nb,2\nc,3\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should use space as delimiter", async () => {
      const env = createEnv();
      const result = await env.exec('paste -d" " file1.txt file2.txt');
      expect(result.stdout).toBe("a 1\nb 2\nc 3\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should use colon as delimiter", async () => {
      const env = createEnv();
      const result = await env.exec("paste -d: file1.txt file2.txt");
      expect(result.stdout).toBe("a:1\nb:2\nc:3\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should cycle through multiple delimiters", async () => {
      const env = createEnv();
      const result = await env.exec("paste -d,: file1.txt file2.txt file3.txt");
      expect(result.stdout).toBe("a,1:x\nb,2:y\nc,3:z\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle -d with space separator", async () => {
      const env = createEnv();
      const result = await env.exec("paste -d , file1.txt file2.txt");
      expect(result.stdout).toBe("a,1\nb,2\nc,3\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-s (serial)", () => {
    it("should paste lines horizontally in serial mode", async () => {
      const env = createEnv();
      const result = await env.exec("paste -s file1.txt");
      expect(result.stdout).toBe("a\tb\tc\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should paste multiple files serially", async () => {
      const env = createEnv();
      const result = await env.exec("paste -s file1.txt file2.txt");
      expect(result.stdout).toBe("a\tb\tc\n1\t2\t3\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should use custom delimiter in serial mode", async () => {
      const env = createEnv();
      const result = await env.exec("paste -s -d, file1.txt");
      expect(result.stdout).toBe("a,b,c\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle combined -sd option", async () => {
      const env = createEnv();
      const result = await env.exec("paste -sd, file1.txt");
      expect(result.stdout).toBe("a,b,c\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("stdin", () => {
    it("should error when no files specified", async () => {
      const env = createEnv();
      const result = await env.exec("echo -e 'a\\nb\\nc' | paste");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "usage: paste [-s] [-d delimiters] file ...\n"
      );
      expect(result.exitCode).toBe(1);
    });

    it("should read from stdin with explicit -", async () => {
      const env = createEnv();
      const result = await env.exec("echo -e 'a\\nb\\nc' | paste -");
      expect(result.stdout).toBe("a\nb\nc\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should paste stdin with file", async () => {
      const env = createEnv();
      const result = await env.exec("echo -e 'x\\ny\\nz' | paste - file1.txt");
      expect(result.stdout).toBe("x\ta\ny\tb\nz\tc\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should handle - - to paste pairs of lines", async () => {
      const env = createEnv();
      const result = await env.exec("echo -e 'a\\nb\\nc\\nd' | paste - -");
      expect(result.stdout).toBe("a\tb\nc\td\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("should handle empty file", async () => {
      const env = createEnv();
      const result = await env.exec("paste empty.txt file1.txt");
      expect(result.stdout).toBe("\ta\n\tb\n\tc\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should return error for non-existent file", async () => {
      const env = createEnv();
      const result = await env.exec("paste nonexistent.txt");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "paste: nonexistent.txt: No such file or directory\n"
      );
      expect(result.exitCode).toBe(1);
    });

    it("should return error for unknown option", async () => {
      const env = createEnv();
      const result = await env.exec("paste -x file1.txt");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("paste: invalid option -- 'x'\n");
      expect(result.exitCode).toBe(1);
    });

    it("should return error for unknown long option", async () => {
      const env = createEnv();
      const result = await env.exec("paste --unknown file1.txt");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("paste: unrecognized option '--unknown'\n");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("--help", () => {
    it("should show help", async () => {
      const env = createEnv();
      const result = await env.exec("paste --help");
      expect(result.stdout).toContain("paste - merge lines of files");
      expect(result.stdout).toContain("Usage:");
      expect(result.stdout).toContain("-d, --delimiters");
      expect(result.stdout).toContain("-s, --serial");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });
});
