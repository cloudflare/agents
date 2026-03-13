/**
 * Tests imported from ripgrep: tests/feature.rs
 *
 * These tests cover various ripgrep features from GitHub issues.
 * Each test references the original issue number for traceability.
 */
import { describe, expect, it } from "vitest";
import { Bash } from "../../../Shell";

// Classic test fixture from ripgrep tests
const SHERLOCK = `For the Doctor Watsons of this world, as opposed to the Sherlock
Holmeses, success in the province of detective work must always
be, to a very large extent, the result of luck. Sherlock Holmes
can extract a clew from a wisp of straw or a flake of cigar ash;
but Doctor Watson has to have it taken out for him and dusted,
and exhibited clearly, with a label attached.
`;

describe("rg feature: issue #20 - no-filename", () => {
  it("should hide filename with --no-filename", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --no-filename Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("sherlock:");
    expect(result.stdout).toContain("Sherlock");
  });
});

describe("rg feature: issue #34 - only matching", () => {
  it("should show only matching text with -o", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -o Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock:Sherlock\nsherlock:Sherlock\n");
  });
});

describe("rg feature: issue #70 - smart case", () => {
  it("should use smart case with -S", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -S sherlock");
    expect(result.exitCode).toBe(0);
    // Smart case: lowercase pattern matches case-insensitively
    expect(result.stdout).toContain("Sherlock");
  });

  it("should be case-sensitive when pattern has uppercase", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -S Sherlock");
    expect(result.exitCode).toBe(0);
    // Should only match "Sherlock" not "sherlock"
    expect(result.stdout).toContain("Sherlock");
  });
});

describe("rg feature: issue #89 - files with matches", () => {
  it("should list files with matches with -l", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -l Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock\n");
  });

  it("should list files without matches with --files-without-match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/file.py": "foo\n"
      }
    });
    const result = await bash.exec("rg --files-without-match Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.py\n");
  });

  it("should count matches with -c", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -c Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock:2\n");
  });

  it("should list searchable files with --files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --files");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock\n");
  });

  it("should list searchable files with --files and -0", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --files -0");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock\x00");
  });

  it("should list multiple files sorted with --files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/zebra.txt": "z\n",
        "/home/user/alpha.txt": "a\n",
        "/home/user/beta.txt": "b\n"
      }
    });
    const result = await bash.exec("rg --files");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("alpha.txt\nbeta.txt\nzebra.txt\n");
  });

  it("should respect type filter with --files -t", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/code.js": "js\n",
        "/home/user/code.py": "py\n",
        "/home/user/code.ts": "ts\n"
      }
    });
    const result = await bash.exec("rg --files -t js");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("code.js\n");
  });

  it("should respect glob filter with --files -g", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test.txt": "txt\n",
        "/home/user/test.log": "log\n",
        "/home/user/other.txt": "txt\n"
      }
    });
    const result = await bash.exec("rg --files -g 'test.*'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test.log\ntest.txt\n");
  });

  it("should respect max-depth with --files -d", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/top.txt": "top\n",
        "/home/user/sub/deep.txt": "deep\n",
        "/home/user/sub/deeper/bottom.txt": "bottom\n"
      }
    });
    const result = await bash.exec("rg --files -d 2");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sub/deep.txt\ntop.txt\n");
  });

  it("should return exit code 1 when no files found with --files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.hidden": "hidden\n"
      }
    });
    // Hidden files are excluded by default
    const result = await bash.exec("rg --files");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("should include hidden files with --files --hidden", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.hidden": "hidden\n",
        "/home/user/visible": "visible\n"
      }
    });
    const result = await bash.exec("rg --files --hidden");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(".hidden\nvisible\n");
  });

  // Ported from ripgrep r64
  it("should list files in specific directory with --files dir", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/dir/abc": "content\n",
        "/home/user/foo/abc": "content\n"
      }
    });
    const result = await bash.exec("rg --files foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo/abc\n");
  });

  // Ported from ripgrep r352
  it("should combine --files with --glob", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.py": "python\n",
        "/home/user/file.rs": "rust\n",
        "/home/user/file.txt": "text\n"
      }
    });
    const result = await bash.exec("rg --files --glob '*.py'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.py\n");
  });

  // Ported from ripgrep r444
  it("should work with --quiet --files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.py": "python\n",
        "/home/user/file.rs": "rust\n"
      }
    });
    // --quiet with --files suppresses output but indicates success
    const result = await bash.exec("rg --quiet --files --glob '*.py'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  // Ported from ripgrep - path prefix preservation
  it("should preserve ./ prefix when given", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sub/file.txt": "content\n"
      }
    });
    const result = await bash.exec("rg --files ./sub");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("./sub/file.txt\n");
  });
});

