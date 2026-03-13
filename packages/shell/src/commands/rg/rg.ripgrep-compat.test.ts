/**
 * Tests ported from ripgrep's test suite
 * Source: https://github.com/BurntSushi/ripgrep/tree/master/tests
 *
 * These tests validate compatibility with real ripgrep behavior.
 */
import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

// Classic test fixture from ripgrep tests
const SHERLOCK = `For the Doctor Watsons of this world, as opposed to the Sherlock
Holmeses, success in the province of detective work must always
be, to a very large extent, the result of luck. Sherlock Holmes
can extract a clew from a wisp of straw or a flake of cigar ash;
but Doctor Watson has to have it taken out for him and dusted,
and exhibited clearly, with a label attached.
`;

describe("rg ripgrep-compat: basic search", () => {
  it("should search single file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    // ripgrep: single file = no filename prefix, no line numbers by default
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nbe, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });

  it("should search directory with filename prefix", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "sherlock:1:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });

  it("should show line numbers with -n", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -n Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "1:For the Doctor Watsons of this world, as opposed to the Sherlock\n3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });

  it("should hide line numbers with -N", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -N Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nbe, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

describe("rg ripgrep-compat: inverted match", () => {
  it("should invert match with -v", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -v Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    // Lines NOT containing "Sherlock"
    expect(result.stdout).toBe(
      "Holmeses, success in the province of detective work must always\ncan extract a clew from a wisp of straw or a flake of cigar ash;\nbut Doctor Watson has to have it taken out for him and dusted,\nand exhibited clearly, with a label attached.\n"
    );
  });

  it("should show line numbers with inverted match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -n -v Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "2:Holmeses, success in the province of detective work must always\n4:can extract a clew from a wisp of straw or a flake of cigar ash;\n5:but Doctor Watson has to have it taken out for him and dusted,\n6:and exhibited clearly, with a label attached.\n"
    );
  });
});

describe("rg ripgrep-compat: case sensitivity", () => {
  it("should be case-insensitive with -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -i sherlock sherlock");
    expect(result.exitCode).toBe(0);
    // Should match "Sherlock" case-insensitively
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nbe, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });

  it("should use smart case with lowercase pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "tEsT\n"
      }
    });
    // Smart case: lowercase pattern = case-insensitive
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:tEsT\n");
  });

  it("should use smart case with uppercase pattern (case-sensitive)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "tEsT\nTEST\n"
      }
    });
    // Smart case: uppercase in pattern = case-sensitive
    const result = await bash.exec("rg TEST");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:2:TEST\n");
  });

  it("should override smart case with -s", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "tEsT\ntest\n"
      }
    });
    // -s forces case-sensitive even with lowercase pattern
    const result = await bash.exec("rg -s test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:2:test\n");
  });
});

describe("rg ripgrep-compat: word matching", () => {
  it("should match whole words with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -w as sherlock");
    expect(result.exitCode).toBe(0);
    // "as" as a word appears in first line
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\n"
    );
  });

  it("should match words with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/haystack": "foo bar baz\nfoobar\n"
      }
    });
    // -w should match "foo" as a word, not "foo" within "foobar"
    const result = await bash.exec("rg -w foo haystack");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo bar baz\n");
  });
});

describe("rg ripgrep-compat: line matching", () => {
  it("should match whole lines with -x", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec(
      "rg -x 'and exhibited clearly, with a label attached.' sherlock"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "and exhibited clearly, with a label attached.\n"
    );
  });
});

describe("rg ripgrep-compat: literal matching", () => {
  it("should match literal pattern with -F", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "blib\n()\nblab\n"
      }
    });
    const result = await bash.exec("rg -F '()' file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("()\n");
  });
});

describe("rg ripgrep-compat: quiet mode", () => {
  it("should suppress output with -q", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -q Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("should return exit code 1 with -q and no match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -q NADA sherlock");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });
});

describe("rg ripgrep-compat: file type filtering", () => {
  it("should filter by type with -t", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/file.py": "Sherlock\n",
        "/home/user/file.rs": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg -t rust Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.rs:1:Sherlock\n");
  });

  it("should negate type with -T", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.py": "Sherlock\n",
        "/home/user/file.rs": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg -T rust Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.py:1:Sherlock\n");
  });
});

describe("rg ripgrep-compat: glob filtering", () => {
  it("should filter files with -g", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/file.py": "Sherlock\n",
        "/home/user/file.rs": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg -g '*.rs' Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.rs:1:Sherlock\n");
  });

  it("should negate glob with -g !", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.py": "Sherlock\n",
        "/home/user/file.rs": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg -g '!*.rs' Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.py:1:Sherlock\n");
  });

  it("should support case-insensitive glob matching scenario", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.HTML": "Sherlock\n",
        "/home/user/file.html": "Sherlock\n"
      }
    });
    // Standard glob is case-sensitive
    const result = await bash.exec("rg -g '*.html' Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.html:1:Sherlock\n");
  });
});

