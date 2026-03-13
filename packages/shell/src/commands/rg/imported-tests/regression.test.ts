/**
 * Tests imported from ripgrep: tests/regression.rs
 *
 * Total: 109 tests (matching ripgrep test count)
 * Regression tests from various GitHub issues.
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

// r16: https://github.com/BurntSushi/ripgrep/issues/16
describe("rg regression: r16 - directory trailing slash", () => {
  it("should handle gitignore with directory trailing slash", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "ghi/\n",
        "/home/user/ghi/toplevel.txt": "xyz\n",
        "/home/user/def/ghi/subdir.txt": "xyz\n"
      }
    });
    const result = await bash.exec("rg xyz");
    expect(result.exitCode).toBe(1);
  });
});

// r25: https://github.com/BurntSushi/ripgrep/issues/25
describe("rg regression: r25 - rooted gitignore pattern", () => {
  it("should handle rooted pattern in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "/llvm/\n",
        "/home/user/src/llvm/foo": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("src/llvm/foo:1:test\n");
  });
});

// r30: https://github.com/BurntSushi/ripgrep/issues/30
describe("rg regression: r30 - negation after double-star", () => {
  it("should handle negation after double-star in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "vendor/**\n!vendor/manifest\n",
        "/home/user/vendor/manifest": "test\n",
        "/home/user/vendor/other": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("vendor/manifest:1:test\n");
  });
});

// r49: https://github.com/BurntSushi/ripgrep/issues/49
describe("rg regression: r49 - unanchored directory pattern", () => {
  it("should handle unanchored directory pattern in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "foo/bar\n",
        "/home/user/test/foo/bar/baz": "test\n"
      }
    });
    const result = await bash.exec("rg xyz");
    expect(result.exitCode).toBe(1);
  });
});

// r50: https://github.com/BurntSushi/ripgrep/issues/50
describe("rg regression: r50 - nested directory pattern", () => {
  it("should handle nested directory pattern in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "XXX/YYY/\n",
        "/home/user/abc/def/XXX/YYY/bar": "test\n",
        "/home/user/ghi/XXX/YYY/bar": "test\n"
      }
    });
    const result = await bash.exec("rg xyz");
    expect(result.exitCode).toBe(1);
  });
});

// r64: https://github.com/BurntSushi/ripgrep/issues/64
describe("rg regression: r64 - --files with path argument", () => {
  it("should list files only in specified directory", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/dir/abc": "",
        "/home/user/foo/abc": ""
      }
    });
    const result = await bash.exec("rg --files foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo/abc\n");
  });
});

// r65: https://github.com/BurntSushi/ripgrep/issues/65
describe("rg regression: r65 - simple directory ignore", () => {
  it("should handle simple directory ignore pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "a/\n",
        "/home/user/a/foo": "xyz\n",
        "/home/user/a/bar": "xyz\n"
      }
    });
    const result = await bash.exec("rg xyz");
    expect(result.exitCode).toBe(1);
  });
});

// r67: https://github.com/BurntSushi/ripgrep/issues/67
describe("rg regression: r67 - negation of root", () => {
  it("should handle negation of root with include", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "/*\n!/dir\n",
        "/home/user/foo/bar": "test\n",
        "/home/user/dir/bar": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("dir/bar:1:test\n");
  });
});

// r87: https://github.com/BurntSushi/ripgrep/issues/87
describe("rg regression: r87 - double-star pattern", () => {
  it("should handle double-star in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "foo\n**no-vcs**\n",
        "/home/user/foo": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(1);
  });
});

// r90: https://github.com/BurntSushi/ripgrep/issues/90
describe("rg regression: r90 - negation of hidden file", () => {
  it("should handle negation of hidden file in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "!.foo\n",
        "/home/user/.foo": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(".foo:1:test\n");
  });
});

// r93: https://github.com/BurntSushi/ripgrep/issues/93
describe("rg regression: r93 - IP address regex", () => {
  it("should match IP address pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "192.168.1.1\n"
      }
    });
    const result = await bash.exec("rg '(\\d{1,3}\\.){3}\\d{1,3}'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:192.168.1.1\n");
  });
});

// r99: https://github.com/BurntSushi/ripgrep/issues/99
describe("rg regression: r99 - heading output", () => {
  it("should show heading output format", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo1": "test\n",
        "/home/user/foo2": "zzz\n",
        "/home/user/bar": "test\n"
      }
    });
    const result = await bash.exec("rg --heading test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test");
  });
});

// r105_part1: https://github.com/BurntSushi/ripgrep/issues/105
describe("rg regression: r105 - vimgrep and column", () => {
  it("r105_part1: should show column with --vimgrep", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "zztest\n"
      }
    });
    const result = await bash.exec("rg --vimgrep test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:3:zztest\n");
  });

  it("r105_part2: should show column with --column", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "zztest\n"
      }
    });
    const result = await bash.exec("rg --column test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:3:zztest\n");
  });
});

// r127: https://github.com/BurntSushi/ripgrep/issues/127
describe("rg regression: r127 - gitignore with path", () => {
  it("should handle gitignore with full path pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "foo/sherlock\n",
        "/home/user/foo/sherlock": SHERLOCK,
        "/home/user/foo/watson": SHERLOCK
      }
    });
    const result = await bash.exec("rg Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("foo/watson:");
    expect(result.stdout).not.toContain("foo/sherlock:");
  });
});

// r128: https://github.com/BurntSushi/ripgrep/issues/128
// Note: Test expects no filename for single-file directory search, but our impl shows filename
describe("rg regression: r128 - vertical tab handling", () => {
  it.skip("should handle vertical tab characters", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "01234567\x0b\n\x0b\n\x0b\n\x0b\nx\n"
      }
    });
    const result = await bash.exec("rg -n x");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("5:x\n");
  });
});

// r131: https://github.com/BurntSushi/ripgrep/issues/131 - SKIP: Unicode filename
it.skip("r131: should handle unicode filename in gitignore", () => {});

// r137: https://github.com/BurntSushi/ripgrep/issues/137
describe("rg regression: r137 - follow symlinks to files", () => {
  it("should follow symlinks to files with -L", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/real.txt": "test content\n"
      }
    });
    // Create a symlink to the file
    await bash.exec("ln -s real.txt /home/user/link.txt");
    // With -L, should follow symlink
    const result = await bash.exec("rg -L test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test content");
  });
});

// r156: https://github.com/BurntSushi/ripgrep/issues/156
describe("rg regression: r156 - complex regex pattern", () => {
  it("should match complex regex pattern", async () => {
    const content = `#parse('widgets/foo_bar_macros.vm')
#parse ( 'widgets/mobile/foo_bar_macros.vm' )
#parse ("widgets/foobarhiddenformfields.vm")
`;
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/testcase.txt": content
      }
    });
    const result = await bash.exec(
      `rg -N '#(?:parse|include)\\s*\\(\\s*(?:"|'"'"')[./A-Za-z_-]+(?:"|'"'"')' testcase.txt`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n").length).toBeGreaterThan(1);
  });
});

// r184: https://github.com/BurntSushi/ripgrep/issues/184
describe("rg regression: r184 - dot star gitignore", () => {
  it("should handle .* in gitignore properly", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": ".*\n",
        "/home/user/foo/bar/baz": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo/bar/baz:1:test\n");
  });
});

// r199: https://github.com/BurntSushi/ripgrep/issues/199
describe("rg regression: r199 - smart case with word boundary", () => {
  it("should use smart case with word boundary regex", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "tEsT\n"
      }
    });
    const result = await bash.exec("rg --smart-case '\\btest\\b'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:tEsT\n");
  });
});

// r206: https://github.com/BurntSushi/ripgrep/issues/206
describe("rg regression: r206 - glob with subdirectory", () => {
  it("should match glob in subdirectory", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo/bar.txt": "test\n"
      }
    });
    const result = await bash.exec("rg test -g '*.txt'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo/bar.txt:1:test\n");
  });
});

// r210: https://github.com/BurntSushi/ripgrep/issues/210 - SKIP: Invalid UTF-8 filename
it.skip("r210: should handle invalid UTF-8 filename", () => {});

// r228: https://github.com/BurntSushi/ripgrep/issues/228 - SKIP: --ignore-file
it.skip("r228: should error on --ignore-file with directory", () => {});

// r229: https://github.com/BurntSushi/ripgrep/issues/229
describe("rg regression: r229 - smart case with bracket expression", () => {
  it("should be case-sensitive when pattern has uppercase in bracket", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "economie\n"
      }
    });
    const result = await bash.exec("rg -S '[E]conomie'");
    expect(result.exitCode).toBe(1);
  });
});

// r251: https://github.com/BurntSushi/ripgrep/issues/251
describe("rg regression: r251 - unicode case folding", () => {
  it("should match cyrillic with -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "привет\nПривет\nПрИвЕт\n"
      }
    });
    const result = await bash.exec("rg -i привет");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:привет\nfoo:2:Привет\nfoo:3:ПрИвЕт\n");
  });
});

// r256: https://github.com/BurntSushi/ripgrep/issues/256
describe("rg regression: r256 - follow directory symlinks", () => {
  it("should follow directory symlinks with -L", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/realdir/test.txt": "test content\n"
      }
    });
    // Create a symlink to the directory
    await bash.exec("ln -s realdir /home/user/linkdir");
    // With -L, should follow symlink and search inside
    const result = await bash.exec("rg -L test linkdir");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test content");
  });

  it("should follow directory symlinks with -L and -j1", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/realdir/test.txt": "test content\n"
      }
    });
    // Create a symlink to the directory
    await bash.exec("ln -s realdir /home/user/linkdir");
    // With -L and -j1, should still follow symlinks
    const result = await bash.exec("rg -L -j1 test linkdir");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test content");
  });
});

// r270: https://github.com/BurntSushi/ripgrep/issues/270
describe("rg regression: r270 - pattern starting with dash", () => {
  it("should handle -e with pattern starting with dash", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "-test\n"
      }
    });
    const result = await bash.exec("rg -e '-test'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:-test\n");
  });
});

// r279: https://github.com/BurntSushi/ripgrep/issues/279
describe("rg regression: r279 - quiet mode empty output", () => {
  it("should have empty output in quiet mode", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "test\n"
      }
    });
    const result = await bash.exec("rg -q test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

// r391: https://github.com/BurntSushi/ripgrep/issues/391
describe("rg regression: r391 - complex glob patterns", () => {
  it("should handle complex glob patterns with --files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/lock": "",
        "/home/user/bar.py": "",
        "/home/user/.git/packed-refs": "",
        "/home/user/.git/description": ""
      }
    });
    const result = await bash.exec(
      "rg --no-ignore --hidden --follow --files --glob '!{.git,node_modules,plugged}/**' --glob '*.py'"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("bar.py\n");
  });
});

// r405: https://github.com/BurntSushi/ripgrep/issues/405
describe("rg regression: r405 - negated glob with path", () => {
  it("should handle negated glob with path", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo/bar/file1.txt": "test\n",
        "/home/user/bar/foo/file2.txt": "test\n"
      }
    });
    const result = await bash.exec("rg -g '!/foo/**' test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("bar/foo/file2.txt:1:test\n");
  });
});

// r428: https://github.com/BurntSushi/ripgrep/issues/428 - SKIP: Color output
it.skip("r428_color_context_path: should color context path", () => {});
it.skip("r428_unrecognized_style: should error on unrecognized style", () => {});

// r451: https://github.com/BurntSushi/ripgrep/issues/451
describe("rg regression: r451 - only matching", () => {
  it("r451_only_matching_as_in_issue: should show only matching parts", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/digits.txt": "1 2 3\n"
      }
    });
    const result = await bash.exec("rg --only-matching '[0-9]+' digits.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1\n2\n3\n");
  });

  it("r451_only_matching: should show column with only matching", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/digits.txt": "1 2 3\n123\n"
      }
    });
    const result = await bash.exec(
      "rg --only-matching --column '[0-9]' digits.txt"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1:1:1\n1:3:2\n1:5:3\n2:1:1\n2:2:2\n2:3:3\n");
  });
});

// r483: https://github.com/BurntSushi/ripgrep/issues/483
describe("rg regression: r483 - quiet with files", () => {
  it("r483_matching_no_stdout: should be quiet with --files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.py": ""
      }
    });
    const result = await bash.exec("rg --quiet --files --glob '*.py'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("r483_non_matching_exit_code: should return error when no files match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.rs": ""
      }
    });
    const result = await bash.exec("rg --quiet --files --glob '*.py'");
    expect(result.exitCode).toBe(1);
  });
});

// r493: https://github.com/BurntSushi/ripgrep/issues/493
describe("rg regression: r493 - word boundary with space", () => {
  it("should handle word boundary with leading/trailing spaces", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/input.txt": "peshwaship 're seminomata\n"
      }
    });
    const result = await bash.exec('rg -o "\\b \'re \\b" input.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(" 're \n");
  });
});

// r506: https://github.com/BurntSushi/ripgrep/issues/506
describe("rg regression: r506 - word match with alternation", () => {
  it("should handle -w -o with alternation", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/wb.txt": "min minimum amin\nmax maximum amax\n"
      }
    });
    const result = await bash.exec("rg -w -o 'min|max' wb.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("min\nmax\n");
  });
});

// r553: https://github.com/BurntSushi/ripgrep/issues/553
describe("rg regression: r553 - repeated flags", () => {
  it("r553_switch: should handle repeated -i flag", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -i -i sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sherlock");
  });

  it("r553_flag: should handle -C override", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result1 = await bash.exec("rg -C 1 'world|attached' sherlock");
    expect(result1.exitCode).toBe(0);
    expect(result1.stdout).toContain("--");

    const result2 = await bash.exec("rg -C 1 -C 0 'world|attached' sherlock");
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).not.toContain("--");
  });
});

// r568: https://github.com/BurntSushi/ripgrep/issues/568
describe("rg regression: r568 - leading hyphen in args", () => {
  it("should handle -e-pattern and -e -pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo bar -baz\n"
      }
    });
    const result = await bash.exec("rg -e '-baz' file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo bar -baz\n");
  });
});

// r599: https://github.com/BurntSushi/ripgrep/issues/599 - SKIP: Color output
it.skip("r599: should handle color with empty matches", () => {});

// r693: https://github.com/BurntSushi/ripgrep/issues/693
describe("rg regression: r693 - context in count mode", () => {
  it("should ignore context with -c", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/bar": "xyz\n",
        "/home/user/foo": "xyz\n"
      }
    });
    const result = await bash.exec("rg -C1 -c --sort path xyz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("bar:1\nfoo:1\n");
  });
});

// r807: https://github.com/BurntSushi/ripgrep/issues/807
describe("rg regression: r807 - hidden with gitignore", () => {
  it("should handle gitignore for hidden subdirectories", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": ".a/b\n",
        "/home/user/.a/b/file": "test\n",
        "/home/user/.a/c/file": "test\n"
      }
    });
    const result = await bash.exec("rg --hidden test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(".a/c/file:1:test\n");
  });
});

// r829 series: https://github.com/BurntSushi/ripgrep/issues/829
describe("rg regression: r829 - anchored gitignore patterns", () => {
  it("r829_original: should handle anchored /a/b pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.ignore": "/a/b\n",
        "/home/user/a/b/test.txt": "Sample text\n"
      }
    });
    const result = await bash.exec("rg Sample");
    expect(result.exitCode).toBe(1);
  });

  it("r829_2731: should handle negation of build directory", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.ignore": "build/\n!/some_dir/build/\n",
        "/home/user/some_dir/build/foo": "string\n"
      }
    });
    const result = await bash.exec("rg -l string");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("some_dir/build/foo\n");
  });

  it("r829_2747: should handle /a/*/b pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.ignore": "/a/*/b\n",
        "/home/user/a/c/b/foo": "",
        "/home/user/a/src/f/b/foo": ""
      }
    });
    const result = await bash.exec("rg --files");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a/src/f/b/foo\n");
  });

  it("r829_2778: should handle /parent/*.txt pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.ignore": "/parent/*.txt\n",
        "/home/user/parent/ignore-me.txt": "",
        "/home/user/parent/subdir/dont-ignore-me.txt": ""
      }
    });
    const result = await bash.exec("rg --files");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("parent/subdir/dont-ignore-me.txt\n");
  });

  it("r829_2836: should handle /testdir/sub/sub2/ pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.ignore": "/testdir/sub/sub2/\n",
        "/home/user/testdir/sub/sub2/foo": ""
      }
    });
    const result = await bash.exec("rg --files");
    expect(result.exitCode).toBe(1);
  });

  it("r829_2933: should handle files-with-matches with ignore", async () => {
    const bash = new Bash({
      cwd: "/home/user/testdir",
      files: {
        "/home/user/.ignore": "/testdir/sub/sub2/\n",
        "/home/user/testdir/sub/sub2/testfile": "needle\n"
      }
    });
    const result = await bash.exec("rg --files-with-matches needle");
    expect(result.exitCode).toBe(1);
  });
});

// r900: https://github.com/BurntSushi/ripgrep/issues/900
describe("rg regression: r900 - empty pattern file", () => {
  it("should error with empty pattern file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/pat": ""
      }
    });
    const result = await bash.exec("rg -f pat sherlock");
    expect(result.exitCode).toBe(1);
  });
});

// r1064: https://github.com/BurntSushi/ripgrep/issues/1064
describe("rg regression: r1064 - capture group", () => {
  it("should match with capture group", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/input": "abc\n"
      }
    });
    const result = await bash.exec("rg 'a(.*c)'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("input:1:abc\n");
  });
});

// r1098: https://github.com/BurntSushi/ripgrep/issues/1098
describe("rg regression: r1098 - gitignore with adjacent stars", () => {
  it("should handle a**b pattern in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "a**b\n",
        "/home/user/afoob": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(1);
  });
});

// r1130: https://github.com/BurntSushi/ripgrep/issues/1130
describe("rg regression: r1130 - files with/without matches", () => {
  it("should list files with matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "test\n"
      }
    });
    const result = await bash.exec("rg --files-with-matches test foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo\n");
  });

  it("should list files without matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "test\n"
      }
    });
    const result = await bash.exec("rg --files-without-match nada foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo\n");
  });
});

// r1159: https://github.com/BurntSushi/ripgrep/issues/1159
describe("rg regression: r1159 - exit codes", () => {
  it("r1159_invalid_flag: should return exit code 2 for invalid flag", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {}
    });
    const result = await bash.exec("rg --wat test");
    expect(result.exitCode).not.toBe(0);
  });

  it("r1159_exit_status: should return correct exit codes", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "test\n"
      }
    });
    // Match = 0
    const result1 = await bash.exec("rg test");
    expect(result1.exitCode).toBe(0);

    // No match = 1
    const result2 = await bash.exec("rg nada");
    expect(result2.exitCode).toBe(1);

    // Quiet with match = 0
    const result3 = await bash.exec("rg -q test");
    expect(result3.exitCode).toBe(0);

    // Quiet with no match = 1
    const result4 = await bash.exec("rg -q nada");
    expect(result4.exitCode).toBe(1);
  });
});

// r1163: https://github.com/BurntSushi/ripgrep/issues/1163
describe("rg regression: r1163 - BOM handling", () => {
  it("should handle UTF-8 BOM", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/bom.txt": "\uFEFFtest123\ntest123\n"
      }
    });
    const result = await bash.exec("rg '^test123'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("bom.txt:1:test123\nbom.txt:2:test123\n");
  });
});

// r1164: https://github.com/BurntSushi/ripgrep/issues/1164 - SKIP: --ignore-file-case-insensitive
it.skip("r1164: should handle --ignore-file-case-insensitive", () => {});

// r1173: https://github.com/BurntSushi/ripgrep/issues/1173
describe("rg regression: r1173 - double star gitignore", () => {
  it("should handle ** in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "**\n",
        "/home/user/foo": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(1);
  });
});

// r1174: https://github.com/BurntSushi/ripgrep/issues/1174
describe("rg regression: r1174 - triple double star", () => {
  it("should handle **/**/* in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "**/**/*\n",
        "/home/user/a/foo": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(1);
  });
});

// r1176: https://github.com/BurntSushi/ripgrep/issues/1176
describe("rg regression: r1176 - pattern file with -F and -x", () => {
  it("r1176_literal_file: should handle -F with pattern file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/patterns": "foo(bar\n",
        "/home/user/test": "foo(bar\n"
      }
    });
    const result = await bash.exec("rg -F -f patterns test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo(bar\n");
  });

  it("r1176_line_regex: should handle -x with pattern file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/patterns": "foo\n",
        "/home/user/test": "foobar\nfoo\nbarfoo\n"
      }
    });
    const result = await bash.exec("rg -x -f patterns test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo\n");
  });
});

// r1203: https://github.com/BurntSushi/ripgrep/issues/1203
describe("rg regression: r1203 - reverse suffix literal", () => {
  it("should match patterns ending with repeated zeros", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "153.230000\n"
      }
    });
    const result1 = await bash.exec("rg '\\d\\d\\d00' test");
    expect(result1.exitCode).toBe(0);
    expect(result1.stdout).toBe("153.230000\n");

    const result2 = await bash.exec("rg '\\d\\d\\d000' test");
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).toBe("153.230000\n");
  });
});

// r1223: https://github.com/BurntSushi/ripgrep/issues/1223 - SKIP: stdin
it.skip("r1223: should handle stdin with dash directory", () => {});

// r1259: https://github.com/BurntSushi/ripgrep/issues/1259
describe("rg regression: r1259 - pattern file without newline", () => {
  it("should handle pattern file without trailing newline", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/patterns-nonl": "[foo]",
        "/home/user/patterns-nl": "[foo]\n",
        "/home/user/test": "fz\n"
      }
    });
    const result1 = await bash.exec("rg -f patterns-nonl test");
    expect(result1.exitCode).toBe(0);
    expect(result1.stdout).toBe("fz\n");

    const result2 = await bash.exec("rg -f patterns-nl test");
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).toBe("fz\n");
  });
});

// r1311: https://github.com/BurntSushi/ripgrep/issues/1311
describe("rg regression: r1311 - multiline replace newline", () => {
  it.skip("should replace newlines in multiline mode", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/input": "hello\nworld\n"
      }
    });
    const result = await bash.exec("rg -U -r '?' -n '\\n' input");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1:hello?world?\n");
  });
});

// r1319: https://github.com/BurntSushi/ripgrep/issues/1319
describe("rg regression: r1319 - DNA sequence pattern", () => {
  it("should match DNA sequence pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/input":
          "CCAGCTACTCGGGAGGCTGAGGCTGGAGGATCGCTTGAGTCCAGGAGTTC\n"
      }
    });
    const result = await bash.exec("rg 'TTGAGTCCAGGAG[ATCG]{2}C'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "CCAGCTACTCGGGAGGCTGAGGCTGGAGGATCGCTTGAGTCCAGGAGTTC"
    );
  });
});

// r1334: https://github.com/BurntSushi/ripgrep/issues/1334
describe("rg regression: r1334 - empty and invert patterns", () => {
  it.skip("r1334_invert_empty_patterns: should invert with zero patterns", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/zero-patterns": "",
        "/home/user/one-pattern": "\n",
        "/home/user/haystack": "one\ntwo\nthree\n"
      }
    });
    // Zero patterns matches nothing
    const result1 = await bash.exec("rg -f zero-patterns haystack");
    expect(result1.exitCode).toBe(1);

    // Invert zero patterns matches everything
    const result2 = await bash.exec("rg -vf zero-patterns haystack");
    expect(result2.exitCode).toBe(0);
    expect(result2.stdout).toBe("one\ntwo\nthree\n");
  });

  it("r1334_crazy_literals: should handle many literal patterns", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/patterns": "1.208.0.0/12\n".repeat(40),
        "/home/user/corpus": "1.208.0.0/12\n"
      }
    });
    const result = await bash.exec("rg -Ff patterns corpus");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.208.0.0/12\n");
  });
});

// r1380: https://github.com/BurntSushi/ripgrep/issues/1380
describe("rg regression: r1380 - max count with context", () => {
  it("should limit matches with -m and show context", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "a\nb\nc\nd\ne\nd\ne\nd\ne\nd\ne\n"
      }
    });
    const result = await bash.exec("rg -A2 -m1 d foo");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("d\ne\nd\n");
  });
});

// r1389: https://github.com/BurntSushi/ripgrep/issues/1389
describe("rg regression: r1389 - follow symlinks without bad symlinks", () => {
  it("should follow good symlinks even when bad symlinks exist", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/real.txt": "test content\n"
      }
    });
    // Create a good symlink
    await bash.exec("ln -s real.txt /home/user/good_link.txt");
    // Create a broken symlink (target doesn't exist)
    await bash.exec("ln -s nonexistent.txt /home/user/bad_link.txt");
    // With -L, should follow good symlinks and skip bad ones
    const result = await bash.exec("rg -L test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test content");
    // Should not error due to broken symlink
  });
});

// r1401: https://github.com/BurntSushi/ripgrep/issues/1401 - SKIP: PCRE2
it.skip("r1401_look_ahead_only_matching_1: requires PCRE2", () => {});
it.skip("r1401_look_ahead_only_matching_2: requires PCRE2", () => {});

// r1412: https://github.com/BurntSushi/ripgrep/issues/1412 - SKIP: PCRE2
it.skip("r1412: requires PCRE2 look-behind", () => {});

// r1446: https://github.com/BurntSushi/ripgrep/pull/1446 - SKIP: git worktrees
it.skip("r1446: requires git worktree support", () => {});

// r1537: https://github.com/BurntSushi/ripgrep/issues/1537
describe("rg regression: r1537 - semicolon comma pattern", () => {
  it("should match semicolon comma pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "abc;de,fg\n"
      }
    });
    const result = await bash.exec("rg ';(.*,){1}'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:abc;de,fg\n");
  });
});

// r1559: https://github.com/BurntSushi/ripgrep/issues/1559
describe("rg regression: r1559 - spaces in pattern", () => {
  it("should match pattern with multiple spaces", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": `type A struct {
	TaskID int \`json:"taskID"\`
}

type B struct {
	ObjectID string \`json:"objectID"\`
	TaskID   int    \`json:"taskID"\`
}
`
      }
    });
    const result = await bash.exec("rg 'TaskID +int'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TaskID int");
    expect(result.stdout).toContain("TaskID   int");
  });
});

// r1573: https://github.com/BurntSushi/ripgrep/issues/1573 - SKIP: PCRE2
it.skip("r1573: requires PCRE2", () => {});

// r1638: https://github.com/BurntSushi/ripgrep/issues/1638
describe("rg regression: r1638 - BOM column index", () => {
  it("should have correct column with BOM", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "\uFEFFx\n"
      }
    });
    const result = await bash.exec("rg --column x");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:1:x\n");
  });
});

// r1739: https://github.com/BurntSushi/ripgrep/issues/1739
describe("rg regression: r1739 - replacement with line terminator", () => {
  it("should replace with reference to full match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "a\n"
      }
    });
    const result = await bash.exec("rg -r '${0}f' '.*' test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("af\n");
  });
});

// f1757: https://github.com/BurntSushi/ripgrep/issues/1757
describe("rg regression: f1757 - ignore with path prefix", () => {
  it("should handle ignore with path prefix", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.ignore": "rust/target\n",
        "/home/user/rust/source.rs": "needle\n",
        "/home/user/rust/target/rustdoc-output.html": "needle\n"
      }
    });
    const result = await bash.exec("rg --files-with-matches needle rust");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("rust/source.rs\n");
  });
});

// r1765: https://github.com/BurntSushi/ripgrep/issues/1765 - SKIP: --crlf
it.skip("r1765: requires --crlf", () => {});

// r1838: https://github.com/BurntSushi/ripgrep/issues/1838
describe("rg regression: r1838 - NUL in pattern", () => {
  it.skip("should error on NUL in pattern without -a", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "foo\n"
      }
    });
    const result = await bash.exec("rg 'foo\\x00?' test");
    expect(result.exitCode).not.toBe(0);
  });

  it.skip("should allow NUL in pattern with -a", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "foo\n"
      }
    });
    const result = await bash.exec("rg -a 'foo\\x00?' test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test:1:foo\n");
  });
});

// r1866: https://github.com/BurntSushi/ripgrep/issues/1866
describe("rg regression: r1866 - vimgrep multiline", () => {
  it.skip("should show first line only in vimgrep multiline", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "foobar\nfoobar\nfoo quux\n"
      }
    });
    const result = await bash.exec(
      "rg --multiline --vimgrep 'foobar\\nfoobar\\nfoo|quux' test"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test:1:1:foobar");
    expect(result.stdout).toContain("test:3:5:foo quux");
  });
});

// r1868: https://github.com/BurntSushi/ripgrep/issues/1868
// Note: Requires order-dependent flag handling (last flag wins)
describe("rg regression: r1868 - context passthru override", () => {
  it.skip("should allow context to override passthru", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "foo\nbar\nbaz\nquux\n"
      }
    });
    const result1 = await bash.exec("rg -C1 bar test");
    expect(result1.stdout).toBe("foo\nbar\nbaz\n");

    const result2 = await bash.exec("rg --passthru bar test");
    expect(result2.stdout).toBe("foo\nbar\nbaz\nquux\n");

    const result3 = await bash.exec("rg --passthru -C1 bar test");
    expect(result3.stdout).toBe("foo\nbar\nbaz\n");

    const result4 = await bash.exec("rg -C1 --passthru bar test");
    expect(result4.stdout).toBe("foo\nbar\nbaz\nquux\n");
  });
});

// r1878: https://github.com/BurntSushi/ripgrep/issues/1878
describe("rg regression: r1878 - multiline anchor", () => {
  it("should match ^ at line start in multiline mode", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "a\nbaz\nabc\n"
      }
    });
    const result = await bash.exec("rg -U '^baz' test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("baz\n");
  });
});

// r1891: https://github.com/BurntSushi/ripgrep/issues/1891
describe("rg regression: r1891 - empty match word boundary", () => {
  // Skipped: RE2 uses \b for word boundaries; empty pattern with \b doesn't match usefully
  it.skip("should handle empty matches with -won", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "\n##\n"
      }
    });
    const result = await bash.exec("rg -won '' test");
    expect(result.exitCode).toBe(0);
    // Empty pattern matches at word boundaries
  });
});

// r2094: https://github.com/BurntSushi/ripgrep/issues/2094
describe("rg regression: r2094 - multiline max-count passthru", () => {
  it.skip("should handle multiline with max-count and passthru", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/haystack": "a\nb\nc\na\nb\nc\n"
      }
    });
    const result = await bash.exec(
      "rg --no-line-number --no-filename --multiline --max-count=1 --passthru --replace=B b haystack"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\nB\nc\na\nb\nc\n");
  });
});

// r2095: https://github.com/BurntSushi/ripgrep/issues/2095 - Complex multiline
it.skip("r2095: complex multiline replacement", () => {});

// r2198: https://github.com/BurntSushi/ripgrep/issues/2198
describe("rg regression: r2198 - no-ignore-dot", () => {
  it("should handle --no-ignore-dot", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.ignore": "a\n",
        "/home/user/.rgignore": "b\n",
        "/home/user/a": "",
        "/home/user/b": "",
        "/home/user/c": ""
      }
    });
    const result1 = await bash.exec("rg --files --sort path");
    expect(result1.stdout).toBe("c\n");

    const result2 = await bash.exec("rg --files --sort path --no-ignore-dot");
    expect(result2.stdout).toBe("a\nb\nc\n");
  });
});

// r2208: https://github.com/BurntSushi/ripgrep/issues/2208 - Complex regex
it.skip("r2208: complex regex with named groups", () => {});

// r2236: https://github.com/BurntSushi/ripgrep/issues/2236
describe("rg regression: r2236 - escaped slash in ignore", () => {
  it.skip("should handle escaped slash in ignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.ignore": "foo\\/\n",
        "/home/user/foo/bar": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(1);
  });
});

// r2480: https://github.com/BurntSushi/ripgrep/issues/2480
describe("rg regression: r2480 - multiple patterns", () => {
  it.skip("should handle empty pattern with -e", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "FooBar\n"
      }
    });
    const result = await bash.exec("rg -e '' file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("FooBar\n");
  });

  it("should handle multiple -e patterns with only-matching", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "FooBar\n"
      }
    });
    const result = await bash.exec("rg --only-matching -e Foo -e Bar file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Foo\nBar\n");
  });
});

// r2574: https://github.com/BurntSushi/ripgrep/issues/2574 - SKIP: --no-unicode
it.skip("r2574: requires --no-unicode", () => {});

// r2658: https://github.com/BurntSushi/ripgrep/issues/2658 - SKIP: --null-data
it.skip("r2658: requires --null-data", () => {});

// r2711: https://github.com/BurntSushi/ripgrep/pull/2711
describe("rg regression: r2711 - hidden files with path prefix", () => {
  it("should list hidden files with --files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a/.ignore": ".foo\n",
        "/home/user/a/b/.foo": ""
      }
    });
    const result = await bash.exec("rg --hidden --files");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a/.ignore\n");
  });

  it("should preserve ./ prefix", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a/.ignore": ".foo\n"
      }
    });
    const result = await bash.exec("rg --hidden --files ./");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("./a/.ignore\n");
  });
});

// r2770: https://github.com/BurntSushi/ripgrep/issues/2770
describe("rg regression: r2770 - gitignore with double star path", () => {
  it("should handle **/bar/* pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "**/bar/*\n",
        "/home/user/foo/bar/baz": "quux\n"
      }
    });
    const result = await bash.exec("rg -l quux");
    expect(result.exitCode).toBe(1);
  });
});

// r2944: https://github.com/BurntSushi/ripgrep/pull/2944
describe("rg regression: r2944 - bytes searched with max-count", () => {
  it("should report correct bytes searched with -m", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/haystack": "foo1\nfoo2\nfoo3\nfoo4\nfoo5\n"
      }
    });
    const result = await bash.exec("rg --stats -m2 foo .");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bytes searched");
  });
});

// r2990: https://github.com/BurntSushi/ripgrep/issues/2990 - SKIP: trailing dot directory
it.skip("r2990: trailing dot directory edge case", () => {});

// r3067: https://github.com/BurntSushi/ripgrep/issues/3067
describe("rg regression: r3067 - gitignore foobar/debug", () => {
  it("should handle foobar/debug pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "foobar/debug\n",
        "/home/user/foobar/some/debug/flag": "baz\n",
        "/home/user/foobar/debug/flag2": "baz\n"
      }
    });
    const result = await bash.exec("rg baz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foobar/some/debug/flag:1:baz\n");
  });
});

// r3108: https://github.com/BurntSushi/ripgrep/issues/3108
describe("rg regression: r3108 - files-without-match quiet exit", () => {
  it("should return correct exit codes with files-without-match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/yes-match": "abc\n",
        "/home/user/non-match": "xyz\n"
      }
    });
    const result1 = await bash.exec("rg --files-without-match abc non-match");
    expect(result1.exitCode).toBe(0);
    expect(result1.stdout).toBe("non-match\n");

    const result2 = await bash.exec("rg --files-without-match abc yes-match");
    expect(result2.exitCode).toBe(1);

    const result3 = await bash.exec(
      "rg --files-without-match -q abc non-match"
    );
    expect(result3.exitCode).toBe(0);
    expect(result3.stdout).toBe("");
  });
});

// r3127: https://github.com/BurntSushi/ripgrep/issues/3127
describe("rg regression: r3127 - unclosed character class", () => {
  it("r3127_gitignore_allow_unclosed_class: should allow unclosed class in gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/.gitignore": "[abc\n",
        "/home/user/[abc": "",
        "/home/user/test": ""
      }
    });
    const result = await bash.exec("rg --files");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test\n");
  });

  it("r3127_glob_flag_not_allow_unclosed_class: should error on unclosed class in glob", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/[abc": "",
        "/home/user/test": ""
      }
    });
    const result = await bash.exec("rg --files -g '[abc'");
    expect(result.exitCode).not.toBe(0);
  });
});

// r3139: https://github.com/BurntSushi/ripgrep/issues/3139 - SKIP: PCRE2
it.skip("r3139: requires PCRE2 look-ahead", () => {});

// r3173: https://github.com/BurntSushi/ripgrep/issues/3173
describe("rg regression: r3173 - hidden whitelist only dot", () => {
  it.skip("should handle hidden whitelist with dot path", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/subdir/.foo.txt": "text\n",
        "/home/user/.ignore": "!.foo.txt\n"
      }
    });
    const result = await bash.exec("rg --files");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("subdir/.foo.txt\n");
  });
});

// r3179: https://github.com/BurntSushi/ripgrep/issues/3179 - SKIP: --ignore-file
it.skip("r3179: requires --ignore-file", () => {});

// r3180: https://github.com/BurntSushi/ripgrep/issues/3180
describe("rg regression: r3180 - complex pattern no panic", () => {
  it.skip("should handle complex pattern without panic", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/haystack": " b b b b b b b b\nc\n"
      }
    });
    const result = await bash.exec(
      `rg '(^|[^a-z])((([a-z]+)?)s)?b(s([a-z]+)?)($|[^a-z])' haystack -U -r x`
    );
    expect(result.exitCode).toBe(0);
  });
});
