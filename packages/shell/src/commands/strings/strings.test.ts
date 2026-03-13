import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("strings", () => {
  describe("basic functionality", () => {
    it("extracts strings from text", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'hello world' | strings");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world\n");
    });

    it("filters strings shorter than minimum length", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf 'ab\\x00cd\\x00efgh' | strings");
      expect(result.exitCode).toBe(0);
      // Only 'efgh' meets the default minimum of 4
      expect(result.stdout).toBe("efgh\n");
    });

    it("handles multiple strings", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'hello\\x00\\x00world\\x00\\x00test' | strings"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\nworld\ntest\n");
    });

    it("handles empty input", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf '' | strings");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("handles file input", async () => {
      const bash = new Bash({
        files: {
          "/test.bin": "hello\x00\x00\x00world"
        }
      });
      const result = await bash.exec("strings /test.bin");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\nworld\n");
    });
  });

  describe("-n option", () => {
    it("changes minimum string length with -n N", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'ab\\x00cde\\x00fghi' | strings -n 3"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("cde\nfghi\n");
    });

    it("changes minimum string length with -nN", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'ab\\x00cde\\x00fghi' | strings -n3"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("cde\nfghi\n");
    });

    it("changes minimum string length with -N shorthand", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'ab\\x00cde\\x00fghij' | strings -5"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("fghij\n");
    });

    it("errors on invalid minimum length", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | strings -n abc");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid minimum string length");
    });

    it("errors on zero minimum length", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | strings -n 0");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid minimum string length");
    });

    it("errors on zero minimum length with -N shorthand", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | strings -0");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid minimum string length");
    });
  });

  describe("-t option", () => {
    it("shows decimal offset with -t d", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'hello\\x00\\x00\\x00world' | strings -t d"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("0 hello");
      expect(result.stdout).toContain("8 world");
    });

    it("shows hex offset with -t x", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'hello\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00world' | strings -t x"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("0 hello");
      // 5 bytes for hello + 11 null bytes = offset 16 = 0x10
      expect(result.stdout).toContain("10 world");
    });

    it("shows octal offset with -t o", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'hello\\x00\\x00\\x00world' | strings -t o"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("0 hello");
      expect(result.stdout).toContain("10 world"); // 8 in octal is 10
    });

    it("supports combined -tFORMAT form", async () => {
      const bash = new Bash();
      const result = await bash.exec(
        "printf 'hello\\x00\\x00\\x00world' | strings -td"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("0 hello");
    });

    it("errors on invalid offset format", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | strings -t z");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid radix");
    });
  });

  describe("-e option", () => {
    it("accepts -e s encoding", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'hello' | strings -e s");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
    });

    it("accepts -e S encoding", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'hello' | strings -e S");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
    });

    it("errors on invalid encoding", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | strings -e b");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid encoding");
    });
  });

  describe("edge cases", () => {
    it("handles tabs as printable", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf 'hello\\tworld' | strings");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\tworld\n");
    });

    it("handles binary data with mixed content", async () => {
      const bash = new Bash();
      // Binary with embedded strings
      const result = await bash.exec(
        "printf '\\x01\\x02\\x03hello\\x00\\x01\\x02\\x03\\x04world\\x00\\x01' | strings"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\nworld\n");
    });

    it("handles string at end of input without null terminator", async () => {
      const bash = new Bash();
      const result = await bash.exec("printf 'hello' | strings");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
    });

    it("handles multiple files", async () => {
      const bash = new Bash({
        files: {
          "/a.bin": "file_a",
          "/b.bin": "file_b"
        }
      });
      const result = await bash.exec("strings /a.bin /b.bin");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("file_a\nfile_b\n");
    });

    it("handles dash as stdin indicator", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'hello world' | strings -");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello world\n");
    });

    it("handles -- to end options", async () => {
      const bash = new Bash({
        files: {
          "/-test": "dash_file"
        }
      });
      const result = await bash.exec("strings -- /-test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("dash_file\n");
    });
  });

  describe("error handling", () => {
    it("errors on unknown flag", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | strings -z");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid option");
    });

    it("errors on unknown long flag", async () => {
      const bash = new Bash();
      const result = await bash.exec("echo 'test' | strings --unknown");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unrecognized option");
    });

    it("errors on missing file", async () => {
      const bash = new Bash();
      const result = await bash.exec("strings /nonexistent");
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toLowerCase()).toContain(
        "no such file or directory"
      );
    });

    it("shows help with --help", async () => {
      const bash = new Bash();
      const result = await bash.exec("strings --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("strings");
      expect(result.stdout).toContain("Usage");
    });
  });
});
