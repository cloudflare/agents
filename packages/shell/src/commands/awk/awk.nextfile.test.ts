import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("awk nextfile statement", () => {
  describe("basic nextfile", () => {
    it("should skip to next file", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "a1\na2\na3\n",
          "/b.txt": "b1\nb2\nb3\n"
        }
      });
      const result = await env.exec(
        `awk '{ print; if (FNR == 2) nextfile }' /a.txt /b.txt`
      );
      expect(result.stdout).toBe("a1\na2\nb1\nb2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should skip rest of first file", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "skip1\nskip2\nskip3\n",
          "/b.txt": "keep1\nkeep2\n"
        }
      });
      const result = await env.exec(
        `awk 'FNR == 1 && FILENAME == "/a.txt" { nextfile } { print }' /a.txt /b.txt`
      );
      expect(result.stdout).toBe("keep1\nkeep2\n");
      expect(result.exitCode).toBe(0);
    });

    it("should continue with next file content", async () => {
      const env = new Bash({
        files: {
          "/first.txt": "1\n2\n3\n",
          "/second.txt": "a\nb\nc\n"
        }
      });
      const result = await env.exec(
        `awk '{ if ($1 == "2") nextfile; print }' /first.txt /second.txt`
      );
      expect(result.stdout).toBe("1\na\nb\nc\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("nextfile with FNR reset", () => {
    it("should reset FNR for each file", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "a1\na2\n",
          "/b.txt": "b1\nb2\nb3\n"
        }
      });
      const result = await env.exec(
        `awk '{ print FILENAME, FNR }' /a.txt /b.txt`
      );
      expect(result.stdout).toBe(
        "/a.txt 1\n/a.txt 2\n/b.txt 1\n/b.txt 2\n/b.txt 3\n"
      );
      expect(result.exitCode).toBe(0);
    });

    it("should maintain NR across files", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "a1\na2\n",
          "/b.txt": "b1\nb2\n"
        }
      });
      const result = await env.exec(`awk '{ print NR, FNR }' /a.txt /b.txt`);
      expect(result.stdout).toBe("1 1\n2 2\n3 1\n4 2\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("nextfile in conditions", () => {
    it("should skip file on condition", async () => {
      const env = new Bash({
        files: {
          "/skip.txt": "SKIP\ndata1\ndata2\n",
          "/keep.txt": "KEEP\ndata3\ndata4\n"
        }
      });
      const result = await env.exec(
        `awk 'FNR == 1 && /SKIP/ { nextfile } { print }' /skip.txt /keep.txt`
      );
      expect(result.stdout).toBe("KEEP\ndata3\ndata4\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("nextfile with single file", () => {
    it("should end processing when nextfile on single file", async () => {
      const env = new Bash({
        files: { "/data.txt": "1\n2\n3\n4\n5\n" }
      });
      const result = await env.exec(
        `awk '{ print; if ($1 == 3) nextfile }' /data.txt`
      );
      expect(result.stdout).toBe("1\n2\n3\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
