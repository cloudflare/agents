import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("sort command", () => {
  const createEnv = () =>
    new Bash({
      files: {
        "/test/names.txt": "Charlie\nAlice\nBob\nDavid\n",
        "/test/numbers.txt": "10\n2\n1\n20\n5\n",
        "/test/duplicates.txt": "apple\nbanana\napple\ncherry\nbanana\n",
        "/test/columns.txt": "John 25\nAlice 30\nBob 20\nDavid 35\n",
        "/test/mixed.txt": "zebra\nalpha\nZebra\nAlpha\n"
      },
      cwd: "/test"
    });

  it("should sort lines alphabetically", async () => {
    const env = createEnv();
    const result = await env.exec("sort /test/names.txt");
    expect(result.stdout).toBe("Alice\nBob\nCharlie\nDavid\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should sort lines in reverse order with -r", async () => {
    const env = createEnv();
    const result = await env.exec("sort -r /test/names.txt");
    expect(result.stdout).toBe("David\nCharlie\nBob\nAlice\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should sort numerically with -n", async () => {
    const env = createEnv();
    const result = await env.exec("sort -n /test/numbers.txt");
    expect(result.stdout).toBe("1\n2\n5\n10\n20\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should sort numerically in reverse with -rn", async () => {
    const env = createEnv();
    const result = await env.exec("sort -rn /test/numbers.txt");
    expect(result.stdout).toBe("20\n10\n5\n2\n1\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should remove duplicates with -u", async () => {
    const env = createEnv();
    const result = await env.exec("sort -u /test/duplicates.txt");
    expect(result.stdout).toBe("apple\nbanana\ncherry\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should sort by key field with -k", async () => {
    const env = createEnv();
    const result = await env.exec("sort -k2 -n /test/columns.txt");
    expect(result.stdout).toBe("Bob 20\nJohn 25\nAlice 30\nDavid 35\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should read from stdin via pipe", async () => {
    const env = createEnv();
    const result = await env.exec('echo -e "c\\nb\\na" | sort');
    expect(result.stdout).toBe("a\nb\nc\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle case-sensitive sorting", async () => {
    const env = createEnv();
    const result = await env.exec("sort /test/mixed.txt");
    expect(result.stdout).toBe("alpha\nAlpha\nzebra\nZebra\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should return error for non-existent file", async () => {
    const env = createEnv();
    const result = await env.exec("sort /test/nonexistent.txt");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "sort: /test/nonexistent.txt: No such file or directory\n"
    );
    expect(result.exitCode).toBe(1);
  });

  it("should handle empty input", async () => {
    const env = createEnv();
    const result = await env.exec('echo "" | sort');
    expect(result.stdout).toBe("\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle combined flags -nr", async () => {
    const env = createEnv();
    const result = await env.exec("sort -nr /test/numbers.txt");
    expect(result.stdout).toBe("20\n10\n5\n2\n1\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  describe("-f flag (case-insensitive)", () => {
    it("should sort case-insensitively with -f", async () => {
      const env = createEnv();
      const result = await env.exec("sort -f /test/mixed.txt");
      // Case-insensitive: alpha/Alpha should be together, zebra/Zebra together
      // The exact order within same-case groups depends on locale
      expect(result.stdout).toContain("alpha");
      expect(result.stdout).toContain("Alpha");
      expect(result.stdout).toContain("zebra");
      expect(result.stdout).toContain("Zebra");
      expect(result.exitCode).toBe(0);
    });

    it("should sort case-insensitively with --ignore-case", async () => {
      const env = new Bash({
        files: { "/test.txt": "Banana\napple\nCherry\n" }
      });
      const result = await env.exec("sort --ignore-case /test.txt");
      expect(result.stdout).toBe("apple\nBanana\nCherry\n");
      expect(result.exitCode).toBe(0);
    });

    it("should combine -f with -r for reverse case-insensitive", async () => {
      const env = new Bash({
        files: { "/test.txt": "apple\nBanana\ncherry\n" }
      });
      const result = await env.exec("sort -fr /test.txt");
      expect(result.stdout).toBe("cherry\nBanana\napple\n");
      expect(result.exitCode).toBe(0);
    });

    it("should combine -f with -u for unique case-insensitive", async () => {
      const env = new Bash({
        files: { "/test.txt": "Apple\napple\nBanana\nbanana\n" }
      });
      const result = await env.exec("sort -fu /test.txt");
      // Should have 2 unique entries (case-folded)
      const lines = result.stdout.trim().split("\n");
      expect(lines.length).toBe(2);
      expect(result.exitCode).toBe(0);
    });

    it("should work with -k field and -f", async () => {
      const env = new Bash({
        files: { "/test.txt": "1 Zebra\n2 apple\n3 BANANA\n" }
      });
      const result = await env.exec("sort -f -k2 /test.txt");
      expect(result.stdout).toBe("2 apple\n3 BANANA\n1 Zebra\n");
      expect(result.exitCode).toBe(0);
    });

    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("sort --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("--ignore-case");
    });
  });

  describe("complex -k syntax", () => {
    it("should sort by field range -k1,2", async () => {
      const env = new Bash({
        files: { "/test.txt": "a b c\na a c\nb a a\n" },
        cwd: "/"
      });
      const result = await env.exec("sort -k1,2 /test.txt");
      expect(result.stdout).toBe("a a c\na b c\nb a a\n");
    });

    it("should sort by single field only with -k2,2", async () => {
      const env = new Bash({
        files: { "/test.txt": "1 banana\n2 apple\n3 cherry\n" },
        cwd: "/"
      });
      const result = await env.exec("sort -k2,2 /test.txt");
      expect(result.stdout).toBe("2 apple\n1 banana\n3 cherry\n");
    });

    it("should support per-key numeric modifier -k2n", async () => {
      const env = new Bash({
        files: { "/test.txt": "a 10\nb 2\nc 1\n" },
        cwd: "/"
      });
      const result = await env.exec("sort -k2n /test.txt");
      expect(result.stdout).toBe("c 1\nb 2\na 10\n");
    });

    it("should support per-key reverse modifier -k1r", async () => {
      const env = new Bash({
        files: { "/test.txt": "a 1\nb 2\nc 3\n" },
        cwd: "/"
      });
      const result = await env.exec("sort -k1r /test.txt");
      expect(result.stdout).toBe("c 3\nb 2\na 1\n");
    });

    it("should support combined modifiers -k2,2nr", async () => {
      const env = new Bash({
        files: { "/test.txt": "x 5\ny 10\nz 2\n" },
        cwd: "/"
      });
      const result = await env.exec("sort -k2,2nr /test.txt");
      expect(result.stdout).toBe("y 10\nx 5\nz 2\n");
    });

    it("should support multiple keys for secondary sort", async () => {
      const env = new Bash({
        files: { "/test.txt": "a 2\nb 1\na 1\nb 2\n" },
        cwd: "/"
      });
      // Sort by field 1, then by field 2 numerically
      const result = await env.exec("sort -k1,1 -k2,2n /test.txt");
      expect(result.stdout).toBe("a 1\na 2\nb 1\nb 2\n");
    });

    it("should support character position -k1.2", async () => {
      const env = new Bash({
        files: { "/test.txt": "abc\nabc\nbac\naac\n" },
        cwd: "/"
      });
      // Sort starting from 2nd character of field 1
      const result = await env.exec("sort -k1.2 /test.txt");
      expect(result.stdout).toBe("aac\nbac\nabc\nabc\n");
    });

    it("should support per-key ignore-case -k1f", async () => {
      const env = new Bash({
        files: { "/test.txt": "Zebra\napple\nBANANA\n" },
        cwd: "/"
      });
      const result = await env.exec("sort -k1f /test.txt");
      expect(result.stdout).toBe("apple\nBANANA\nZebra\n");
    });

    it("should support custom delimiter with -t", async () => {
      const env = new Bash({
        files: { "/test.txt": "c:3\na:1\nb:2\n" },
        cwd: "/"
      });
      const result = await env.exec("sort -t: -k2n /test.txt");
      expect(result.stdout).toBe("a:1\nb:2\nc:3\n");
    });

    it("should handle --key= syntax", async () => {
      const env = new Bash({
        files: { "/test.txt": "3 c\n1 a\n2 b\n" },
        cwd: "/"
      });
      const result = await env.exec("sort --key=1n /test.txt");
      expect(result.stdout).toBe("1 a\n2 b\n3 c\n");
    });
  });
});
