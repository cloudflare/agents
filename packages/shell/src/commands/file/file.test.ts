import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("file", () => {
  describe("binary files", () => {
    it("should detect PNG files from magic bytes", async () => {
      const env = new Bash();
      // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      const pngMagic = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        // Minimal IHDR chunk
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xde
      ]);
      await env.fs.writeFile("/tmp/test.png", pngMagic);
      const result = await env.exec("file /tmp/test.png");
      expect(result.stdout).toBe("/tmp/test.png: PNG image data\n");
      expect(result.exitCode).toBe(0);
    });

    it("should detect GIF files from magic bytes", async () => {
      const env = new Bash();
      // GIF89a magic bytes
      const gifMagic = new Uint8Array([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00,
        0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00,
        0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
        0x3b
      ]);
      await env.fs.writeFile("/tmp/test.gif", gifMagic);
      const result = await env.exec("file /tmp/test.gif");
      expect(result.stdout).toBe("/tmp/test.gif: GIF image data\n");
      expect(result.exitCode).toBe(0);
    });

    it("should detect ZIP files from magic bytes", async () => {
      // Minimal valid ZIP file (local header + central dir + end record)
      const zipData = new Uint8Array([
        0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3d, 0x3a,
        0x6d, 0x5c, 0x86, 0xa6, 0x10, 0x36, 0x05, 0x00, 0x00, 0x00, 0x05, 0x00,
        0x00, 0x00, 0x08, 0x00, 0x1c, 0x00, 0x74, 0x65, 0x73, 0x74, 0x2e, 0x74,
        0x78, 0x74, 0x55, 0x54, 0x09, 0x00, 0x03, 0x16, 0xac, 0xb3, 0x69, 0x16,
        0xac, 0xb3, 0x69, 0x75, 0x78, 0x0b, 0x00, 0x01, 0x04, 0xf5, 0x01, 0x00,
        0x00, 0x04, 0x14, 0x00, 0x00, 0x00, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x50,
        0x4b, 0x01, 0x02, 0x1e, 0x03, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3d,
        0x3a, 0x6d, 0x5c, 0x86, 0xa6, 0x10, 0x36, 0x05, 0x00, 0x00, 0x00, 0x05,
        0x00, 0x00, 0x00, 0x08, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0xa4, 0x81, 0x00, 0x00, 0x00, 0x00, 0x74, 0x65, 0x73,
        0x74, 0x2e, 0x74, 0x78, 0x74, 0x55, 0x54, 0x05, 0x00, 0x03, 0x16, 0xac,
        0xb3, 0x69, 0x75, 0x78, 0x0b, 0x00, 0x01, 0x04, 0xf5, 0x01, 0x00, 0x00,
        0x04, 0x14, 0x00, 0x00, 0x00, 0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00,
        0x00, 0x01, 0x00, 0x01, 0x00, 0x4e, 0x00, 0x00, 0x00, 0x47, 0x00, 0x00,
        0x00, 0x00, 0x00
      ]);
      const env = new Bash({
        files: { "/tmp/test.zip": zipData }
      });
      const result = await env.exec("file /tmp/test.zip");
      expect(result.stdout).toBe("/tmp/test.zip: Zip archive data\n");
      expect(result.exitCode).toBe(0);
    });

    it("should detect PDF files from magic bytes", async () => {
      const env = new Bash();
      // PDF magic: %PDF-
      const pdfMagic = new Uint8Array([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a
      ]);
      await env.fs.writeFile("/tmp/test.pdf", pdfMagic);
      const result = await env.exec("file /tmp/test.pdf");
      expect(result.stdout).toBe("/tmp/test.pdf: PDF document\n");
      expect(result.exitCode).toBe(0);
    });

    it("should return correct MIME type for binary files with -i", async () => {
      const env = new Bash();
      // PNG magic bytes
      const pngMagic = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde
      ]);
      await env.fs.writeFile("/tmp/test.png", pngMagic);
      const result = await env.exec("file -i /tmp/test.png");
      expect(result.stdout).toBe("/tmp/test.png: image/png\n");
      expect(result.exitCode).toBe(0);
    });

    it("should not corrupt binary data when detecting file type", async () => {
      // Test that bytes like 0x89 (invalid UTF-8) are preserved
      // Previously the file command read files as UTF-8 strings which corrupted binary data
      const env = new Bash({
        files: {
          // PNG magic: 89 50 4E 47 followed by more bytes
          "/binary.png": new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00,
            0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
            0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde
          ])
        }
      });

      // If binary data was corrupted (read as UTF-8 then converted back),
      // 0x89 would become U+FFFD and file-type would not recognize PNG magic
      const result = await env.exec("file /binary.png");
      expect(result.stdout).toBe("/binary.png: PNG image data\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("text files", () => {
    it("should detect ASCII text", async () => {
      const env = new Bash();
      await env.exec("echo 'hello world' > /tmp/test.txt");
      const result = await env.exec("file /tmp/test.txt");
      expect(result.stdout).toBe("/tmp/test.txt: ASCII text\n");
      expect(result.exitCode).toBe(0);
    });

    it("should detect empty files", async () => {
      const env = new Bash();
      await env.exec("touch /tmp/empty");
      const result = await env.exec("file /tmp/empty");
      expect(result.stdout).toBe("/tmp/empty: empty\n");
      expect(result.exitCode).toBe(0);
    });

    it("should detect CRLF line endings", async () => {
      const env = new Bash();
      // Use $'...' syntax or echo -e to properly create CRLF
      await env.exec("echo -e 'line1\\r\\nline2' > /tmp/crlf.txt");
      const result = await env.exec("file /tmp/crlf.txt");
      // The file command should detect CRLF line terminators
      expect(result.stdout).toBe(
        "/tmp/crlf.txt: ASCII text, with CRLF line terminators\n"
      );
      expect(result.exitCode).toBe(0);
    });

    it("should detect shell scripts by shebang", async () => {
      const env = new Bash();
      await env.exec("echo '#!/bin/bash\\necho hello' > /tmp/script.sh");
      const result = await env.exec("file /tmp/script.sh");
      expect(result.stdout).toBe(
        "/tmp/script.sh: Bourne-Again shell script, ASCII text executable\n"
      );
      expect(result.exitCode).toBe(0);
    });

    it("should detect Python scripts by shebang", async () => {
      const env = new Bash();
      await env.exec(
        "echo '#!/usr/bin/env python3\\nprint(1)' > /tmp/script.py"
      );
      const result = await env.exec("file /tmp/script.py");
      expect(result.stdout).toBe(
        "/tmp/script.py: Python script, ASCII text executable\n"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("extension-based detection", () => {
    it("should detect TypeScript files", async () => {
      const env = new Bash();
      await env.exec("echo 'const x: number = 1;' > /tmp/test.ts");
      const result = await env.exec("file /tmp/test.ts");
      expect(result.stdout).toBe("/tmp/test.ts: TypeScript source\n");
      expect(result.exitCode).toBe(0);
    });

    it("should detect JavaScript files", async () => {
      const env = new Bash();
      await env.exec("echo 'const x = 1;' > /tmp/test.js");
      const result = await env.exec("file /tmp/test.js");
      expect(result.stdout).toBe("/tmp/test.js: JavaScript source\n");
      expect(result.exitCode).toBe(0);
    });

    it("should detect JSON files", async () => {
      const env = new Bash();
      await env.exec('echo \'{"key": "value"}\' > /tmp/test.json');
      const result = await env.exec("file /tmp/test.json");
      expect(result.stdout).toBe("/tmp/test.json: JSON data\n");
      expect(result.exitCode).toBe(0);
    });

    it("should detect Markdown files", async () => {
      const env = new Bash();
      await env.exec("echo '# Hello' > /tmp/test.md");
      const result = await env.exec("file /tmp/test.md");
      expect(result.stdout).toBe("/tmp/test.md: Markdown document\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("directories", () => {
    it("should detect directories", async () => {
      const env = new Bash();
      await env.exec("mkdir -p /tmp/testdir");
      const result = await env.exec("file /tmp/testdir");
      expect(result.stdout).toBe("/tmp/testdir: directory\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("options", () => {
    it("should support -b (brief) mode", async () => {
      const env = new Bash();
      await env.exec("echo 'hello' > /tmp/test.txt");
      const result = await env.exec("file -b /tmp/test.txt");
      expect(result.stdout).toBe("ASCII text\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support -i (mime) mode", async () => {
      const env = new Bash();
      await env.exec("echo 'hello' > /tmp/test.txt");
      const result = await env.exec("file -i /tmp/test.txt");
      expect(result.stdout).toBe("/tmp/test.txt: text/plain\n");
      expect(result.exitCode).toBe(0);
    });

    it("should support combined -bi mode", async () => {
      const env = new Bash();
      await env.exec("mkdir -p /tmp/mimedir");
      const result = await env.exec("file -bi /tmp/mimedir");
      expect(result.stdout).toBe("inode/directory\n");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("multiple files", () => {
    it("should handle multiple files", async () => {
      const env = new Bash();
      await env.exec("echo 'text' > /tmp/a.txt");
      await env.exec("echo 'more' > /tmp/b.txt");
      const result = await env.exec("file /tmp/a.txt /tmp/b.txt");
      expect(result.stdout).toBe(
        "/tmp/a.txt: ASCII text\n/tmp/b.txt: ASCII text\n"
      );
      expect(result.exitCode).toBe(0);
    });
  });

  describe("error handling", () => {
    it("should error on missing file", async () => {
      const env = new Bash();
      const result = await env.exec("file /tmp/nonexistent");
      expect(result.stdout).toBe(
        "/tmp/nonexistent: cannot open (No such file or directory)\n"
      );
      expect(result.exitCode).toBe(1);
    });

    it("should error with no arguments", async () => {
      const env = new Bash();
      const result = await env.exec("file");
      expect(result.stderr).toBe("Usage: file [-bLi] FILE...\n");
      expect(result.exitCode).toBe(1);
    });
  });

  describe("--help", () => {
    it("should display help", async () => {
      const env = new Bash();
      const result = await env.exec("file --help");
      expect(result.stdout).toBe(`file - determine file type

Usage: file [OPTION]... FILE...

Options:
  -b, --brief          do not prepend filenames to output
  -i, --mime           output MIME type strings
  -L, --dereference    follow symlinks
      --help           display this help and exit
`);
      expect(result.exitCode).toBe(0);
    });
  });
});