describe("rg feature: issue #109 - max depth", () => {
  it("should limit search depth with --max-depth", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/one/pass": "far\n",
        "/home/user/one/too/many": "far\n"
      }
    });
    const result = await bash.exec("rg --max-depth 2 far");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("one/pass:1:far\n");
  });

  it("should accept -d as alias for --max-depth", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/one/pass": "far\n",
        "/home/user/one/too/many": "far\n"
      }
    });
    const result = await bash.exec("rg -d 2 far");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("one/pass:1:far\n");
  });

  it("should search only current directory with -d 1", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/top.txt": "match\n",
        "/home/user/sub/nested.txt": "match\n"
      }
    });
    const result = await bash.exec("rg -d 1 match");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("top.txt:1:match\n");
  });

  it("should search deeper with higher -d value", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a/b/c/deep.txt": "found\n"
      }
    });
    const result = await bash.exec("rg -d 4 found");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a/b/c/deep.txt:1:found\n");
  });

  it("should combine -d with type filter", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/top.js": "test\n",
        "/home/user/sub/nested.js": "test\n",
        "/home/user/top.py": "test\n"
      }
    });
    const result = await bash.exec("rg -d 1 -t js test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("top.js:1:test\n");
  });
});

describe("rg feature: issue #124 - case-sensitive override", () => {
  it("should be case-sensitive with -s overriding smart case", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "tEsT\n"
      }
    });
    const result = await bash.exec("rg -S -s test");
    expect(result.exitCode).toBe(1); // No match - case sensitive
  });

  it("should be case-sensitive with -s overriding -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "tEsT\n"
      }
    });
    const result = await bash.exec("rg -i -s test");
    expect(result.exitCode).toBe(1); // No match - case sensitive
  });
});

describe("rg feature: issue #159 - max count", () => {
  it("should stop after N matches with -m", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "test\ntest\n"
      }
    });
    const result = await bash.exec("rg -m1 test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:test\n");
  });

  it("should treat -m0 as unlimited", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "test\ntest\n"
      }
    });
    const result = await bash.exec("rg -m0 test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:test\nfoo:2:test\n");
  });
});

describe("rg feature: issue #948 - exit codes", () => {
  it("should return exit code 0 on match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg .");
    expect(result.exitCode).toBe(0);
  });

  it("should return exit code 1 on no match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg NADA");
    expect(result.exitCode).toBe(1);
  });

  it("should return exit code 2 on error", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg '*'");
    expect(result.exitCode).toBe(2);
  });
});

describe("rg feature: issue #2288 - context partial override", () => {
  it("should allow -A to override context from -C", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "1\n2\n3\n4\n5\n6\n7\n8\n9\n"
      }
    });
    const result = await bash.exec("rg -C1 -A2 5 test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("4\n5\n6\n7\n");
  });

  it("should allow -C to set both -A and -B", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "1\n2\n3\n4\n5\n6\n7\n8\n9\n"
      }
    });
    const result = await bash.exec("rg -A2 -C1 5 test");
    expect(result.exitCode).toBe(0);
    // -C1 sets both before and after to 1
    expect(result.stdout).toBe("4\n5\n6\n7\n");
  });
});

describe("rg feature: context separator", () => {
  it("should use default context separator", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "foo\nctx\nbar\nctx\nfoo\nctx\n"
      }
    });
    const result = await bash.exec("rg -A1 foo test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo\nctx\n--\nfoo\nctx\n");
  });
});

describe("rg feature: multiple patterns", () => {
  it("should match multiple patterns with -e", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo\nbar\nbaz\n"
      }
    });
    const result = await bash.exec("rg -e foo -e bar");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file:1:foo\nfile:2:bar\n");
  });
});

describe("rg feature: gitignore handling", () => {
  it("should respect .gitignore by default", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "ignored.txt\n",
        "/home/user/visible.txt": "test\n",
        "/home/user/ignored.txt": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("visible.txt:1:test\n");
  });

  it("should ignore .gitignore with --no-ignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "ignored.txt\n",
        "/home/user/visible.txt": "test\n",
        "/home/user/ignored.txt": "test\n"
      }
    });
    const result = await bash.exec("rg --no-ignore --sort path test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ignored.txt:1:test\nvisible.txt:1:test\n");
  });
});

describe("rg feature: hidden files", () => {
  it("should skip hidden files by default", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.hidden": "test\n",
        "/home/user/visible": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("visible:1:test\n");
  });

  it("should include hidden files with --hidden", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.hidden": "test\n",
        "/home/user/visible": "test\n"
      }
    });
    const result = await bash.exec("rg --hidden --sort path test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(".hidden:1:test\nvisible:1:test\n");
  });
});

