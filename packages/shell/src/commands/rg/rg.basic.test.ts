import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("rg basic search", () => {
  it("should search for pattern in current directory", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\nfoo bar\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello world\n");
    expect(result.stderr).toBe("");
  });

  it("should search multiple files and sort output", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.txt": "hello\n",
        "/home/user/b.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a.txt:1:hello\nb.txt:1:hello\n");
    expect(result.stderr).toBe("");
  });

  it("should search in specified path", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/src/app.ts": "const hello = 'world';\n",
        "/home/user/README.md": "# Hello\n"
      }
    });
    const result = await bash.exec("rg hello src");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("src/app.ts:1:const hello = 'world';\n");
    expect(result.stderr).toBe("");
  });

  it("should return exit code 1 when no matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg nomatch");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("should show line numbers by default", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "line1\nhello\nline3\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:hello\n");
    expect(result.stderr).toBe("");
  });

  it("should hide line numbers with -N", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg -N hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:hello world\n");
    expect(result.stderr).toBe("");
  });

  it("should search in subdirectories", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/src/lib/util.ts": "export const hello = 1;\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("src/lib/util.ts:1:export const hello = 1;\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg case sensitivity", () => {
  it("should use smart case by default (lowercase = case-insensitive)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "Hello World\nhello world\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt:1:Hello World\nfile.txt:2:hello world\n"
    );
    expect(result.stderr).toBe("");
  });

  it("should use smart case (uppercase in pattern = case-sensitive)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "Hello World\nhello world\n"
      }
    });
    const result = await bash.exec("rg Hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:Hello World\n");
    expect(result.stderr).toBe("");
  });

  it("should be case-insensitive with -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "Hello World\nhello world\nHELLO WORLD\n"
      }
    });
    const result = await bash.exec("rg -i HELLO");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt:1:Hello World\nfile.txt:2:hello world\nfile.txt:3:HELLO WORLD\n"
    );
    expect(result.stderr).toBe("");
  });

  it("should be case-sensitive with -s (override smart case)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "Hello World\nhello world\n"
      }
    });
    const result = await bash.exec("rg -s hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:2:hello world\n");
    expect(result.stderr).toBe("");
  });

  it("should override smart case with -i when pattern has uppercase", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "Hello World\nhello world\n"
      }
    });
    const result = await bash.exec("rg -i Hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "file.txt:1:Hello World\nfile.txt:2:hello world\n"
    );
    expect(result.stderr).toBe("");
  });

  it("should use smart case with numbers only (case-insensitive)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "ABC123\nabc123\n"
      }
    });
    const result = await bash.exec("rg 123");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:ABC123\nfile.txt:2:abc123\n");
    expect(result.stderr).toBe("");
  });

  it("should use smart case with symbols only (case-insensitive)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo::bar\nFOO::BAR\n"
      }
    });
    const result = await bash.exec("rg -F '::'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo::bar\nfile.txt:2:FOO::BAR\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg binary files", () => {
  it("should skip binary files by default", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/text.txt": "hello\n",
        "/home/user/binary.bin": "hello\x00world\n"
      }
    });
    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("text.txt:1:hello\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg max depth", () => {
  it("should limit search depth with --max-depth", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/level0.txt": "hello\n",
        "/home/user/dir1/level1.txt": "hello\n",
        "/home/user/dir1/dir2/level2.txt": "hello\n"
      }
    });
    // ripgrep: --max-depth N includes files at depths 0 through N-1
    // --max-depth 2 includes depth 0 and 1
    const result = await bash.exec("rg --max-depth 2 hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("dir1/level1.txt:1:hello\nlevel0.txt:1:hello\n");
    expect(result.stderr).toBe("");
  });
});

describe("rg error handling", () => {
  it("should error on missing pattern", async () => {
    const bash = new Bash();
    const result = await bash.exec("rg");
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("rg: no pattern given\n");
  });

  it("should error on unknown option", async () => {
    const bash = new Bash();
    const result = await bash.exec("rg --unknown-option pattern");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("rg: unrecognized option '--unknown-option'\n");
  });

  it("should return no matches for unknown type", async () => {
    // Unknown types don't produce an error - they just match no files
    // This allows --type-add to define custom types
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg -t unknowntype hello");
    expect(result.exitCode).toBe(1); // No matches
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
