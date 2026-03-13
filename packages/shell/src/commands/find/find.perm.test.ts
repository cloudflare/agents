import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("find -perm", () => {
  describe("exact mode matching", () => {
    it("finds files with exact permission 644", async () => {
      const env = new Bash({
        files: {
          "/test/file1.txt": { content: "a", mode: 0o644 },
          "/test/file2.txt": { content: "b", mode: 0o755 },
          "/test/file3.txt": { content: "c", mode: 0o644 }
        }
      });
      const result = await env.exec("find /test -type f -perm 644");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("/test/file1.txt\n/test/file3.txt\n");
      expect(result.stderr).toBe("");
    });

    it("finds files with exact permission 755", async () => {
      const env = new Bash({
        files: {
          "/test/script.sh": { content: "#!/bin/bash", mode: 0o755 },
          "/test/data.txt": { content: "data", mode: 0o644 }
        }
      });
      const result = await env.exec("find /test -type f -perm 755");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("/test/script.sh");
    });
  });

  describe("-mode (all bits set)", () => {
    it("finds files with at least user execute", async () => {
      const env = new Bash({
        files: {
          "/test/exec.sh": { content: "a", mode: 0o755 },
          "/test/data.txt": { content: "b", mode: 0o644 },
          "/test/other.sh": { content: "c", mode: 0o700 }
        }
      });
      // -100 means user execute must be set (0o100 = 64)
      const result = await env.exec("find /test -type f -perm -100");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("/test/exec.sh\n/test/other.sh\n");
      expect(result.stderr).toBe("");
    });

    it("finds files with user+group read", async () => {
      const env = new Bash({
        files: {
          "/test/readable.txt": { content: "a", mode: 0o644 },
          "/test/private.txt": { content: "b", mode: 0o600 }
        }
      });
      // -040 means group read must be set
      const result = await env.exec("find /test -type f -perm -040");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("/test/readable.txt");
    });
  });

  describe("/mode (any bit set)", () => {
    it("finds files with any execute bit", async () => {
      const env = new Bash({
        files: {
          "/test/user_exec.sh": { content: "a", mode: 0o700 },
          "/test/group_exec.sh": { content: "b", mode: 0o070 },
          "/test/other_exec.sh": { content: "c", mode: 0o007 },
          "/test/no_exec.txt": { content: "d", mode: 0o644 }
        }
      });
      // /111 means any execute bit (user, group, or other)
      const result = await env.exec("find /test -type f -perm /111");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`/test/group_exec.sh
/test/other_exec.sh
/test/user_exec.sh
`);
      expect(result.stderr).toBe("");
    });
  });
});