describe("rg ripgrep-compat: count", () => {
  it("should count matching lines with -c", async () => {
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
});

describe("rg ripgrep-compat: files with/without matches", () => {
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
});

describe("rg ripgrep-compat: context lines", () => {
  it("should show after context with -A", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -A 1 Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nHolmeses, success in the province of detective work must always\nbe, to a very large extent, the result of luck. Sherlock Holmes\ncan extract a clew from a wisp of straw or a flake of cigar ash;\n"
    );
  });

  it("should show before context with -B", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -B 1 Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nHolmeses, success in the province of detective work must always\nbe, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });

  it("should show context with -C", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -C 1 'world|attached' sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nHolmeses, success in the province of detective work must always\n--\nbut Doctor Watson has to have it taken out for him and dusted,\nand exhibited clearly, with a label attached.\n"
    );
  });
});

describe("rg ripgrep-compat: hidden files", () => {
  it("should ignore hidden files by default", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg Sherlock");
    expect(result.exitCode).toBe(1);
  });

  it("should include hidden files with --hidden", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --hidden Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      ".sherlock:1:For the Doctor Watsons of this world, as opposed to the Sherlock\n.sherlock:3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

describe("rg ripgrep-compat: gitignore", () => {
  it("should respect .gitignore by default", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "sherlock\n",
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg Sherlock");
    expect(result.exitCode).toBe(1);
  });

  it("should ignore .gitignore with --no-ignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "sherlock\n",
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --no-ignore Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "sherlock:1:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

describe("rg ripgrep-compat: max depth", () => {
  it("should limit depth with --max-depth", async () => {
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
});

describe("rg ripgrep-compat: multiple patterns", () => {
  it("should match multiple patterns with -e", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "foo\nbar\nbaz\n"
      }
    });
    const result = await bash.exec("rg -e foo -e bar");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.txt:1:foo\nfile.txt:2:bar\n");
  });

  it("should handle -e with dash pattern", async () => {
    // Regression test from ripgrep #270
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

describe("rg ripgrep-compat: only matching", () => {
  it("should show only matching text with -o", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/digits.txt": "1 2 3\n"
      }
    });
    const result = await bash.exec("rg -o '[0-9]+' digits.txt");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1\n2\n3\n");
  });
});

describe("rg ripgrep-compat: regex patterns", () => {
  it("should match IP address pattern", async () => {
    // Regression test from ripgrep #93
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

  it("should match alternation pattern", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "cat\ndog\nbird\n"
      }
    });
    const result = await bash.exec("rg 'cat|dog'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file:1:cat\nfile:2:dog\n");
  });
});

describe("rg ripgrep-compat: exit codes", () => {
  it("should return 0 on match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg .");
    expect(result.exitCode).toBe(0);
  });

  it("should return 1 on no match", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg NADA");
    expect(result.exitCode).toBe(1);
  });

  it("should return 2 on error", async () => {
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

describe("rg ripgrep-compat: binary files", () => {
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
  });
});

describe("rg ripgrep-compat: gitignore patterns", () => {
  it("should handle directory ignore pattern", async () => {
    // Regression test from ripgrep #16
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "ghi/\n",
        "/home/user/ghi/toplevel.txt": "xyz\n",
        "/home/user/def/ghi/subdir.txt": "xyz\n"
      }
    });
    const result = await bash.exec("rg xyz");
    expect(result.exitCode).toBe(1);
  });

  it("should handle rooted pattern in gitignore", async () => {
    // Regression test from ripgrep #25
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "/llvm/\n",
        "/home/user/src/llvm/foo": "test\n"
      }
    });
    const result = await bash.exec("rg test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("src/llvm/foo:1:test\n");
  });

  it("should handle negation after double-star", async () => {
    // Regression test from ripgrep #30
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

  it("should handle unanchored directory pattern", async () => {
    // Regression test from ripgrep #49
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

  it("should handle negation of hidden file", async () => {
    // Regression test from ripgrep #90
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.gitignore": "!.foo\n",
        "/home/user/.foo": "test\n"
      }
    });
    const result = await bash.exec("rg --hidden test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(".foo:1:test\n");
  });
});

