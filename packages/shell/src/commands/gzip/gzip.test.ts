import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("gzip", () => {
  describe("compression", () => {
    it("compresses a file and removes original", async () => {
      const bash = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });

      const result = await bash.exec("gzip test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      // Original should be removed
      const lsResult = await bash.exec("ls /");
      expect(lsResult.stdout).not.toContain("test.txt\n");
      expect(lsResult.stdout).toContain("test.txt.gz");
    });

    it("keeps original with -k flag", async () => {
      const bash = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });

      const result = await bash.exec("gzip -k test.txt");
      expect(result.exitCode).toBe(0);

      // Both files should exist
      const lsResult = await bash.exec("ls /");
      expect(lsResult.stdout).toContain("test.txt\n");
      expect(lsResult.stdout).toContain("test.txt.gz");
    });

    it("writes to stdout with -c flag", async () => {
      const bash = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });

      const result = await bash.exec("gzip -c test.txt");
      expect(result.exitCode).toBe(0);
      // Output should be gzip magic bytes (0x1f 0x8b)
      expect(result.stdout.charCodeAt(0)).toBe(0x1f);
      expect(result.stdout.charCodeAt(1)).toBe(0x8b);

      // Original should still exist
      const lsResult = await bash.exec("ls /");
      expect(lsResult.stdout).toContain("test.txt");
      expect(lsResult.stdout).not.toContain("test.txt.gz");
    });

    it("refuses to overwrite existing .gz file without -f", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "Hello, World!",
          "/test.txt.gz": "existing"
        }
      });

      const result = await bash.exec("gzip test.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("already exists");
    });

    it("overwrites existing .gz file with -f", async () => {
      const bash = new Bash({
        files: {
          "/test.txt": "Hello, World!",
          "/test.txt.gz": "existing"
        }
      });

      const result = await bash.exec("gzip -f test.txt");
      expect(result.exitCode).toBe(0);
    });

    it("skips files that already have .gz suffix", async () => {
      const bash = new Bash({
        files: { "/test.txt.gz": "already compressed" }
      });

      const result = await bash.exec("gzip test.txt.gz");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("already has .gz suffix");
    });

    it("compresses multiple files", async () => {
      const bash = new Bash({
        files: {
          "/a.txt": "File A",
          "/b.txt": "File B"
        }
      });

      const result = await bash.exec("gzip a.txt b.txt");
      expect(result.exitCode).toBe(0);

      const lsResult = await bash.exec("ls /");
      expect(lsResult.stdout).toContain("a.txt.gz");
      expect(lsResult.stdout).toContain("b.txt.gz");
    });

    it("uses custom suffix with -S", async () => {
      const bash = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });

      const result = await bash.exec("gzip -S .z test.txt");
      expect(result.exitCode).toBe(0);

      const lsResult = await bash.exec("ls /");
      expect(lsResult.stdout).toContain("test.txt.z");
    });

    it("shows verbose output with -v", async () => {
      const bash = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });

      const result = await bash.exec("gzip -v test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("test.txt:");
      expect(result.stderr).toContain("%");
    });
  });

  describe("decompression", () => {
    it("decompresses a file with -d", async () => {
      const bash = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });

      // First compress
      await bash.exec("gzip test.txt");

      // Then decompress
      const result = await bash.exec("gzip -d test.txt.gz");
      expect(result.exitCode).toBe(0);

      // Check content
      const catResult = await bash.exec("cat test.txt");
      expect(catResult.stdout).toBe("Hello, World!");
    });

    it("refuses to decompress file without .gz suffix", async () => {
      const bash = new Bash({
        files: { "/test.txt": "not compressed" }
      });

      const result = await bash.exec("gzip -d test.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unknown suffix");
    });

    it("detects non-gzip files", async () => {
      const bash = new Bash({
        files: { "/test.txt.gz": "not actually gzip" }
      });

      const result = await bash.exec("gzip -d test.txt.gz");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not in gzip format");
    });
  });

  describe("compression levels", () => {
    it("accepts -1 through -9 flags", async () => {
      for (let level = 1; level <= 9; level++) {
        const bash = new Bash({
          files: { "/test.txt": "Hello, World!" }
        });
        const result = await bash.exec(`gzip -${level} -k test.txt`);
        expect(result.exitCode).toBe(0);
      }
    });

    it("accepts --fast and --best", async () => {
      const bash1 = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });
      const result1 = await bash1.exec("gzip --fast -k test.txt");
      expect(result1.exitCode).toBe(0);

      const bash2 = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });
      const result2 = await bash2.exec("gzip --best -k test.txt");
      expect(result2.exitCode).toBe(0);
    });
  });

  describe("stdin/stdout", () => {
    it("reads from stdin when no file specified", async () => {
      const bash = new Bash();

      const result = await bash.exec("echo 'Hello' | gzip | base64");
      expect(result.exitCode).toBe(0);
      // Should produce base64 of gzipped data
      expect(result.stdout.length).toBeGreaterThan(0);
    });

    it("reads from stdin with - argument", async () => {
      const bash = new Bash();

      const result = await bash.exec("echo 'Hello' | gzip - | base64");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("--help", () => {
    it("shows help with --help", async () => {
      const bash = new Bash();
      const result = await bash.exec("gzip --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("gzip");
      expect(result.stdout).toContain("compress");
    });
  });

  describe("error handling", () => {
    it("errors on non-existent file", async () => {
      const bash = new Bash();
      const result = await bash.exec("gzip nonexistent.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No such file or directory");
    });

    it("errors on unknown option", async () => {
      const bash = new Bash();
      const result = await bash.exec("gzip --unknown");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unrecognized option");
    });

    it("ignores directories without -r", async () => {
      const bash = new Bash({
        files: { "/dir/file.txt": "content" }
      });

      const result = await bash.exec("gzip dir");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("is a directory");
    });
  });

  describe("-l (list)", () => {
    it("lists compressed file info", async () => {
      const bash = new Bash({
        files: { "/test.txt": "Hello, World! This is a test." }
      });

      await bash.exec("gzip test.txt");
      const result = await bash.exec("gzip -l test.txt.gz");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("compressed");
      expect(result.stdout).toContain("uncompressed");
      expect(result.stdout).toContain("%");
    });
  });

  describe("-t (test)", () => {
    it("tests valid gzip file integrity", async () => {
      const bash = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });

      await bash.exec("gzip test.txt");
      const result = await bash.exec("gzip -t test.txt.gz");
      expect(result.exitCode).toBe(0);
    });

    it("shows OK with -tv", async () => {
      const bash = new Bash({
        files: { "/test.txt": "Hello, World!" }
      });

      await bash.exec("gzip test.txt");
      const result = await bash.exec("gzip -tv test.txt.gz");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("OK");
    });

    it("detects corrupted gzip file", async () => {
      const bash = new Bash({
        files: { "/corrupt.gz": "not valid gzip data" }
      });

      const result = await bash.exec("gzip -t corrupt.gz");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("not in gzip format");
    });
  });

  describe("-r (recursive)", () => {
    it("compresses files in directory recursively", async () => {
      const bash = new Bash({
        files: {
          "/dir/a.txt": "File A",
          "/dir/b.txt": "File B",
          "/dir/sub/c.txt": "File C"
        }
      });

      const result = await bash.exec("gzip -r dir");
      expect(result.exitCode).toBe(0);

      const findResult = await bash.exec("find dir -name '*.gz'");
      expect(findResult.stdout).toContain("a.txt.gz");
      expect(findResult.stdout).toContain("b.txt.gz");
      expect(findResult.stdout).toContain("c.txt.gz");
    });
  });

  describe("-q (quiet)", () => {
    it("suppresses warnings with -q", async () => {
      const bash = new Bash({
        files: { "/test.txt.gz": "not valid" }
      });

      const result = await bash.exec("gzip -qd test.txt.gz");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
    });
  });
});

describe("gunzip", () => {
  it("decompresses files by default", async () => {
    const bash = new Bash({
      files: { "/test.txt": "Hello, World!" }
    });

    await bash.exec("gzip test.txt");
    const result = await bash.exec("gunzip test.txt.gz");
    expect(result.exitCode).toBe(0);

    const catResult = await bash.exec("cat test.txt");
    expect(catResult.stdout).toBe("Hello, World!");
  });

  it("shows help", async () => {
    const bash = new Bash();
    const result = await bash.exec("gunzip --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("gunzip");
    expect(result.stdout).toContain("decompress");
  });

  it("writes to stdout with -c", async () => {
    const bash = new Bash({
      files: { "/test.txt": "Hello, World!" }
    });

    await bash.exec("gzip test.txt");
    const result = await bash.exec("gunzip -c test.txt.gz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello, World!");

    // Original .gz should still exist
    const lsResult = await bash.exec("ls /");
    expect(lsResult.stdout).toContain("test.txt.gz");
  });
});

describe("zcat", () => {
  it("outputs decompressed content to stdout", async () => {
    const bash = new Bash({
      files: { "/test.txt": "Hello, World!" }
    });

    await bash.exec("gzip test.txt");
    const result = await bash.exec("zcat test.txt.gz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Hello, World!");

    // Original .gz should still exist
    const lsResult = await bash.exec("ls /");
    expect(lsResult.stdout).toContain("test.txt.gz");
  });

  it("shows help", async () => {
    const bash = new Bash();
    const result = await bash.exec("zcat --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("zcat");
    expect(result.stdout).toContain("stdout");
  });

  it("handles multiple files", async () => {
    const bash = new Bash({
      files: {
        "/a.txt": "File A\n",
        "/b.txt": "File B\n"
      }
    });

    await bash.exec("gzip a.txt b.txt");
    const result = await bash.exec("zcat a.txt.gz b.txt.gz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("File A\nFile B\n");
  });
});
