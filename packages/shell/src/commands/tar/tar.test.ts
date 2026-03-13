import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("tar", () => {
  describe("help and errors", () => {
    it("should show help with --help", async () => {
      const env = new Bash();
      const result = await env.exec("tar --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("tar - manipulate tape archives");
      expect(result.stdout).toContain("-c, --create");
      expect(result.stdout).toContain("-x, --extract");
      expect(result.stdout).toContain("-t, --list");
    });

    it("should error without operation mode", async () => {
      const env = new Bash();
      const result = await env.exec("tar -f archive.tar");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "You must specify one of -c, -r, -u, -x, or -t"
      );
    });

    it("should error with multiple operation modes", async () => {
      const env = new Bash();
      const result = await env.exec("tar -c -x -f archive.tar");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("You may not specify more than one");
    });

    it("should error on unknown option", async () => {
      const env = new Bash();
      const result = await env.exec("tar -c --unknown-option file.txt");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unrecognized option");
    });

    it("should error when -f is missing argument", async () => {
      const env = new Bash();
      const result = await env.exec("tar -c -f");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("option requires an argument");
    });
  });

  describe("create (-c)", () => {
    it("should create archive from single file", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, World!"
        }
      });
      const result = await env.exec("tar -cf /archive.tar /test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      // Verify archive was created
      const stat = await env.exec("stat /archive.tar");
      expect(stat.exitCode).toBe(0);
    });

    it("should create archive with verbose output", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, World!"
        }
      });
      const result = await env.exec("tar -cvf /archive.tar /test.txt");
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr (like real tar)
      expect(result.stderr).toContain("test.txt");
    });

    it("should create archive from multiple files", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "Content 1",
          "/file2.txt": "Content 2"
        }
      });
      const result = await env.exec(
        "tar -cvf /archive.tar /file1.txt /file2.txt"
      );
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr
      expect(result.stderr).toContain("file1.txt");
      expect(result.stderr).toContain("file2.txt");
    });

    it("should create archive from directory", async () => {
      const env = new Bash({
        files: {
          "/mydir/file1.txt": "Content 1",
          "/mydir/file2.txt": "Content 2",
          "/mydir/subdir/nested.txt": "Nested content"
        }
      });
      const result = await env.exec("tar -cvf /archive.tar /mydir");
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr
      expect(result.stderr).toContain("mydir");
      expect(result.stderr).toContain("file1.txt");
      expect(result.stderr).toContain("file2.txt");
      expect(result.stderr).toContain("nested.txt");
    });

    it("should create archive with -C directory option", async () => {
      const env = new Bash({
        files: {
          "/source/file.txt": "Content"
        }
      });
      const result = await env.exec(
        "tar -cvf /archive.tar -C /source file.txt"
      );
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr
      expect(result.stderr).toBe("file.txt\n");
    });

    it("should error when creating empty archive", async () => {
      const env = new Bash();
      const result = await env.exec("tar -cf /archive.tar");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(
        "Cowardly refusing to create an empty archive"
      );
    });

    it("should handle combined short options -cvf", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello"
        }
      });
      const result = await env.exec("tar -cvf /archive.tar /test.txt");
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr
      expect(result.stderr).toContain("test.txt");
    });

    it("should exclude files with --exclude", async () => {
      const env = new Bash({
        files: {
          "/mydir/keep.txt": "Keep this",
          "/mydir/skip.log": "Skip this"
        }
      });
      const result = await env.exec(
        "tar -cvf /archive.tar --exclude=*.log /mydir"
      );
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr
      expect(result.stderr).toContain("keep.txt");
      expect(result.stderr).not.toContain("skip.log");
    });
  });

  describe("list (-t)", () => {
    it("should list archive contents", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, World!"
        }
      });
      await env.exec("tar -cf /archive.tar /test.txt");
      const result = await env.exec("tar -tf /archive.tar");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("test.txt");
    });

    it("should list archive contents with verbose", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, World!"
        }
      });
      await env.exec("tar -cf /archive.tar /test.txt");
      const result = await env.exec("tar -tvf /archive.tar");
      expect(result.exitCode).toBe(0);
      // Verbose output includes permissions, size, date
      expect(result.stdout).toMatch(/-r.+test\.txt/);
    });

    it("should list directory archive contents", async () => {
      const env = new Bash({
        files: {
          "/mydir/file1.txt": "Content 1",
          "/mydir/file2.txt": "Content 2"
        }
      });
      await env.exec("tar -cf /archive.tar /mydir");
      const result = await env.exec("tar -tf /archive.tar");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("mydir");
      expect(result.stdout).toContain("file1.txt");
      expect(result.stdout).toContain("file2.txt");
    });

    it("should error when archive does not exist", async () => {
      const env = new Bash();
      const result = await env.exec("tar -tf /nonexistent.tar");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot open");
    });

    it("should list specific file from archive", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "Content 1",
          "/file2.txt": "Content 2"
        }
      });
      await env.exec("tar -cf /archive.tar /file1.txt /file2.txt");
      const result = await env.exec("tar -tf /archive.tar /file1.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("file1.txt");
      expect(result.stdout).not.toContain("file2.txt");
    });
  });

  describe("extract (-x)", () => {
    it("should extract archive", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, World!"
        }
      });
      await env.exec("tar -cf /archive.tar /test.txt");
      await env.exec("rm /test.txt");
      const result = await env.exec("tar -xf /archive.tar");
      expect(result.exitCode).toBe(0);

      // Verify file was extracted
      const cat = await env.exec("cat /test.txt");
      expect(cat.stdout).toBe("Hello, World!");
    });

    it("should extract archive with verbose output", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, World!"
        }
      });
      await env.exec("tar -cf /archive.tar /test.txt");
      await env.exec("rm /test.txt");
      const result = await env.exec("tar -xvf /archive.tar");
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr
      expect(result.stderr).toContain("test.txt");
    });

    it("should extract to different directory with -C", async () => {
      const env = new Bash({
        files: {
          "/source/test.txt": "Hello"
        }
      });
      await env.exec("tar -cf /archive.tar -C /source test.txt");
      await env.exec("mkdir /dest");
      const result = await env.exec("tar -xf /archive.tar -C /dest");
      expect(result.exitCode).toBe(0);

      const cat = await env.exec("cat /dest/test.txt");
      expect(cat.stdout).toBe("Hello");
    });

    it("should extract directory structure", async () => {
      const env = new Bash({
        files: {
          "/mydir/file1.txt": "Content 1",
          "/mydir/subdir/file2.txt": "Content 2"
        }
      });
      await env.exec("tar -cf /archive.tar /mydir");
      await env.exec("rm -rf /mydir");
      const result = await env.exec("tar -xvf /archive.tar");
      expect(result.exitCode).toBe(0);

      const cat1 = await env.exec("cat /mydir/file1.txt");
      expect(cat1.stdout).toBe("Content 1");

      const cat2 = await env.exec("cat /mydir/subdir/file2.txt");
      expect(cat2.stdout).toBe("Content 2");
    });

    it("should extract specific file from archive", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "Content 1",
          "/file2.txt": "Content 2"
        }
      });
      await env.exec("tar -cf /archive.tar /file1.txt /file2.txt");
      await env.exec("rm /file1.txt /file2.txt");
      const result = await env.exec("tar -xf /archive.tar /file1.txt");
      expect(result.exitCode).toBe(0);

      const cat1 = await env.exec("cat /file1.txt");
      expect(cat1.stdout).toBe("Content 1");

      const cat2 = await env.exec("cat /file2.txt");
      expect(cat2.exitCode).not.toBe(0); // file2 should not be extracted
    });

    it("should strip leading path components", async () => {
      const env = new Bash({
        files: {
          "/deep/nested/path/file.txt": "Content"
        }
      });
      await env.exec("tar -cf /archive.tar /deep/nested/path/file.txt");
      await env.exec("mkdir /dest");
      const result = await env.exec("tar -xf /archive.tar -C /dest --strip=3");
      expect(result.exitCode).toBe(0);

      const cat = await env.exec("cat /dest/file.txt");
      expect(cat.stdout).toBe("Content");
    });

    it("should error when archive does not exist", async () => {
      const env = new Bash();
      const result = await env.exec("tar -xf /nonexistent.tar");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot open");
    });
  });

  describe("bzip2 compression (-j)", () => {
    it("should reject bzip2 compression (requires native addons)", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, World!"
        }
      });
      const result = await env.exec("tar -cjvf /archive.tar.bz2 /test.txt");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not supported");
    });
  });

  describe("xz compression (-J)", () => {
    it("should reject xz compression (requires native addons)", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, xz compressed World!"
        }
      });
      const result = await env.exec("tar -cJvf /archive.tar.xz /test.txt");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not supported");
    });
  });

  describe("gzip compression (-z)", () => {
    it("should create gzip compressed archive", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, World! This is some content to compress."
        }
      });
      const result = await env.exec("tar -czvf /archive.tar.gz /test.txt");
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr
      expect(result.stderr).toContain("test.txt");

      // Verify archive was created
      const stat = await env.exec("stat /archive.tar.gz");
      expect(stat.exitCode).toBe(0);
    });

    it("should extract gzip compressed archive", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, compressed World!"
        }
      });
      await env.exec("tar -czvf /archive.tar.gz /test.txt");
      await env.exec("rm /test.txt");
      const result = await env.exec("tar -xzvf /archive.tar.gz");
      expect(result.exitCode).toBe(0);

      const cat = await env.exec("cat /test.txt");
      expect(cat.stdout).toBe("Hello, compressed World!");
    });

    it("should auto-detect gzip compression on extract", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Auto-detect gzip!"
        }
      });
      await env.exec("tar -czf /archive.tar.gz /test.txt");
      await env.exec("rm /test.txt");
      // Extract without -z flag - should auto-detect
      const result = await env.exec("tar -xf /archive.tar.gz");
      expect(result.exitCode).toBe(0);

      const cat = await env.exec("cat /test.txt");
      expect(cat.stdout).toBe("Auto-detect gzip!");
    });

    it("should list gzip compressed archive", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "List gzip content"
        }
      });
      await env.exec("tar -czf /archive.tar.gz /test.txt");
      const result = await env.exec("tar -tzf /archive.tar.gz");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("test.txt");
    });
  });

  describe("symlinks", () => {
    it("should archive and extract symlinks", async () => {
      const env = new Bash({
        files: {
          "/target.txt": "Target content"
        }
      });
      await env.exec("ln -s /target.txt /link.txt");
      await env.exec("tar -cvf /archive.tar /link.txt");

      const list = await env.exec("tar -tvf /archive.tar");
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("link.txt");
    });
  });

  describe("edge cases", () => {
    it("should handle empty directory", async () => {
      const env = new Bash();
      await env.exec("mkdir /emptydir");
      const result = await env.exec("tar -cvf /archive.tar /emptydir");
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr
      expect(result.stderr).toContain("emptydir");

      // Verify it can be listed
      const list = await env.exec("tar -tf /archive.tar");
      expect(list.stdout).toContain("emptydir");
    });

    it("should handle file with special characters in name", async () => {
      const env = new Bash({
        files: {
          "/file with spaces.txt": "Content"
        }
      });
      const result = await env.exec(
        "tar -cvf /archive.tar '/file with spaces.txt'"
      );
      expect(result.exitCode).toBe(0);
      // Verbose output goes to stderr
      expect(result.stderr).toContain("file with spaces.txt");
    });

    it("should handle binary content", async () => {
      const env = new Bash({
        files: {
          "/binary.bin": new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe])
        }
      });
      await env.exec("tar -cf /archive.tar /binary.bin");
      await env.exec("rm /binary.bin");
      await env.exec("tar -xf /archive.tar");

      // Verify binary content is preserved
      const stat = await env.exec("wc -c < /binary.bin");
      expect(stat.stdout.trim()).toBe("5");
    });

    it("should handle large-ish directory tree", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 50; i++) {
        files[`/bigdir/file${i.toString().padStart(3, "0")}.txt`] =
          `Content ${i}`;
      }
      const env = new Bash({ files });

      const result = await env.exec("tar -cf /archive.tar /bigdir");
      expect(result.exitCode).toBe(0);

      const list = await env.exec("tar -tf /archive.tar | wc -l");
      // 50 files + 1 directory = 51 entries
      expect(parseInt(list.stdout.trim(), 10)).toBeGreaterThanOrEqual(50);
    });

    it("should handle long filenames", async () => {
      const longName = `${"a".repeat(150)}.txt`;
      const env = new Bash({
        files: {
          [`/dir/${longName}`]: "Long filename content"
        }
      });
      const result = await env.exec("tar -cvf /archive.tar /dir");
      expect(result.exitCode).toBe(0);

      const list = await env.exec("tar -tf /archive.tar");
      expect(list.stdout).toContain(longName);
    });
  });

  describe("combined operations", () => {
    it("should round-trip directory with gzip", async () => {
      const env = new Bash({
        files: {
          "/project/src/main.js": "console.log('hello');",
          "/project/src/utils.js": "export const helper = () => {};",
          "/project/package.json": '{"name": "test"}',
          "/project/README.md": "# Project\n\nThis is a test project."
        }
      });

      // Create compressed archive
      const create = await env.exec("tar -czvf /backup.tar.gz /project");
      expect(create.exitCode).toBe(0);

      // Delete original
      await env.exec("rm -rf /project");

      // Extract
      const extract = await env.exec("tar -xzvf /backup.tar.gz");
      expect(extract.exitCode).toBe(0);

      // Verify contents
      const main = await env.exec("cat /project/src/main.js");
      expect(main.stdout).toBe("console.log('hello');");

      const pkg = await env.exec("cat /project/package.json");
      expect(pkg.stdout).toBe('{"name": "test"}');
    });
  });

  describe("extract to stdout (-O)", () => {
    it("should extract file contents to stdout", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello, World!"
        }
      });
      await env.exec("tar -cf /archive.tar /test.txt");

      const result = await env.exec("tar -xOf /archive.tar");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Hello, World!");
    });

    it("should extract specific file to stdout", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "Content 1",
          "/file2.txt": "Content 2"
        }
      });
      await env.exec("tar -cf /archive.tar /file1.txt /file2.txt");

      const result = await env.exec("tar -xOf /archive.tar /file2.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("Content 2");
    });

    it("should not create files when using -O", async () => {
      const env = new Bash({
        files: {
          "/source/test.txt": "Original"
        }
      });
      await env.exec("tar -cf /archive.tar /source");
      await env.exec("rm -rf /source");

      await env.exec("tar -xOf /archive.tar");

      // Verify files were not created
      const stat = await env.exec("ls /source 2>&1 || echo 'not found'");
      expect(stat.stdout).toContain("not found");
    });

    it("should concatenate multiple files to stdout", async () => {
      const env = new Bash({
        files: {
          "/a.txt": "AAA",
          "/b.txt": "BBB"
        }
      });
      await env.exec("tar -cf /archive.tar /a.txt /b.txt");

      const result = await env.exec("tar -xOf /archive.tar");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("AAA");
      expect(result.stdout).toContain("BBB");
    });
  });

  describe("keep old files (-k)", () => {
    it("should not overwrite existing files with -k", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Original content"
        }
      });
      await env.exec("tar -cf /archive.tar /test.txt");

      // Modify the file
      await env.exec("echo 'Modified content' > /test.txt");

      // Extract with -k should not overwrite
      const result = await env.exec("tar -xkf /archive.tar");
      expect(result.exitCode).toBe(0);

      const content = await env.exec("cat /test.txt");
      expect(content.stdout.trim()).toBe("Modified content");
    });

    it("should extract non-existing files with -k", async () => {
      const env = new Bash({
        files: {
          "/existing.txt": "Existing",
          "/new.txt": "New content"
        }
      });
      await env.exec("tar -cf /archive.tar /existing.txt /new.txt");

      // Remove only new.txt
      await env.exec("rm /new.txt");
      await env.exec("echo 'Modified existing' > /existing.txt");

      // Extract with -k
      await env.exec("tar -xkf /archive.tar");

      // existing.txt should still be modified
      const existing = await env.exec("cat /existing.txt");
      expect(existing.stdout.trim()).toBe("Modified existing");

      // new.txt should be extracted
      const newFile = await env.exec("cat /new.txt");
      expect(newFile.stdout).toBe("New content");
    });

    it("should show verbose message for skipped files with -kv", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Original"
        }
      });
      await env.exec("tar -cf /archive.tar /test.txt");

      const result = await env.exec("tar -xkvf /archive.tar");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("not overwritten");
    });
  });

  describe("append (-r)", () => {
    it("should append files to existing archive", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "Content 1",
          "/file2.txt": "Content 2"
        }
      });

      // Create initial archive with file1
      await env.exec("tar -cf /archive.tar /file1.txt");

      // Append file2
      const result = await env.exec("tar -rf /archive.tar /file2.txt");
      expect(result.exitCode).toBe(0);

      // List and verify both files are present
      const list = await env.exec("tar -tf /archive.tar");
      expect(list.stdout).toContain("file1.txt");
      expect(list.stdout).toContain("file2.txt");
    });

    it("should append with verbose output", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "Content 1",
          "/file2.txt": "Content 2"
        }
      });

      await env.exec("tar -cf /archive.tar /file1.txt");
      const result = await env.exec("tar -rvf /archive.tar /file2.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("file2.txt");
    });

    it("should error when appending to non-existent archive", async () => {
      const env = new Bash({
        files: {
          "/file.txt": "Content"
        }
      });

      const result = await env.exec("tar -rf /nonexistent.tar /file.txt");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot open");
    });

    it("should error when appending to stdout", async () => {
      const env = new Bash({
        files: {
          "/file.txt": "Content"
        }
      });

      const result = await env.exec("tar -r /file.txt");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot append");
    });

    it("should not work with compressed archives", async () => {
      const env = new Bash({
        files: {
          "/file.txt": "Content"
        }
      });

      const result = await env.exec("tar -rzf /archive.tar.gz /file.txt");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot append/update compressed");
    });
  });

  describe("update (-u)", () => {
    it("should update archive with newer files", async () => {
      const env = new Bash({
        files: {
          "/file.txt": "Original content"
        }
      });

      // Create initial archive
      await env.exec("tar -cf /archive.tar /file.txt");

      // Modify the file (sleep to ensure different mtime)
      await env.exec('echo "Updated content" > /file.txt');

      // Update archive
      const result = await env.exec("tar -uf /archive.tar /file.txt");
      expect(result.exitCode).toBe(0);

      // Extract and verify updated content
      await env.exec("rm /file.txt");
      await env.exec("tar -xf /archive.tar");
      const content = await env.exec("cat /file.txt");
      expect(content.stdout.trim()).toBe("Updated content");
    });

    it("should not update archive with older files", async () => {
      const env = new Bash({
        files: {
          "/file.txt": "Content"
        }
      });

      // Create archive
      await env.exec("tar -cf /archive.tar /file.txt");

      // Try to update without modifying (should do nothing)
      const result = await env.exec("tar -uvf /archive.tar /file.txt");
      expect(result.exitCode).toBe(0);
      // With verbose and no update, nothing should be output
    });

    it("should error when updating non-existent archive", async () => {
      const env = new Bash({
        files: {
          "/file.txt": "Content"
        }
      });

      const result = await env.exec("tar -uf /nonexistent.tar /file.txt");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot open");
    });

    it("should not work with compressed archives", async () => {
      const env = new Bash({
        files: {
          "/file.txt": "Content"
        }
      });

      const result = await env.exec("tar -uzf /archive.tar.gz /file.txt");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot append/update compressed");
    });
  });

  describe("wildcards (--wildcards)", () => {
    it("should extract files matching wildcard pattern", async () => {
      const env = new Bash({
        files: {
          "/dir/file1.txt": "Text 1",
          "/dir/file2.txt": "Text 2",
          "/dir/other.log": "Log"
        }
      });

      await env.exec("tar -cf /archive.tar /dir");
      await env.exec("rm -rf /dir");

      // Extract only .txt files using wildcard
      await env.exec("tar -xf /archive.tar --wildcards '*.txt'");

      const txt1 = await env.exec("cat /dir/file1.txt");
      expect(txt1.exitCode).toBe(0);

      const log = await env.exec("cat /dir/other.log 2>&1 || echo 'not found'");
      expect(log.stdout).toContain("not found");
    });

    it("should list files matching wildcard pattern", async () => {
      const env = new Bash({
        files: {
          "/dir/a.txt": "A",
          "/dir/b.txt": "B",
          "/dir/c.log": "C"
        }
      });

      await env.exec("tar -cf /archive.tar /dir");

      const result = await env.exec("tar -tf /archive.tar --wildcards '*.log'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("c.log");
      expect(result.stdout).not.toContain("a.txt");
      expect(result.stdout).not.toContain("b.txt");
    });

    it("should support ? wildcard for single character", async () => {
      const env = new Bash({
        files: {
          "/dir/file1.txt": "1",
          "/dir/file2.txt": "2",
          "/dir/file10.txt": "10"
        }
      });

      await env.exec("tar -cf /archive.tar /dir");

      const result = await env.exec(
        "tar -tf /archive.tar --wildcards 'file?.txt'"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("file1.txt");
      expect(result.stdout).toContain("file2.txt");
      expect(result.stdout).not.toContain("file10.txt");
    });
  });

  describe("pattern matching on extract", () => {
    it("should extract only matching files", async () => {
      const env = new Bash({
        files: {
          "/dir/file1.txt": "Content 1",
          "/dir/file2.txt": "Content 2",
          "/dir/other.log": "Log content"
        }
      });
      await env.exec("tar -cf /archive.tar /dir");
      await env.exec("rm -rf /dir");

      // Extract only file1.txt
      await env.exec("tar -xf /archive.tar /dir/file1.txt");

      const file1 = await env.exec("cat /dir/file1.txt");
      expect(file1.exitCode).toBe(0);
      expect(file1.stdout).toBe("Content 1");

      // file2.txt should not exist
      const file2 = await env.exec(
        "cat /dir/file2.txt 2>&1 || echo 'not found'"
      );
      expect(file2.stdout).toContain("not found");
    });

    it("should extract directory and its contents by pattern", async () => {
      const env = new Bash({
        files: {
          "/project/src/main.js": "main",
          "/project/src/lib.js": "lib",
          "/project/docs/readme.md": "docs"
        }
      });
      await env.exec("tar -cf /archive.tar /project");
      await env.exec("rm -rf /project");

      // Extract only /project/src
      await env.exec("tar -xf /archive.tar /project/src");

      const main = await env.exec("cat /project/src/main.js");
      expect(main.stdout).toBe("main");

      // docs should not exist
      const docs = await env.exec("ls /project/docs 2>&1 || echo 'not found'");
      expect(docs.stdout).toContain("not found");
    });
  });

  describe("auto-compress (-a)", () => {
    it("should auto-detect gzip from .tar.gz extension", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello World"
        }
      });

      const result = await env.exec("tar -caf /archive.tar.gz /test.txt");
      expect(result.exitCode).toBe(0);

      // Verify it's gzip compressed
      const list = await env.exec("tar -tzf /archive.tar.gz");
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("test.txt");
    });

    it("should auto-detect bzip2 from .tar.bz2 extension and reject (native addon)", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello World"
        }
      });

      const result = await env.exec("tar -caf /archive.tar.bz2 /test.txt");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not supported");
    });

    it("should auto-detect xz from .tar.xz extension and reject (native addon)", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello World"
        }
      });

      const result = await env.exec("tar -caf /archive.tar.xz /test.txt");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not supported");
    });

    it("should auto-detect zstd from .tar.zst extension and reject (native addon)", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello World"
        }
      });

      const result = await env.exec("tar -caf /archive.tar.zst /test.txt");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not supported");
    });

    it("should create plain tar for .tar extension", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello World"
        }
      });

      const result = await env.exec("tar -caf /archive.tar /test.txt");
      expect(result.exitCode).toBe(0);

      // Verify it's uncompressed
      const list = await env.exec("tar -tf /archive.tar");
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("test.txt");
    });
  });

  describe("files-from (-T)", () => {
    it("should read files to archive from a file", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "Content 1",
          "/file2.txt": "Content 2",
          "/file3.txt": "Content 3",
          "/files.list": "/file1.txt\n/file2.txt"
        }
      });

      const result = await env.exec("tar -cf /archive.tar -T /files.list");
      expect(result.exitCode).toBe(0);

      const list = await env.exec("tar -tf /archive.tar");
      expect(list.stdout).toContain("file1.txt");
      expect(list.stdout).toContain("file2.txt");
      expect(list.stdout).not.toContain("file3.txt");
    });

    it("should ignore comments and blank lines in files-from", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "Content 1",
          "/file2.txt": "Content 2",
          "/files.list":
            "# This is a comment\n/file1.txt\n\n/file2.txt\n# Another comment"
        }
      });

      const result = await env.exec("tar -cf /archive.tar -T /files.list");
      expect(result.exitCode).toBe(0);

      const list = await env.exec("tar -tf /archive.tar");
      expect(list.stdout).toContain("file1.txt");
      expect(list.stdout).toContain("file2.txt");
    });

    it("should combine -T with positional files", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "Content 1",
          "/file2.txt": "Content 2",
          "/file3.txt": "Content 3",
          "/files.list": "/file1.txt"
        }
      });

      const result = await env.exec(
        "tar -cf /archive.tar -T /files.list /file3.txt"
      );
      expect(result.exitCode).toBe(0);

      const list = await env.exec("tar -tf /archive.tar");
      expect(list.stdout).toContain("file1.txt");
      expect(list.stdout).toContain("file3.txt");
      expect(list.stdout).not.toContain("file2.txt");
    });

    it("should error on non-existent files-from file", async () => {
      const env = new Bash();

      const result = await env.exec(
        "tar -cf /archive.tar -T /nonexistent.list"
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot open");
    });
  });

  describe("exclude-from (-X)", () => {
    it("should read exclude patterns from a file", async () => {
      const env = new Bash({
        files: {
          "/dir/file1.txt": "Content 1",
          "/dir/file2.log": "Log 2",
          "/dir/file3.txt": "Content 3",
          "/excludes.list": "*.log"
        }
      });

      const result = await env.exec(
        "tar -cf /archive.tar -X /excludes.list /dir"
      );
      expect(result.exitCode).toBe(0);

      const list = await env.exec("tar -tf /archive.tar");
      expect(list.stdout).toContain("file1.txt");
      expect(list.stdout).toContain("file3.txt");
      expect(list.stdout).not.toContain("file2.log");
    });

    it("should combine -X with --exclude", async () => {
      const env = new Bash({
        files: {
          "/dir/file1.txt": "Content 1",
          "/dir/file2.log": "Log 2",
          "/dir/file3.bak": "Backup 3",
          "/excludes.list": "*.log"
        }
      });

      const result = await env.exec(
        "tar -cf /archive.tar -X /excludes.list --exclude='*.bak' /dir"
      );
      expect(result.exitCode).toBe(0);

      const list = await env.exec("tar -tf /archive.tar");
      expect(list.stdout).toContain("file1.txt");
      expect(list.stdout).not.toContain("file2.log");
      expect(list.stdout).not.toContain("file3.bak");
    });

    it("should error on non-existent exclude-from file", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Content"
        }
      });

      const result = await env.exec(
        "tar -cf /archive.tar -X /nonexistent.list /test.txt"
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Cannot open");
    });
  });

  describe("zstd compression (--zstd)", () => {
    it("should reject zstd compression (requires native addons)", async () => {
      const env = new Bash({
        files: {
          "/test.txt": "Hello World"
        }
      });

      const result = await env.exec(
        "tar --zstd -cf /archive.tar.zst /test.txt"
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("not supported");
    });
  });

  describe("binary stdin handling", () => {
    it("should correctly handle binary archive data from stdin for list", async () => {
      const env = new Bash({
        files: {
          "/file1.txt": "content one",
          "/file2.txt": "content two"
        }
      });

      // Create archive
      await env.exec("tar -cf /test.tar /file1.txt /file2.txt");

      // Read archive and pipe to tar -t (tests stdin binary handling)
      // The tar archive itself contains binary header data with bytes > 127
      const result = await env.exec("cat /test.tar | tar -t");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("file1.txt");
      expect(result.stdout).toContain("file2.txt");
    });

    it("should correctly handle binary archive data from stdin for extract", async () => {
      const env = new Bash({
        files: {
          "/src/file.txt": "test content 12345"
        }
      });

      // Create archive
      await env.exec("tar -cf /test.tar -C /src file.txt");

      // Extract from stdin (tests binary stdin handling)
      // The tar archive format includes binary header bytes that would be
      // corrupted by UTF-8 re-encoding if stdin is not handled correctly
      const result = await env.exec("cat /test.tar | tar -x -C /dest");
      expect(result.exitCode).toBe(0);

      // Verify the extracted file exists and has correct content
      const catResult = await env.exec("cat /dest/file.txt");
      expect(catResult.exitCode).toBe(0);
      expect(catResult.stdout).toBe("test content 12345");
    });

    it("should handle gzip-compressed archive from stdin", async () => {
      const env = new Bash({
        files: {
          "/src/data.txt": "Hello World"
        }
      });

      // Create compressed archive (gzip includes binary header bytes)
      const createResult = await env.exec(
        "tar -czf /test.tar.gz -C /src data.txt"
      );
      expect(createResult.exitCode).toBe(0);

      // Verify the archive exists and can be listed
      const listResult = await env.exec("tar -tzf /test.tar.gz");
      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain("data.txt");

      // Extract from stdin - this would fail if binary stdin handling
      // corrupts the gzip magic bytes (0x1f 0x8b)
      const result = await env.exec("cat /test.tar.gz | tar -xz -C /dest");
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);

      // Verify extraction worked
      const catResult = await env.exec("cat /dest/data.txt");
      expect(catResult.exitCode).toBe(0);
      expect(catResult.stdout).toBe("Hello World");
    });
  });
});