describe("rg ripgrep-compat: unicode", () => {
  it("should match cyrillic with -i", async () => {
    // Regression test from ripgrep #251
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

// =============================================================================
// MISSING FEATURES - Tests that document what ripgrep features we don't have
// =============================================================================

describe("rg ripgrep-compat: column numbers (--column)", () => {
  it("should show column with --column", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -n --column Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "1:57:For the Doctor Watsons of this world, as opposed to the Sherlock\n3:49:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

describe("rg ripgrep-compat: patterns from file (-f)", () => {
  it("should read patterns from file with -f", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/.patterns": "Sherlock\nHolmes\n"
      }
    });
    // Use hidden file for patterns to avoid it being searched
    // When searching a single file, rg doesn't show filename by default
    const result = await bash.exec("rg -f .patterns sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nHolmeses, success in the province of detective work must always\nbe, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

describe("rg ripgrep-compat: replace (-r)", () => {
  it("should replace matches with -r", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -r FooBar Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the FooBar\nbe, to a very large extent, the result of luck. FooBar Holmes\n"
    );
  });
});

describe("rg ripgrep-compat: vimgrep format (--vimgrep)", () => {
  it("should output vimgrep format with --vimgrep", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --vimgrep 'Sherlock|Watson' sherlock");
    expect(result.exitCode).toBe(0);
    // Each match on separate line (line 1 appears twice for Watson and Sherlock)
    expect(result.stdout).toBe(
      "1:16:For the Doctor Watsons of this world, as opposed to the Sherlock\n1:57:For the Doctor Watsons of this world, as opposed to the Sherlock\n3:49:be, to a very large extent, the result of luck. Sherlock Holmes\n5:12:but Doctor Watson has to have it taken out for him and dusted,\n"
    );
  });
});

describe("rg ripgrep-compat: null separator (-0)", () => {
  it("should use null separator with -0", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -0 -l Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock\x00");
  });
});

describe("rg ripgrep-compat: max count (-m)", () => {
  it("should stop after N matches with -m", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "test\ntest\ntest\n"
      }
    });
    const result = await bash.exec("rg -m1 test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo:1:test\n");
  });
});

describe("rg ripgrep-compat: count matches (--count-matches)", () => {
  it("should count individual matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --count-matches the");
    expect(result.exitCode).toBe(0);
    // "the" appears 4 times in SHERLOCK
    expect(result.stdout).toBe("sherlock:4\n");
  });
});

describe("rg ripgrep-compat: heading mode (--heading)", () => {
  it("should group results by file with --heading", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --heading Sherlock");
    expect(result.exitCode).toBe(0);
    // File name on its own line, then matches without filename prefix
    expect(result.stdout).toMatch(/^sherlock\n/);
  });
});

describe("rg ripgrep-compat: byte offset (-b)", () => {
  it("should show byte offset with -b", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -b -o Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock:56:Sherlock\nsherlock:177:Sherlock\n");
  });
});

describe("rg ripgrep-compat: context separator (--context-separator)", () => {
  it("should use custom context separator", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "foo\nctx\nbar\nctx\nfoo\nctx\n"
      }
    });
    const result = await bash.exec("rg -A1 --context-separator AAA foo test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo\nctx\nAAA\nfoo\nctx\n");
  });
});

describe("rg ripgrep-compat: multiline (-U)", () => {
  it("should match across lines with -U", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo\nbar\n"
      }
    });
    const result = await bash.exec("rg -U 'foo\\nbar'");
    expect(result.exitCode).toBe(0);
  });
});

describe("rg ripgrep-compat: passthrough (--passthru)", () => {
  it("should print all lines with --passthru", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "\nfoo\nbar\nfoobar\n\nbaz\n"
      }
    });
    const result = await bash.exec("rg -n --passthru foo file");
    expect(result.exitCode).toBe(0);
    // All lines printed, matches marked with :, non-matches with -
    expect(result.stdout).toBe("1-\n2:foo\n3-bar\n4:foobar\n5-\n6-baz\n");
  });
});

describe("rg ripgrep-compat: sort (--sort)", () => {
  it("should sort files with --sort path", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/foo": "test\n",
        "/home/user/abc": "test\n",
        "/home/user/zoo": "test\n",
        "/home/user/bar": "test\n"
      }
    });
    const result = await bash.exec("rg --sort path test");
    expect(result.exitCode).toBe(0);
    // Files are sorted alphabetically by path
    expect(result.stdout).toBe(
      "abc:1:test\nbar:1:test\nfoo:1:test\nzoo:1:test\n"
    );
  });
});

describe("rg ripgrep-compat: no-filename (-I)", () => {
  it("should hide filename with --no-filename", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --no-filename Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "1:For the Doctor Watsons of this world, as opposed to the Sherlock\n3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });

  it("should hide filename with -I", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -I Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "1:For the Doctor Watsons of this world, as opposed to the Sherlock\n3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

describe("rg ripgrep-compat: include-zero (--include-zero)", () => {
  it("should include zero counts with --include-zero", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -c --include-zero nada");
    // Exit code 1 because no matches, but still outputs count
    expect(result.stdout).toBe("sherlock:0\n");
  });
});