describe("rg feature: type filtering", () => {
  it("should filter by type with -t", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/code.js": "test\n",
        "/home/user/code.py": "test\n",
        "/home/user/code.rs": "test\n"
      }
    });
    const result = await bash.exec("rg -t js test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("code.js:1:test\n");
  });

  it("should exclude type with -T", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/code.js": "test\n",
        "/home/user/code.py": "test\n"
      }
    });
    const result = await bash.exec("rg -T js test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("code.py:1:test\n");
  });

  it("should accept markdown as type alias", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/README.md": "test\n",
        "/home/user/code.py": "test\n"
      }
    });
    const result = await bash.exec("rg -t markdown test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("README.md:1:test\n");
  });

  it("should match .markdown extension with -t markdown", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/doc.markdown": "content\n",
        "/home/user/code.js": "content\n"
      }
    });
    const result = await bash.exec("rg -t markdown content");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("doc.markdown:1:content\n");
  });

  it("should match .mdown extension with -t markdown", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/notes.mdown": "info\n",
        "/home/user/code.py": "info\n"
      }
    });
    const result = await bash.exec("rg -t markdown info");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("notes.mdown:1:info\n");
  });

  it("should match both md and markdown types equivalently", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/doc.md": "text\n",
        "/home/user/other.txt": "text\n"
      }
    });
    const mdResult = await bash.exec("rg -t md text");
    const markdownResult = await bash.exec("rg -t markdown text");
    expect(mdResult.stdout).toBe(markdownResult.stdout);
  });

  it("should exclude markdown with -T markdown", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/README.md": "test\n",
        "/home/user/code.py": "test\n"
      }
    });
    const result = await bash.exec("rg -T markdown test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("code.py:1:test\n");
  });
});

describe("rg feature: glob filtering", () => {
  it("should filter by glob with -g", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "test\n",
        "/home/user/file.log": "test\n"
      }
    });
    const result = await bash.exec("rg -g '*.txt' test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:test\n");
  });

  it("should negate glob with -g !", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "test\n",
        "/home/user/file.log": "test\n"
      }
    });
    const result = await bash.exec("rg -g '!*.log' test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:test\n");
  });
});

describe("rg feature: word and line matching", () => {
  it("should match whole words with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo foobar barfoo\n"
      }
    });
    const result = await bash.exec("rg -w foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file:1:foo foobar barfoo\n");
  });

  it("should not match partial words with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foobar\n"
      }
    });
    const result = await bash.exec("rg -w foo");
    expect(result.exitCode).toBe(1);
  });

  it("should match whole lines with -x", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo\nfoo bar\n"
      }
    });
    const result = await bash.exec("rg -x foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file:1:foo\n");
  });
});

describe("rg feature: inverted match", () => {
  it("should invert match with -v", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo\nbar\nbaz\n"
      }
    });
    const result = await bash.exec("rg -v foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file:2:bar\nfile:3:baz\n");
  });
});

describe("rg feature: fixed strings", () => {
  it("should treat pattern as literal with -F", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo.*bar\nfoobar\n"
      }
    });
    const result = await bash.exec("rg -F 'foo.*bar'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file:1:foo.*bar\n");
  });
});

describe("rg feature: quiet mode", () => {
  it("should suppress output with -q on match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "test\n"
      }
    });
    const result = await bash.exec("rg -q test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("should return exit code 1 with -q on no match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "test\n"
      }
    });
    const result = await bash.exec("rg -q notfound");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });
});

describe("rg feature: line numbers", () => {
  it("should show line numbers with -n", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo\ntest\nbar\n"
      }
    });
    const result = await bash.exec("rg -n test file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2:test\n");
  });

  it("should hide line numbers with -N", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "test\n"
      }
    });
    const result = await bash.exec("rg -N test file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test\n");
  });
});

describe("rg feature: context lines", () => {
  it("should show after context with -A", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "a\nmatch\nb\nc\n"
      }
    });
    const result = await bash.exec("rg -A2 match file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("match\nb\nc\n");
  });

  it("should show before context with -B", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "a\nb\nmatch\nc\n"
      }
    });
    const result = await bash.exec("rg -B2 match file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\nb\nmatch\n");
  });

  it("should show both context with -C", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "a\nb\nmatch\nc\nd\n"
      }
    });
    const result = await bash.exec("rg -C1 match file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("b\nmatch\nc\n");
  });
});

describe("rg feature: combined flags", () => {
  it("should combine -i and -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "FOO foobar\n"
      }
    });
    const result = await bash.exec("rg -iw foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file:1:FOO foobar\n");
  });

  it("should combine -c and -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo\nFOO\nFoo\n"
      }
    });
    const result = await bash.exec("rg -ci foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file:3\n");
  });

  it("should combine -l and -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.txt": "FOO\n",
        "/home/user/b.txt": "bar\n"
      }
    });
    const result = await bash.exec("rg -li foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a.txt\n");
  });
});

