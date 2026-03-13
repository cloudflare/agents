/**
 * Tests for rg feature flags: -L (symlinks), -u (unrestricted), -a (text/binary)
 *
 * These are custom tests for features we implemented, not imported from ripgrep.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("rg -L (follow symlinks)", () => {
  it("should accept -L/--follow flag without error", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg -L hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello world\n");
  });

  it("should accept --follow flag without error", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg --follow hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:hello world\n");
  });

  it("should skip symlinks by default in directory search", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/real.txt": "hello\n"
      }
    });
    await bash.exec("ln -s real.txt /home/user/link.txt");

    const result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("real.txt:1:hello\n");
  });

  it("should follow symlinks with -L in directory search", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/real.txt": "hello\n"
      }
    });
    await bash.exec("ln -s real.txt /home/user/link.txt");

    const result = await bash.exec("rg -L --sort path hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("link.txt:1:hello\nreal.txt:1:hello\n");
  });

  it("should follow symlinks to directories with -L", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/subdir/file.txt": "hello\n"
      }
    });
    await bash.exec("ln -s subdir /home/user/linkdir");

    // Without -L, should only find file in real directory
    let result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("subdir/file.txt:1:hello\n");

    // With -L, should find file through both paths
    result = await bash.exec("rg -L --sort path hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "linkdir/file.txt:1:hello\nsubdir/file.txt:1:hello\n"
    );
  });
});

describe("rg -u (unrestricted)", () => {
  it("should ignore gitignore with -u", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "ignored.txt\n",
        "/home/user/ignored.txt": "hello\n",
        "/home/user/visible.txt": "hello\n"
      }
    });
    // Without -u, ignored.txt should not be searched
    let result = await bash.exec("rg hello");
    expect(result.stdout).toBe("visible.txt:1:hello\n");

    // With -u, ignored.txt should be searched
    result = await bash.exec("rg -u --sort path hello");
    expect(result.stdout).toBe("ignored.txt:1:hello\nvisible.txt:1:hello\n");
  });

  it("should search hidden files with -uu", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.hidden": "hello\n",
        "/home/user/visible.txt": "hello\n"
      }
    });
    // Without -uu, .hidden should not be searched
    let result = await bash.exec("rg hello");
    expect(result.stdout).toBe("visible.txt:1:hello\n");

    // With -uu (--no-ignore --hidden), .hidden should be searched
    result = await bash.exec("rg -uu --sort path hello");
    expect(result.stdout).toBe(".hidden:1:hello\nvisible.txt:1:hello\n");
  });

  it("-u should be equivalent to --no-ignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "ignored.txt\n",
        "/home/user/ignored.txt": "hello\n"
      }
    });
    const resultU = await bash.exec("rg -u hello");
    const resultNoIgnore = await bash.exec("rg --no-ignore hello");
    expect(resultU.stdout).toBe(resultNoIgnore.stdout);
  });

  it("-uu should be equivalent to --no-ignore --hidden", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.hidden": "hello\n"
      }
    });
    const resultUU = await bash.exec("rg -uu hello");
    const resultFlags = await bash.exec("rg --no-ignore --hidden hello");
    expect(resultUU.stdout).toBe(resultFlags.stdout);
  });
});

describe("rg -a (text/binary)", () => {
  it("should search binary files as text with -a", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/binary.bin": "hello\x00world\n"
      }
    });
    // Without -a, binary should be skipped
    let result = await bash.exec("rg hello");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");

    // With -a, binary should be searched
    result = await bash.exec("rg -a hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("binary.bin:1:hello\x00world\n");
  });
});
