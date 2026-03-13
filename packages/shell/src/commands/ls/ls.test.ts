import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("ls", () => {
  it("should list directory contents", async () => {
    const env = new Bash({
      files: {
        "/dir/a.txt": "",
        "/dir/b.txt": ""
      }
    });
    const result = await env.exec("ls /dir");
    expect(result.stdout).toBe("a.txt\nb.txt\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should list current directory by default", async () => {
    const env = new Bash({
      files: { "/file.txt": "" },
      cwd: "/"
    });
    const result = await env.exec("ls");
    // /bin, /usr, /dev, /proc always exist for PATH-based command resolution and system compatibility
    expect(result.stdout).toBe("bin\ndev\nfile.txt\nproc\nusr\n");
    expect(result.stderr).toBe("");
  });

  it("should hide hidden files by default", async () => {
    const env = new Bash({
      files: {
        "/dir/.hidden": "",
        "/dir/visible.txt": ""
      }
    });
    const result = await env.exec("ls /dir");
    expect(result.stdout).toBe("visible.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should show hidden files with -a including . and ..", async () => {
    const env = new Bash({
      files: {
        "/dir/.hidden": "",
        "/dir/visible.txt": ""
      }
    });
    const result = await env.exec("ls -a /dir");
    expect(result.stdout).toBe(".\n..\n.hidden\nvisible.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should show hidden files with --all including . and ..", async () => {
    const env = new Bash({
      files: { "/dir/.secret": "" }
    });
    const result = await env.exec("ls --all /dir");
    expect(result.stdout).toBe(".\n..\n.secret\n");
    expect(result.stderr).toBe("");
  });

  it("should support long format with -l", async () => {
    const env = new Bash({
      files: { "/dir/test.txt": "" }
    });
    const result = await env.exec("ls -l /dir");
    expect(result.stdout).toMatch(
      /^total 1\n-rw-r--r-- 1 user user\s+0 \w{3}\s+\d+\s+[\d:]+\s+test\.txt\n$/
    );
    expect(result.stderr).toBe("");
  });

  it("should show directory indicator in long format", async () => {
    const env = new Bash({
      files: { "/dir/subdir/file.txt": "" }
    });
    const result = await env.exec("ls -l /dir");
    expect(result.stdout).toMatch(
      /^total 1\ndrwxr-xr-x 1 user user\s+0 \w{3}\s+\d+\s+[\d:]+\s+subdir\/\n$/
    );
    expect(result.stderr).toBe("");
  });

  it("should combine -la flags including . and ..", async () => {
    const env = new Bash({
      files: {
        "/dir/.hidden": "",
        "/dir/visible": ""
      }
    });
    const result = await env.exec("ls -la /dir");
    // Check structure: 4 entries (., .., .hidden, visible)
    const lines = result.stdout.split("\n").filter((l) => l);
    expect(lines[0]).toBe("total 4");
    expect(lines[1]).toMatch(/^drwxr-xr-x 1 user user\s+0 .+ \.$/);
    expect(lines[2]).toMatch(/^drwxr-xr-x 1 user user\s+0 .+ \.\.$/);
    expect(lines[3]).toMatch(/^-rw-r--r-- 1 user user\s+0 .+ \.hidden$/);
    expect(lines[4]).toMatch(/^-rw-r--r-- 1 user user\s+0 .+ visible$/);
    expect(result.stderr).toBe("");
  });

  it("should list multiple directories", async () => {
    const env = new Bash({
      files: {
        "/dir1/a.txt": "",
        "/dir2/b.txt": ""
      }
    });
    const result = await env.exec("ls /dir1 /dir2");
    expect(result.stdout).toBe("/dir1:\na.txt\n\n/dir2:\nb.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should list recursively with -R", async () => {
    const env = new Bash({
      files: {
        "/dir/subdir/file.txt": "",
        "/dir/root.txt": ""
      }
    });
    const result = await env.exec("ls -R /dir");
    // Linux ls -R includes header for all directories including the starting one
    expect(result.stdout).toBe(
      "/dir:\nroot.txt\nsubdir\n\n/dir/subdir:\nfile.txt\n"
    );
    expect(result.stderr).toBe("");
  });

  it("should error on missing directory", async () => {
    const env = new Bash();
    const result = await env.exec("ls /nonexistent");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("ls: /nonexistent: No such file or directory\n");
    expect(result.exitCode).toBe(2);
  });

  it("should list a single file", async () => {
    const env = new Bash({
      files: { "/file.txt": "content" }
    });
    const result = await env.exec("ls /file.txt");
    expect(result.stdout).toBe("/file.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should handle glob pattern with find and grep workaround", async () => {
    const env = new Bash({
      files: {
        "/dir/a.txt": "",
        "/dir/b.txt": "",
        "/dir/c.md": ""
      }
    });
    const result = await env.exec("ls /dir | grep txt");
    expect(result.stdout).toBe("a.txt\nb.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should sort entries alphabetically", async () => {
    const env = new Bash({
      files: {
        "/dir/zebra.txt": "",
        "/dir/apple.txt": "",
        "/dir/mango.txt": ""
      }
    });
    const result = await env.exec("ls /dir");
    expect(result.stdout).toBe("apple.txt\nmango.txt\nzebra.txt\n");
    expect(result.stderr).toBe("");
  });

  it("should handle empty directory", async () => {
    const env = new Bash({
      files: { "/empty/.keep": "" }
    });
    await env.exec("rm /empty/.keep");
    const result = await env.exec("ls /empty");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  describe("-A flag (almost all)", () => {
    it("should show hidden files except . and ..", async () => {
      const env = new Bash({
        files: {
          "/dir/.hidden": "",
          "/dir/visible.txt": ""
        }
      });
      const result = await env.exec("ls -A /dir");
      expect(result.stdout).toBe(".hidden\nvisible.txt\n");
      expect(result.stderr).toBe("");
    });

    it("should differ from -a (no . and ..)", async () => {
      const env = new Bash({
        files: {
          "/dir/.config": "",
          "/dir/data.txt": ""
        }
      });
      const resultA = await env.exec("ls -A /dir");
      const resulta = await env.exec("ls -a /dir");
      // -A should NOT include . and ..
      expect(resultA.stdout).toBe(".config\ndata.txt\n");
      // -a should include . and ..
      expect(resulta.stdout).toBe(".\n..\n.config\ndata.txt\n");
    });
  });

  describe("-F flag (classify)", () => {
    it("should append / to directories", async () => {
      const env = new Bash({
        files: {
          "/dir/subdir/file.txt": "",
          "/dir/regular.txt": ""
        }
      });
      const result = await env.exec("ls -F /dir");
      expect(result.stdout).toBe("regular.txt\nsubdir/\n");
      expect(result.stderr).toBe("");
    });

    it("should append * to executable files", async () => {
      const env = new Bash({
        files: {
          "/dir/script.sh": { content: "#!/bin/bash", mode: 0o755 },
          "/dir/data.txt": ""
        }
      });
      const result = await env.exec("ls -F /dir");
      expect(result.stdout).toBe("data.txt\nscript.sh*\n");
      expect(result.stderr).toBe("");
    });

    it("should append @ to symlinks", async () => {
      const env = new Bash({
        files: {
          "/dir/target.txt": "content"
        }
      });
      await env.exec("ln -s /dir/target.txt /dir/link");
      const result = await env.exec("ls -F /dir");
      expect(result.stdout).toBe("link@\ntarget.txt\n");
      expect(result.stderr).toBe("");
    });

    it("should append @ to symlinks pointing to directories", async () => {
      const env = new Bash({
        files: {
          "/dir/realdir/file.txt": ""
        }
      });
      await env.exec("ln -s /dir/realdir /dir/linkdir");
      const result = await env.exec("ls -F /dir");
      expect(result.stdout).toBe("linkdir@\nrealdir/\n");
      expect(result.stderr).toBe("");
    });

    it("should show directory mode for symlinks to directories in long format", async () => {
      const env = new Bash({
        files: {
          "/dir/realdir/file.txt": ""
        }
      });
      await env.exec("ln -s /dir/realdir /dir/linkdir");
      const result = await env.exec("ls -lF /dir");
      const lines = result.stdout.split("\n").filter((l) => l);
      expect(lines[0]).toBe("total 2");
      // symlink to dir should show drwxr-xr-x mode but @ suffix
      expect(lines[1]).toMatch(/^drwxr-xr-x.*linkdir@$/);
      // real directory should show drwxr-xr-x mode with / suffix
      expect(lines[2]).toMatch(/^drwxr-xr-x.*realdir\/$/);
    });

    it("should work with -l flag", async () => {
      const env = new Bash({
        files: {
          "/dir/subdir/file.txt": "",
          "/dir/script.sh": { content: "#!/bin/bash", mode: 0o755 },
          "/dir/regular.txt": ""
        }
      });
      const result = await env.exec("ls -lF /dir");
      const lines = result.stdout.split("\n").filter((l) => l);
      expect(lines[0]).toBe("total 3");
      expect(lines[1]).toMatch(/regular\.txt$/);
      expect(lines[2]).toMatch(/script\.sh\*$/);
      expect(lines[3]).toMatch(/subdir\/$/);
    });

    it("should work with -a flag", async () => {
      const env = new Bash({
        files: {
          "/dir/.hidden": "",
          "/dir/subdir/file.txt": ""
        }
      });
      const result = await env.exec("ls -aF /dir");
      expect(result.stdout).toBe("./\n../\n.hidden\nsubdir/\n");
      expect(result.stderr).toBe("");
    });

    it("should work with single file argument", async () => {
      const env = new Bash({
        files: {
          "/script.sh": { content: "#!/bin/bash", mode: 0o755 }
        }
      });
      const result = await env.exec("ls -F /script.sh");
      expect(result.stdout).toBe("/script.sh*\n");
      expect(result.stderr).toBe("");
    });

    it("should work with -d flag on directory", async () => {
      const env = new Bash({
        files: {
          "/dir/file.txt": ""
        }
      });
      const result = await env.exec("ls -dF /dir");
      expect(result.stdout).toBe("/dir/\n");
      expect(result.stderr).toBe("");
    });
  });

  describe("-r flag (reverse)", () => {
    it("should reverse sort order", async () => {
      const env = new Bash({
        files: {
          "/dir/aaa.txt": "",
          "/dir/bbb.txt": "",
          "/dir/ccc.txt": ""
        }
      });
      const result = await env.exec("ls -r /dir");
      expect(result.stdout).toBe("ccc.txt\nbbb.txt\naaa.txt\n");
      expect(result.stderr).toBe("");
    });

    it("should combine with -1 flag", async () => {
      const env = new Bash({
        files: {
          "/dir/x.txt": "",
          "/dir/y.txt": "",
          "/dir/z.txt": ""
        }
      });
      const result = await env.exec("ls -1r /dir");
      expect(result.stdout).toBe("z.txt\ny.txt\nx.txt\n");
      expect(result.stderr).toBe("");
    });

    it("should combine with -a flag including . and .. reversed", async () => {
      const env = new Bash({
        files: {
          "/dir/.hidden": "",
          "/dir/visible": ""
        }
      });
      const result = await env.exec("ls -ar /dir");
      // With -a, entries are [., .., .hidden, visible], reversed = [visible, .hidden, .., .]
      expect(result.stdout).toBe("visible\n.hidden\n..\n.\n");
      expect(result.stderr).toBe("");
    });
  });
});
