import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("strings with binary files", () => {
  it("extracts strings from binary data with null terminators", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x68,
          0x65,
          0x6c,
          0x6c,
          0x6f, // hello
          0x00, // null terminator
          0x01,
          0x02,
          0x03, // binary garbage
          0x77,
          0x6f,
          0x72,
          0x6c,
          0x64, // world
          0x00 // null terminator
        ])
      }
    });

    const result = await env.exec("strings /binary.bin");
    expect(result.stdout).toBe("hello\nworld\n");
    expect(result.exitCode).toBe(0);
  });

  it("handles mixed binary and text content", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x7f,
          0x45,
          0x4c,
          0x46, // ELF magic
          0x02,
          0x01,
          0x01,
          0x00, // binary header
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x74,
          0x65,
          0x73,
          0x74,
          0x5f,
          0x66,
          0x75,
          0x6e,
          0x63, // test_func
          0x00,
          0x00,
          0x00, // padding
          0x6d,
          0x61,
          0x69,
          0x6e, // main
          0x00 // null
        ])
      }
    });

    const result = await env.exec("strings /binary.bin");
    expect(result.stdout).toContain("test_func");
    expect(result.stdout).toContain("main");
    expect(result.exitCode).toBe(0);
  });

  it("filters strings shorter than minimum length with binary file", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x61,
          0x62, // ab (2 chars)
          0x00,
          0x63,
          0x64,
          0x65, // cde (3 chars)
          0x00,
          0x66,
          0x67,
          0x68,
          0x69, // fghi (4 chars)
          0x00
        ])
      }
    });

    const result = await env.exec("strings /binary.bin");
    expect(result.stdout).toBe("fghi\n");
    expect(result.exitCode).toBe(0);
  });

  it("handles -n option with binary file", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x61,
          0x62, // ab
          0x00,
          0x63,
          0x64,
          0x65, // cde
          0x00,
          0x66,
          0x67,
          0x68,
          0x69,
          0x6a,
          0x6b, // fghijk (6 chars)
          0x00
        ])
      }
    });

    const result = await env.exec("strings -n 6 /binary.bin");
    expect(result.stdout).toBe("fghijk\n");
    expect(result.exitCode).toBe(0);
  });

  it("handles -t d option with binary file", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x00,
          0x00,
          0x00,
          0x00, // 4 null bytes (offset 0-3)
          0x74,
          0x65,
          0x73,
          0x74, // test (at offset 4)
          0x00
        ])
      }
    });

    const result = await env.exec("strings -t d /binary.bin");
    expect(result.stdout).toContain("4 test");
    expect(result.exitCode).toBe(0);
  });

  it("handles -t x option with binary file", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          // 16 null bytes to get to offset 0x10
          ...Array(16).fill(0x00),
          0x68,
          0x65,
          0x78,
          0x74, // hext
          0x00
        ])
      }
    });

    const result = await env.exec("strings -t x /binary.bin");
    expect(result.stdout).toContain("10 hext"); // 0x10 in hex
    expect(result.exitCode).toBe(0);
  });

  it("extracts all printable ASCII characters", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          // Some printable ASCII: space through tilde
          0x20,
          0x41,
          0x42,
          0x43, // " ABC"
          0x7e, // ~
          0x00
        ])
      }
    });

    const result = await env.exec("strings -n 1 /binary.bin");
    expect(result.stdout).toContain(" ABC~");
    expect(result.exitCode).toBe(0);
  });

  it("ignores non-printable bytes", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x01,
          0x02,
          0x03,
          0x04, // control chars
          0x74,
          0x65,
          0x73,
          0x74, // test
          0x80,
          0x81,
          0x82,
          0x83 // high bytes
        ])
      }
    });

    const result = await env.exec("strings /binary.bin");
    expect(result.stdout).toBe("test\n");
    expect(result.exitCode).toBe(0);
  });

  it("handles tabs as printable characters", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x61,
          0x09,
          0x62,
          0x09,
          0x63, // a\tb\tc
          0x00
        ])
      }
    });

    const result = await env.exec("strings /binary.bin");
    expect(result.stdout).toBe("a\tb\tc\n");
    expect(result.exitCode).toBe(0);
  });

  it("handles long binary file with many strings", async () => {
    // Create a file with multiple strings separated by binary data
    const strings = ["function1", "variable_x", "CONSTANT", "main", "printf"];
    const parts: number[] = [];

    for (const str of strings) {
      // Add some binary garbage before each string
      parts.push(0x00, 0x01, 0x02, 0xff, 0xfe, 0x80);
      // Add the string
      for (const char of str) {
        parts.push(char.charCodeAt(0));
      }
      // Add null terminator
      parts.push(0x00);
    }

    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array(parts)
      }
    });

    const result = await env.exec("strings /binary.bin");
    expect(result.exitCode).toBe(0);
    for (const str of strings) {
      expect(result.stdout).toContain(str);
    }
  });

  it("handles empty binary file", async () => {
    const env = new Bash({
      files: {
        "/empty.bin": new Uint8Array([])
      }
    });

    const result = await env.exec("strings /empty.bin");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("handles binary file with only non-printable bytes", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe])
      }
    });

    const result = await env.exec("strings /binary.bin");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("handles binary file with string at very end", async () => {
    const env = new Bash({
      files: {
        "/binary.bin": new Uint8Array([
          0x00,
          0x01,
          0x02,
          0x03, // binary
          0x74,
          0x65,
          0x73,
          0x74 // test (no null terminator at end)
        ])
      }
    });

    const result = await env.exec("strings /binary.bin");
    expect(result.stdout).toBe("test\n");
    expect(result.exitCode).toBe(0);
  });
});
