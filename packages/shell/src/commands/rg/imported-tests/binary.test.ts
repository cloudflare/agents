/**
 * Tests imported from ripgrep: tests/binary.rs
 *
 * These tests cover binary file detection and handling.
 * ripgrep skips binary files by default (files containing NUL bytes).
 *
 * Note: Many ripgrep binary tests involve --mmap, --binary, and --text flags
 * which we don't fully support. This file contains applicable tests.
 */
import { describe, expect, it } from "vitest";
import { Bash } from "../../../Shell";

// Simple binary content with NUL byte
const BINARY_CONTENT = "hello\x00world\n";
const TEXT_CONTENT = "hello world\n";

describe("rg binary: basic detection", () => {
  it("should skip binary files by default in directory search", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/text.txt": TEXT_CONTENT,
        "/home/user/binary.bin": BINARY_CONTENT
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    // Should only find match in text file, not binary
    expect(result.stdout).toBe("text.txt:1:hello world\n");
  });

  it("should skip binary files when searching single explicit file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/binary.bin": BINARY_CONTENT
      }
    });
    const result = await bash.exec("rg hello binary.bin");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("should detect binary in first 8KB of file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        // NUL byte early in file
        "/home/user/early.bin": `\x00${"a".repeat(100)}pattern\n`
      }
    });
    const result = await bash.exec("rg pattern");
    expect(result.exitCode).toBe(1);
  });

  it("should not detect binary if NUL after 8KB sample", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        // NUL byte after 8KB - won't be detected in sample
        "/home/user/late.txt": `pattern\n${"a".repeat(9000)}\x00end\n`
      }
    });
    const result = await bash.exec("rg pattern");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("late.txt:1:pattern\n");
  });
});

describe("rg binary: with count flag", () => {
  it("should not count matches in binary files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/text.txt": "match\nmatch\n",
        "/home/user/binary.bin": "match\x00match\n"
      }
    });
    const result = await bash.exec("rg -c match");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("text.txt:2\n");
  });
});

describe("rg binary: with files-with-matches flag", () => {
  it("should not list binary files with -l", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/text.txt": "findme\n",
        "/home/user/binary.bin": "findme\x00\n"
      }
    });
    const result = await bash.exec("rg -l findme");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("text.txt\n");
  });
});

describe("rg binary: mixed content", () => {
  it("should only search text files in mixed directory", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/readme.md": "documentation\n",
        "/home/user/image.png": "\x89PNG\r\n\x1a\n\x00\x00\x00",
        "/home/user/script.sh": "echo documentation\n"
      }
    });
    const result = await bash.exec("rg --sort path documentation");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "readme.md:1:documentation\nscript.sh:1:echo documentation\n"
    );
  });

  it("should handle multiple binary and text files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.txt": "test\n",
        "/home/user/b.bin": "test\x00\n",
        "/home/user/c.txt": "test\n",
        "/home/user/d.bin": "test\x00\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a.txt:1:test\nc.txt:1:test\n");
  });
});

describe("rg binary: edge cases", () => {
  it("should handle file with only NUL bytes", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/nulls.bin": "\x00\x00\x00\x00"
      }
    });
    const result = await bash.exec("rg anything");
    expect(result.exitCode).toBe(1);
  });

  it("should handle NUL at start of file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/start.bin": "\x00hello world\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(1);
  });

  it("should handle NUL at end of file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/end.bin": "hello world\n\x00"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(1);
  });

  it("should handle multiple NUL bytes", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/multi.bin": "a\x00b\x00c\x00d\n"
      }
    });
    const result = await bash.exec("rg '[a-d]'");
    expect(result.exitCode).toBe(1);
  });
});

describe("rg binary: common binary file types", () => {
  it("should skip files with common binary signatures", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        // PNG signature
        "/home/user/image.png": "\x89PNG\r\n\x1a\n\x00data",
        // PDF signature (simplified)
        "/home/user/doc.pdf": "%PDF-1.4\n\x00binary",
        // ZIP signature
        "/home/user/archive.zip": "PK\x03\x04\x00\x00data",
        // Text file for comparison
        "/home/user/text.txt": "data\n"
      }
    });
    const result = await bash.exec("rg data");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("text.txt:1:data\n");
  });
});

describe("rg binary: with other flags", () => {
  it("should work with -i flag", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/text.txt": "HELLO world\n",
        "/home/user/binary.bin": "HELLO\x00world\n"
      }
    });
    const result = await bash.exec("rg -i hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("text.txt:1:HELLO world\n");
  });

  it("should work with -v flag", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/text.txt": "keep\nremove\nkeep\n",
        "/home/user/binary.bin": "keep\x00remove\n"
      }
    });
    const result = await bash.exec("rg -v remove");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("text.txt:1:keep\ntext.txt:3:keep\n");
  });

  it("should work with -w flag", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/text.txt": "foo bar\nfoobar\n",
        "/home/user/binary.bin": "foo bar\x00\n"
      }
    });
    const result = await bash.exec("rg -w foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("text.txt:1:foo bar\n");
  });

  it("should work with context flags", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/text.txt": "before\nmatch\nafter\n",
        "/home/user/binary.bin": "before\x00match\nafter\n"
      }
    });
    const result = await bash.exec("rg -C1 match");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "text.txt-1-before\ntext.txt:2:match\ntext.txt-3-after\n"
    );
  });

  it("should work with -m flag", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/text.txt": "match\nmatch\nmatch\n",
        "/home/user/binary.bin": "match\x00match\n"
      }
    });
    const result = await bash.exec("rg -m1 match");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("text.txt:1:match\n");
  });
});

describe("rg binary: subdirectories", () => {
  it("should skip binary files in subdirectories", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/src/code.ts": "export const x = 1;\n",
        "/home/user/assets/image.bin": "export\x00data\n",
        "/home/user/lib/util.ts": "export function foo() {}\n"
      }
    });
    const result = await bash.exec("rg --sort path export");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "lib/util.ts:1:export function foo() {}\nsrc/code.ts:1:export const x = 1;\n"
    );
  });
});

// ============================================================================
// SKIPPED TESTS - Features not implemented or require special handling
// ============================================================================

// Memory-mapped file tests - mmap not supported
it.skip("mmap_match_implicit: memory map not supported", () => {});
it.skip("mmap_match_explicit: memory map not supported", () => {});
it.skip("mmap_match_near_nul: memory map not supported", () => {});
it.skip("mmap_match_count: memory map not supported", () => {});
it.skip("mmap_match_multiple: memory map not supported", () => {});
it.skip("mmap_binary_flag: memory map not supported", () => {});
it.skip("mmap_text_flag: memory map not supported", () => {});
it.skip("mmap_after_nul_match: memory map not supported", () => {});

// Stdin tests - requires stdin piping
it.skip("after_match1_stdin: stdin piping not supported", () => {});

// Binary file warning message test
it.skip("matching_files_inconsistent_with_count: complex binary filtering not implemented", () => {});
