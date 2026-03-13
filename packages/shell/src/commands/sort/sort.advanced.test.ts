import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("sort -h (human numeric)", () => {
  it("should sort human readable sizes", async () => {
    const env = new Bash({
      files: { "/test.txt": "1K\n2M\n500\n1G\n100K\n" }
    });
    const result = await env.exec("sort -h /test.txt");
    expect(result.stdout).toBe("500\n1K\n100K\n2M\n1G\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle mixed case suffixes", async () => {
    const env = new Bash({
      files: { "/test.txt": "1k\n2M\n3g\n" }
    });
    const result = await env.exec("sort -h /test.txt");
    expect(result.stdout).toBe("1k\n2M\n3g\n");
    expect(result.exitCode).toBe(0);
  });

  it("should sort with decimal values", async () => {
    const env = new Bash({
      files: { "/test.txt": "1.5K\n2K\n1K\n" }
    });
    const result = await env.exec("sort -h /test.txt");
    expect(result.stdout).toBe("1K\n1.5K\n2K\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle reverse human sort", async () => {
    const env = new Bash({
      files: { "/test.txt": "1K\n1M\n1G\n" }
    });
    const result = await env.exec("sort -hr /test.txt");
    expect(result.stdout).toBe("1G\n1M\n1K\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("sort -V (version)", () => {
  it("should sort version numbers naturally", async () => {
    const env = new Bash({
      files: { "/test.txt": "file1.10\nfile1.2\nfile1.1\n" }
    });
    const result = await env.exec("sort -V /test.txt");
    expect(result.stdout).toBe("file1.1\nfile1.2\nfile1.10\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle version-like strings", async () => {
    const env = new Bash({
      files: { "/test.txt": "v2.0\nv1.10\nv1.2\n" }
    });
    const result = await env.exec("sort -V /test.txt");
    expect(result.stdout).toBe("v1.2\nv1.10\nv2.0\n");
    expect(result.exitCode).toBe(0);
  });

  it("should sort mixed version formats", async () => {
    const env = new Bash({
      files: { "/test.txt": "1.0.0\n1.0.10\n1.0.2\n" }
    });
    const result = await env.exec("sort -V /test.txt");
    expect(result.stdout).toBe("1.0.0\n1.0.2\n1.0.10\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("sort -M (month)", () => {
  it("should sort month names", async () => {
    const env = new Bash({
      files: { "/test.txt": "Mar\nJan\nDec\nFeb\n" }
    });
    const result = await env.exec("sort -M /test.txt");
    expect(result.stdout).toBe("Jan\nFeb\nMar\nDec\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle lowercase months", async () => {
    const env = new Bash({
      files: { "/test.txt": "mar\njan\nfeb\n" }
    });
    const result = await env.exec("sort -M /test.txt");
    expect(result.stdout).toBe("jan\nfeb\nmar\n");
    expect(result.exitCode).toBe(0);
  });

  it("should put unknown values first", async () => {
    const env = new Bash({
      files: { "/test.txt": "Mar\nfoo\nJan\n" }
    });
    const result = await env.exec("sort -M /test.txt");
    expect(result.stdout).toBe("foo\nJan\nMar\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("sort -d (dictionary order)", () => {
  it("should ignore non-alphanumeric characters", async () => {
    const env = new Bash({
      files: { "/test.txt": "b-c\na_b\nc.d\n" }
    });
    const result = await env.exec("sort -d /test.txt");
    // Dictionary order: only alphanumeric and blanks matter
    // ab, bc, cd -> a_b, b-c, c.d
    expect(result.stdout).toBe("a_b\nb-c\nc.d\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("sort -b (ignore leading blanks)", () => {
  it("should ignore leading blanks", async () => {
    const env = new Bash({
      files: { "/test.txt": "  b\na\n   c\n" }
    });
    const result = await env.exec("sort -b /test.txt");
    expect(result.stdout).toBe("a\n  b\n   c\n");
    expect(result.exitCode).toBe(0);
  });

  it("should combine with other flags", async () => {
    const env = new Bash({
      files: { "/test.txt": "  2\n1\n   3\n" }
    });
    const result = await env.exec("sort -bn /test.txt");
    expect(result.stdout).toBe("1\n  2\n   3\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("sort -c (check)", () => {
  it("should return 0 for sorted input", async () => {
    const env = new Bash({
      files: { "/test.txt": "a\nb\nc\n" }
    });
    const result = await env.exec("sort -c /test.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 for unsorted input", async () => {
    const env = new Bash({
      files: { "/test.txt": "b\na\nc\n" }
    });
    const result = await env.exec("sort -c /test.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("sort: /test.txt:2: disorder: a\n");
    expect(result.exitCode).toBe(1);
  });

  it("should check numeric order with -cn", async () => {
    const env = new Bash({
      files: { "/test.txt": "1\n2\n10\n" }
    });
    const result = await env.exec("sort -cn /test.txt");
    expect(result.exitCode).toBe(0);
  });
});

describe("sort -o (output file)", () => {
  it("should write to output file", async () => {
    const env = new Bash({
      files: { "/test.txt": "c\na\nb\n" }
    });
    await env.exec("sort -o /out.txt /test.txt");
    const result = await env.exec("cat /out.txt");
    expect(result.stdout).toBe("a\nb\nc\n");
  });

  it("should support in-place sort", async () => {
    const env = new Bash({
      files: { "/test.txt": "c\na\nb\n" }
    });
    await env.exec("sort -o /test.txt /test.txt");
    const result = await env.exec("cat /test.txt");
    expect(result.stdout).toBe("a\nb\nc\n");
  });

  it("should support --output= syntax", async () => {
    const env = new Bash({
      files: { "/test.txt": "c\na\nb\n" }
    });
    await env.exec("sort --output=/out.txt /test.txt");
    const result = await env.exec("cat /out.txt");
    expect(result.stdout).toBe("a\nb\nc\n");
  });
});

describe("sort -s (stable)", () => {
  it("should preserve original order for equal elements", async () => {
    const env = new Bash({
      files: { "/test.txt": "1 b\n1 a\n2 c\n" }
    });
    // With -s, equal keys should maintain original order
    const result = await env.exec("sort -s -k1,1 /test.txt");
    expect(result.stdout).toBe("1 b\n1 a\n2 c\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("sort per-key modifiers", () => {
  it("should support -k with h modifier", async () => {
    const env = new Bash({
      files: { "/test.txt": "a 1M\nb 1K\nc 1G\n" }
    });
    const result = await env.exec("sort -k2h /test.txt");
    expect(result.stdout).toBe("b 1K\na 1M\nc 1G\n");
    expect(result.exitCode).toBe(0);
  });

  it("should support -k with V modifier", async () => {
    const env = new Bash({
      files: { "/test.txt": "a v1.10\nb v1.2\nc v2.0\n" }
    });
    const result = await env.exec("sort -k2V /test.txt");
    expect(result.stdout).toBe("b v1.2\na v1.10\nc v2.0\n");
    expect(result.exitCode).toBe(0);
  });

  it("should support -k with M modifier", async () => {
    const env = new Bash({
      files: { "/test.txt": "2023 Mar\n2023 Jan\n2023 Feb\n" }
    });
    const result = await env.exec("sort -k2M /test.txt");
    expect(result.stdout).toBe("2023 Jan\n2023 Feb\n2023 Mar\n");
    expect(result.exitCode).toBe(0);
  });
});

describe("sort --help", () => {
  it("should show all new options in help", async () => {
    const env = new Bash();
    const result = await env.exec("sort --help");
    expect(result.stdout).toContain("-h");
    expect(result.stdout).toContain("-V");
    expect(result.stdout).toContain("-M");
    expect(result.stdout).toContain("-d");
    expect(result.stdout).toContain("-b");
    expect(result.stdout).toContain("-c");
    expect(result.stdout).toContain("-o");
    expect(result.stdout).toContain("-s");
    expect(result.exitCode).toBe(0);
  });
});
