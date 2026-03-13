import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("find predicates", () => {
  describe("-mtime (modification time)", () => {
    it("should find files modified today with -mtime 0", async () => {
      const now = new Date();
      const env = new Bash({
        files: {
          "/dir/today.txt": { content: "today", mtime: now },
          "/dir/old.txt": {
            content: "old",
            mtime: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
          }
        }
      });
      const result = await env.exec("find /dir -type f -mtime 0");
      expect(result.stdout).toBe("/dir/today.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files modified more than N days ago with -mtime +N", async () => {
      const now = new Date();
      const env = new Bash({
        files: {
          "/dir/recent.txt": { content: "recent", mtime: now },
          "/dir/old.txt": {
            content: "old",
            mtime: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)
          }
        }
      });
      const result = await env.exec("find /dir -type f -mtime +7");
      expect(result.stdout).toBe("/dir/old.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files modified less than N days ago with -mtime -N", async () => {
      const now = new Date();
      const env = new Bash({
        files: {
          "/dir/recent.txt": { content: "recent", mtime: now },
          "/dir/old.txt": {
            content: "old",
            mtime: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)
          }
        }
      });
      const result = await env.exec("find /dir -type f -mtime -7");
      expect(result.stdout).toBe("/dir/recent.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files modified exactly N days ago with -mtime N", async () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      const env = new Bash({
        files: {
          "/dir/two-days.txt": { content: "two days", mtime: twoDaysAgo },
          "/dir/today.txt": { content: "today", mtime: now }
        }
      });
      const result = await env.exec("find /dir -type f -mtime 2");
      expect(result.stdout).toBe("/dir/two-days.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-newer FILE", () => {
    it("should find files newer than reference file", async () => {
      const now = new Date();
      const earlier = new Date(now.getTime() - 60 * 1000);
      const env = new Bash({
        files: {
          "/ref.txt": { content: "ref", mtime: earlier },
          "/dir/newer.txt": { content: "newer", mtime: now },
          "/dir/older.txt": {
            content: "older",
            mtime: new Date(earlier.getTime() - 60 * 1000)
          }
        }
      });
      const result = await env.exec("find /dir -type f -newer /ref.txt");
      expect(result.stdout).toBe("/dir/newer.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should return nothing when reference file does not exist", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": "content"
        }
      });
      const result = await env.exec(
        "find /dir -type f -newer /nonexistent.txt"
      );
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-size", () => {
    it("should find files larger than N bytes with -size +Nc", async () => {
      const env = new Bash({
        files: {
          "/dir/large.txt": "x".repeat(1000),
          "/dir/small.txt": "tiny"
        }
      });
      const result = await env.exec("find /dir -type f -size +100c");
      expect(result.stdout).toBe("/dir/large.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files smaller than N bytes with -size -Nc", async () => {
      const env = new Bash({
        files: {
          "/dir/large.txt": "x".repeat(1000),
          "/dir/small.txt": "tiny"
        }
      });
      const result = await env.exec("find /dir -type f -size -100c");
      expect(result.stdout).toBe("/dir/small.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files exactly N bytes with -size Nc", async () => {
      const env = new Bash({
        files: {
          "/dir/exact.txt": "12345",
          "/dir/other.txt": "1234"
        }
      });
      const result = await env.exec("find /dir -type f -size 5c");
      expect(result.stdout).toBe("/dir/exact.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files by size in kilobytes with -size Nk", async () => {
      const env = new Bash({
        files: {
          "/dir/large.txt": "x".repeat(2048),
          "/dir/small.txt": "tiny"
        }
      });
      const result = await env.exec("find /dir -type f -size +1k");
      expect(result.stdout).toBe("/dir/large.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files by size in megabytes with -size NM", async () => {
      const env = new Bash({
        files: {
          "/dir/small.txt": "tiny"
        }
      });
      const result = await env.exec("find /dir -type f -size -1M");
      expect(result.stdout).toBe("/dir/small.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("-perm", () => {
    it("should find files with exact permission mode", async () => {
      const env = new Bash({
        files: {
          "/dir/exec.sh": { content: "#!/bin/bash", mode: 0o755 },
          "/dir/normal.txt": { content: "text", mode: 0o644 }
        }
      });
      const result = await env.exec("find /dir -type f -perm 755");
      expect(result.stdout).toBe("/dir/exec.sh\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files with all permission bits set using -perm -MODE", async () => {
      const env = new Bash({
        files: {
          "/dir/exec.sh": { content: "#!/bin/bash", mode: 0o755 },
          "/dir/readonly.txt": { content: "text", mode: 0o444 }
        }
      });
      // Files where at least user execute bit is set
      const result = await env.exec("find /dir -type f -perm -100");
      expect(result.stdout).toBe("/dir/exec.sh\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should find files with any permission bits set using -perm /MODE", async () => {
      const env = new Bash({
        files: {
          "/dir/exec.sh": { content: "#!/bin/bash", mode: 0o755 },
          "/dir/group-exec.txt": { content: "text", mode: 0o654 },
          "/dir/no-exec.txt": { content: "text", mode: 0o644 }
        }
      });
      // Files where any execute bit is set
      const result = await env.exec("find /dir -type f -perm /111");
      expect(result.stdout).toBe("/dir/exec.sh\n/dir/group-exec.txt\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });
});