describe("rg feature: --stats", () => {
  it("should output search statistics with --stats", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo\nbar\nfoo\n"
      }
    });
    const result = await bash.exec("rg --stats foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2 matches");
    expect(result.stdout).toContain("1 files contained matches");
    expect(result.stdout).toContain("1 files searched");
  });

  it("should show stats for multiple files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.txt": "foo\n",
        "/home/user/b.txt": "foo\nfoo\n",
        "/home/user/c.txt": "bar\n"
      }
    });
    const result = await bash.exec("rg --stats foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("3 matches");
    expect(result.stdout).toContain("2 files contained matches");
    expect(result.stdout).toContain("3 files searched");
  });

  it("should show stats even with no matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "hello\n"
      }
    });
    const result = await bash.exec("rg --stats notfound");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("0 matches");
    expect(result.stdout).toContain("0 files contained matches");
    expect(result.stdout).toContain("1 files searched");
  });

  it("should include search results before stats", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "test\n"
      }
    });
    const result = await bash.exec("rg --stats test");
    expect(result.exitCode).toBe(0);
    // Results should appear before stats
    expect(result.stdout).toMatch(/file:1:test[\s\S]*1 matches/);
  });

  it("should show bytes searched in stats", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "test content here\n"
      }
    });
    const result = await bash.exec("rg --stats test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bytes searched");
  });
});

describe("rg feature: PCRE2 not supported", () => {
  it("should error on -P flag", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "test\n"
      }
    });
    const result = await bash.exec("rg -P test");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "rg: PCRE2 is not supported. Use standard regex syntax instead.\n"
    );
  });

  it("should error on --pcre2 flag", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "test\n"
      }
    });
    const result = await bash.exec("rg --pcre2 test");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "rg: PCRE2 is not supported. Use standard regex syntax instead.\n"
    );
  });
});

// ============================================================================
// SKIPPED TESTS - Features not implemented
// ============================================================================

// f1_* tests - Encoding support (Shift-JIS, UTF-16, EUC-JP)
it.skip("f1_sjis: Shift-JIS encoding not supported", () => {});
it.skip("f1_utf16_auto: UTF-16 auto-detection not supported", () => {});
it.skip("f1_utf16_explicit: UTF-16 explicit encoding not supported", () => {});
it.skip("f1_eucjp: EUC-JP encoding not supported", () => {});
it.skip("f1_unknown_encoding: -E flag not supported", () => {});
it.skip("f1_replacement_encoding: encoding replacement not supported", () => {});

// f7_* tests - Pattern file with stdin
describe("rg feature: f7_stdin", () => {
  it("should read patterns from stdin with -f-", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test.txt": "foo\nbar\nbaz\n"
      }
    });
    // Simulate stdin containing the pattern
    const result = await bash.exec("echo 'bar' | rg -f- test.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("bar\n");
  });
});

// f45_* tests - --ignore-file flag
describe("rg feature: f45_ignore_file", () => {
  it("f45_relative_cwd: should apply patterns from --ignore-file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/my-ignore": "ignored.txt\n",
        "/home/user/ignored.txt": "test content\n",
        "/home/user/included.txt": "test content\n"
      }
    });
    const result = await bash.exec("rg --ignore-file my-ignore test");
    expect(result.exitCode).toBe(0);
    // Should only find included.txt, not ignored.txt
    expect(result.stdout).toContain("included.txt");
    expect(result.stdout).not.toContain("ignored.txt");
  });

  it("f45_precedence_with_others: --ignore-file patterns applied", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/custom-ignore": "*.log\n",
        "/home/user/test.txt": "test\n",
        "/home/user/test.log": "test\n"
      }
    });
    const result = await bash.exec("rg --ignore-file custom-ignore test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test.txt");
    expect(result.stdout).not.toContain("test.log");
  });
});

// f68 - --no-ignore-vcs
describe("rg feature: f68_no_ignore_vcs", () => {
  it("should skip .gitignore with --no-ignore-vcs", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "ignored.txt\n",
        "/home/user/ignored.txt": "Sherlock\n",
        "/home/user/visible.txt": "Sherlock\n"
      }
    });
    // Without --no-ignore-vcs, ignored.txt should be excluded
    const result1 = await bash.exec("rg Sherlock");
    expect(result1.exitCode).toBe(0);
    expect(result1.stdout).toBe("visible.txt:1:Sherlock\n");

    // With --no-ignore-vcs, .gitignore is skipped, so ignored.txt is searched
    const result2 = await bash.exec("rg --no-ignore-vcs Sherlock");
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).toContain("ignored.txt");
    expect(result2.stdout).toContain("visible.txt");
  });
});

// f129 - Max columns
it.skip("f129_matches: -M max columns not implemented", () => {});
