import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("tail", () => {
  it("should show last 10 lines by default", async () => {
    const lines = `${Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")}\n`;
    const env = new Bash({
      files: { "/test.txt": lines }
    });
    const result = await env.exec("tail /test.txt");
    expect(result.stdout).toBe(
      "line11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20\n"
    );
    expect(result.exitCode).toBe(0);
  });

  it("should show specified number of lines with -n", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\nc\nd\ne\n" }
    });
    const result = await env.exec("tail -n 2 /test.txt");
    expect(result.stdout).toBe("d\ne\n");
  });

  it("should show specified number of lines with -n attached", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\nc\nd\ne\n" }
    });
    const result = await env.exec("tail -n2 /test.txt");
    expect(result.stdout).toBe("d\ne\n");
  });

  it("should show specified number of lines with -NUM", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\nc\nd\ne\n" }
    });
    const result = await env.exec("tail -3 /test.txt");
    expect(result.stdout).toBe("c\nd\ne\n");
  });

  it("should handle file with fewer lines than requested", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\n" }
    });
    const result = await env.exec("tail -n 10 /test.txt");
    expect(result.stdout).toBe("a\nb\n");
  });

  it("should show headers for multiple files", async () => {
    const env = new Bash({
      files: {
        "/a.txt": "aaa\n",
        "/b.txt": "bbb\n"
      }
    });
    const result = await env.exec("tail /a.txt /b.txt");
    expect(result.stdout).toBe("==> /a.txt <==\naaa\n\n==> /b.txt <==\nbbb\n");
  });

  it("should error on missing file", async () => {
    const env = new Bash();
    const result = await env.exec("tail /missing.txt");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "tail: /missing.txt: No such file or directory\n"
    );
  });

  it("should read from stdin", async () => {
    const env = new Bash();
    const result = await env.exec('echo -e "a\\nb\\nc\\nd\\ne" | tail -n 2');
    expect(result.stdout).toBe("d\ne\n");
  });

  it("should handle empty file", async () => {
    const env = new Bash({
      files: { "/empty.txt": "" }
    });
    const result = await env.exec("tail /empty.txt");
    expect(result.exitCode).toBe(0);
  });

  it("should handle tail -n 1 with single line", async () => {
    const env = new Bash({
      files: { "/test.txt": "only line\n" }
    });
    const result = await env.exec("tail -n 1 /test.txt");
    expect(result.stdout).toBe("only line\n");
  });

  it("should show last line only with -n 1", async () => {
    const env = new Bash({
      files: { "/test.txt": "first\nsecond\nthird\n" }
    });
    const result = await env.exec("tail -n 1 /test.txt");
    expect(result.stdout).toBe("third\n");
  });

  it("should combine with head for specific line", async () => {
    const env = new Bash({
      files: { "/test.txt": "line1\nline2\nline3\nline4\nline5\n" }
    });
    const result = await env.exec("cat /test.txt | head -n 3 | tail -n 1");
    expect(result.stdout).toBe("line3\n");
  });

  describe("+n syntax (from line n)", () => {
    it("should start from line n with -n +n", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\nline4\nline5\n" }
      });
      const result = await env.exec("tail -n +3 /test.txt");
      expect(result.stdout).toBe("line3\nline4\nline5\n");
      expect(result.exitCode).toBe(0);
    });

    it("should start from line 1 with -n +1 (same as entire file)", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\n" }
      });
      const result = await env.exec("tail -n +1 /test.txt");
      expect(result.stdout).toBe("line1\nline2\nline3\n");
    });

    it("should start from line 2 with -n +2", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\nline3\n" }
      });
      const result = await env.exec("tail -n +2 /test.txt");
      expect(result.stdout).toBe("line2\nline3\n");
    });

    it("should return empty when starting beyond file length", async () => {
      const env = new Bash({
        files: { "/test.txt": "line1\nline2\n" }
      });
      const result = await env.exec("tail -n +10 /test.txt");
      expect(result.stdout).toBe("\n");
      expect(result.exitCode).toBe(0);
    });

    it("should work with stdin", async () => {
      const env = new Bash();
      const result = await env.exec('echo -e "a\\nb\\nc\\nd\\ne" | tail -n +3');
      expect(result.stdout).toBe("c\nd\ne\n");
    });
  });
});
