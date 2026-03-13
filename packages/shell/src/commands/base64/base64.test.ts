import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("base64", () => {
  describe("encoding", () => {
    it("should encode string from stdin", async () => {
      const env = new Bash();
      const result = await env.exec('echo -n "hello" | base64');
      expect(result.stdout).toBe("aGVsbG8=\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should encode string with newline", async () => {
      const env = new Bash();
      const result = await env.exec('echo "hello" | base64');
      expect(result.stdout).toBe("aGVsbG8K\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should encode file contents", async () => {
      const env = new Bash({
        files: { "/test.txt": "hello" }
      });
      const result = await env.exec("base64 /test.txt");
      expect(result.stdout).toBe("aGVsbG8=\n");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should wrap lines at 76 characters by default", async () => {
      const env = new Bash();
      // Long input that will produce > 76 chars of base64
      const result = await env.exec(
        'echo -n "This is a very long string that will definitely produce more than 76 characters of base64 output" | base64'
      );
      const lines = result.stdout.split("\n").filter((l) => l);
      expect(lines[0].length).toBeLessThanOrEqual(76);
      expect(result.exitCode).toBe(0);
    });

    it("should not wrap with -w 0", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo -n "This is a very long string that will definitely produce more than 76 characters of base64 output" | base64 -w 0'
      );
      // Should be single line (no newline wrapping, just trailing newline)
      expect(result.stdout).not.toContain("\n\n");
      expect(result.exitCode).toBe(0);
    });

    it("should wrap at custom width", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo -n "hello world test" | base64 -w 10'
      );
      const lines = result.stdout.split("\n").filter((l) => l);
      for (const line of lines.slice(0, -1)) {
        expect(line.length).toBe(10);
      }
      expect(result.exitCode).toBe(0);
    });
  });

  describe("decoding", () => {
    it("should decode base64 with -d", async () => {
      const env = new Bash();
      const result = await env.exec('echo "aGVsbG8=" | base64 -d');
      expect(result.stdout).toBe("hello");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should decode base64 with --decode", async () => {
      const env = new Bash();
      const result = await env.exec('echo "aGVsbG8=" | base64 --decode');
      expect(result.stdout).toBe("hello");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should decode base64 from file", async () => {
      const env = new Bash({
        files: { "/encoded.txt": "aGVsbG8gd29ybGQ=" }
      });
      const result = await env.exec("base64 -d /encoded.txt");
      expect(result.stdout).toBe("hello world");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    });

    it("should ignore whitespace when decoding", async () => {
      const env = new Bash();
      const result = await env.exec('echo "aGVs\nbG8=" | base64 -d');
      expect(result.stdout).toBe("hello");
      expect(result.exitCode).toBe(0);
    });

    it("should roundtrip encode then decode", async () => {
      const env = new Bash();
      const result = await env.exec(
        'echo -n "test data 123" | base64 | base64 -d'
      );
      expect(result.stdout).toBe("test data 123");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error handling", () => {
    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("base64 /nonexistent.txt");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "base64: /nonexistent.txt: No such file or directory\n"
      );
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown option", async () => {
      const env = new Bash();
      const result = await env.exec("base64 --unknown");
      expect(result.stderr).toContain("unrecognized option");
      expect(result.exitCode).toBe(1);
    });

    it("should error on unknown short option", async () => {
      const env = new Bash();
      const result = await env.exec("base64 -z");
      expect(result.stderr).toContain("invalid option");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("help", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("base64 --help");
      expect(result.stdout).toContain("base64");
      expect(result.stdout).toContain("decode");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("stdin placeholder", () => {
    it("should read from stdin with -", async () => {
      const env = new Bash();
      const result = await env.exec('echo -n "test" | base64 -');
      expect(result.stdout).toBe("dGVzdA==\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("binary files", () => {
    it("should encode binary data with invalid UTF-8 bytes", async () => {
      // PNG magic bytes include 0x89 which is invalid UTF-8
      // If read as UTF-8, it would be corrupted to replacement char
      const env = new Bash({
        files: {
          "/binary.dat": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])
        }
      });
      const result = await env.exec("base64 /binary.dat");
      // Base64 of bytes [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A] is "iVBORw0K"
      expect(result.stdout).toBe("iVBORw0K\n");
      expect(result.exitCode).toBe(0);
    });

    it("should encode binary file with null bytes", async () => {
      const env = new Bash({
        files: {
          "/nulls.dat": new Uint8Array([0x00, 0x00, 0x00, 0x00])
        }
      });
      const result = await env.exec("base64 /nulls.dat");
      // Base64 of 4 null bytes is "AAAAAA=="
      expect(result.stdout).toBe("AAAAAA==\n");
      expect(result.exitCode).toBe(0);
    });

    it("should encode binary file with high bytes", async () => {
      const env = new Bash({
        files: {
          "/high.dat": new Uint8Array([0xff, 0xfe, 0xfd, 0xfc])
        }
      });
      const result = await env.exec("base64 /high.dat");
      // Base64 of [0xFF, 0xFE, 0xFD, 0xFC] is "//79/A=="
      expect(result.stdout).toBe("//79/A==\n");
      expect(result.exitCode).toBe(0);
    });
  });
});
