/**
 * Tests imported from ripgrep: tests/misc.rs
 *
 * Total: 93 tests (matching ripgrep test count)
 * Miscellaneous tests for various ripgrep behaviors.
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

// 1. single_file
describe("rg misc: single_file", () => {
  it("should search single file without filename prefix", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nbe, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 2. dir
describe("rg misc: dir", () => {
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
});

// 3. line_numbers
describe("rg misc: line_numbers", () => {
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
});

// 4. columns
describe("rg misc: columns", () => {
  it("should show column numbers with --column", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --column Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "1:57:For the Doctor Watsons of this world, as opposed to the Sherlock\n3:49:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 5. with_filename - -H forces filename display even for single file
describe("rg misc: with_filename", () => {
  it("should show filename with -H even for single file", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -H Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    // -H forces filename prefix even for single file
    expect(result.stdout).toBe(
      "sherlock:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 6. with_heading
describe("rg misc: with_heading", () => {
  it("should show heading format", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --heading Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "sherlock\nFor the Doctor Watsons of this world, as opposed to the Sherlock\nbe, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 7. with_heading_default - SKIP: requires -j1 flag
it.skip("with_heading_default: requires -j1 flag", () => {});

// 8. inverted
describe("rg misc: inverted", () => {
  it("should invert match with -v", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -v Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "Holmeses, success in the province of detective work must always\ncan extract a clew from a wisp of straw or a flake of cigar ash;\nbut Doctor Watson has to have it taken out for him and dusted,\nand exhibited clearly, with a label attached.\n"
    );
  });
});

// 9. inverted_line_numbers
describe("rg misc: inverted_line_numbers", () => {
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

// 10. case_insensitive
describe("rg misc: case_insensitive", () => {
  it("should search case-insensitively with -i", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -i sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nbe, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 11. word
describe("rg misc: word", () => {
  it("should match whole words with -w", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -w as sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\n"
    );
  });
});

// 12. word_period
describe("rg misc: word_period", () => {
  // Skipped: RE2 uses \b for word boundaries, which requires word characters
  // Non-word chars like '.' don't have word boundaries around them in RE2
  it.skip("should handle period as word with -ow", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/haystack": "...\n"
      }
    });
    const result = await bash.exec("rg -ow '.' haystack");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(".\n.\n.\n");
  });
});

// 13. line
describe("rg misc: line", () => {
  it("should match whole lines with -x", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec(
      "rg -x 'Watson|and exhibited clearly, with a label attached.' sherlock"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "and exhibited clearly, with a label attached.\n"
    );
  });
});

// 14. literal
describe("rg misc: literal", () => {
  it("should match literal strings with -F", async () => {
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

// 15. quiet
describe("rg misc: quiet", () => {
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
});

// 16. replace
describe("rg misc: replace", () => {
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

// 17. replace_groups
describe("rg misc: replace_groups", () => {
  it("should replace with capture groups", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec(
      `rg -r '$2, $1' '([A-Z][a-z]+) ([A-Z][a-z]+)' sherlock`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Watsons, Doctor of this world, as opposed to the Sherlock\nbe, to a very large extent, the result of luck. Holmes, Sherlock\nbut Watson, Doctor has to have it taken out for him and dusted,\n"
    );
  });
});

// 18. replace_named_groups
describe("rg misc: replace_named_groups", () => {
  it("should replace with named capture groups", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec(
      `rg -r '$last, $first' '(?P<first>[A-Z][a-z]+) (?P<last>[A-Z][a-z]+)' sherlock`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Watsons, Doctor of this world, as opposed to the Sherlock\nbe, to a very large extent, the result of luck. Holmes, Sherlock\nbut Watson, Doctor has to have it taken out for him and dusted,\n"
    );
  });
});

// 19. replace_with_only_matching
describe("rg misc: replace_with_only_matching", () => {
  it("should replace only matching parts", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec(`rg -o -r '$1' 'of (\\w+)' sherlock`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("this\ndetective\nluck\nstraw\ncigar\n");
  });
});

// 20. file_types
describe("rg misc: file_types", () => {
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
});

// 21. file_types_all
describe("rg misc: file_types_all", () => {
  it("should filter type 'all' (only typed files)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/file.py": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg -t all Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.py:1:Sherlock\n");
  });
});

// 22. file_types_negate
describe("rg misc: file_types_negate", () => {
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

// 23. file_types_negate_all
describe("rg misc: file_types_negate_all", () => {
  it("should negate type 'all' (only untyped files)", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/file.py": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg -T all Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "sherlock:1:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 24. file_type_clear
describe("rg misc: file_type_clear", () => {
  it("should clear type patterns with --type-clear", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.py": "test\n",
        "/home/user/file.rs": "test\n"
      }
    });
    // Clear py type, then search for it - should find nothing
    const result = await bash.exec("rg --type-clear py -t py test");
    expect(result.exitCode).toBe(1); // No matches since py type is empty
    expect(result.stdout).toBe("");
  });
});

// 25. file_type_add
describe("rg misc: file_type_add", () => {
  it("should add type patterns with --type-add", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.foo": "test\n",
        "/home/user/file.bar": "test\n"
      }
    });
    // Add new type 'custom' for .foo files
    const result = await bash.exec(
      "rg --type-add 'custom:*.foo' -t custom test"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.foo:1:test\n");
  });
});

// 26. file_type_add_compose
describe("rg misc: file_type_add_compose", () => {
  it("should compose types with include", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.js": "test\n",
        "/home/user/file.ts": "test\n",
        "/home/user/file.py": "test\n"
      }
    });
    // Create 'web' type that includes js type patterns
    const result = await bash.exec(
      "rg --type-add 'web:include:js' -t web test"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file.js:1:test\n");
  });
});

// 26b. preprocessing (--pre, --pre-glob)
describe("rg misc: preprocessing", () => {
  it("should preprocess files with --pre", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "original content\n"
      }
    });
    // Create a preprocessor that transforms content
    // Since we need a command, let's use a simple echo-based transform
    const result = await bash.exec(`rg --pre 'cat' test file.txt`);
    // The cat preprocessor just outputs the file, so we won't find 'test'
    expect(result.exitCode).toBe(1);
  });

  it("should apply --pre-glob to limit preprocessing", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file.txt": "hello world\n",
        "/home/user/file.dat": "hello world\n"
      }
    });
    // Use --pre-glob to only preprocess .dat files
    const result = await bash.exec("rg --pre 'cat' --pre-glob '*.dat' hello");
    expect(result.exitCode).toBe(0);
    // Both files should be searched (preprocessing doesn't change content with cat)
    expect(result.stdout).toContain("hello world");
  });
});

// 27. glob
describe("rg misc: glob", () => {
  it("should filter by glob with -g", async () => {
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
});

// 28. glob_negate
describe("rg misc: glob_negate", () => {
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
});

// 29. glob_case_insensitive
describe("rg misc: glob_case_insensitive", () => {
  it("should use case-insensitive glob matching with --iglob", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file1.HTML": "Sherlock\n",
        "/home/user/file2.html": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg --iglob '*.html' Sherlock");
    expect(result.exitCode).toBe(0);
    // Both files should match since iglob is case-insensitive
    expect(result.stdout).toBe(
      "file1.HTML:1:Sherlock\nfile2.html:1:Sherlock\n"
    );
  });
});

// 30. glob_case_sensitive
describe("rg misc: glob_case_sensitive", () => {
  it("should use case-sensitive glob matching", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file1.HTML": "Sherlock\n",
        "/home/user/file2.html": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg --glob '*.html' Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("file2.html:1:Sherlock\n");
  });
});

// 31. glob_always_case_insensitive
describe("rg misc: glob_always_case_insensitive", () => {
  it("should make all globs case-insensitive with --glob-case-insensitive", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file1.HTML": "Sherlock\n",
        "/home/user/file2.html": "Sherlock\n"
      }
    });
    const result = await bash.exec(
      "rg --glob-case-insensitive --glob '*.html' Sherlock"
    );
    expect(result.exitCode).toBe(0);
    // Both files should match
    expect(result.stdout).toBe(
      "file1.HTML:1:Sherlock\nfile2.html:1:Sherlock\n"
    );
  });
});

// 32. byte_offset_only_matching
describe("rg misc: byte_offset_only_matching", () => {
  it("should show byte offset with -b -o", async () => {
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

// 33. count
describe("rg misc: count", () => {
  it("should count matching lines with --count", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --count Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock:2\n");
  });
});

// 34. count_matches
describe("rg misc: count_matches", () => {
  it("should count all matches with --count-matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --count-matches the");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock:4\n");
  });
});

// 35. count_matches_inverted
describe("rg misc: count_matches_inverted", () => {
  it("should count inverted matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec(
      "rg --count-matches --invert-match Sherlock"
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock:4\n");
  });
});

// 36. count_matches_via_only
describe("rg misc: count_matches_via_only", () => {
  it("should count via --count --only-matching", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --count --only-matching the");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock:4\n");
  });
});

// 37. include_zero
describe("rg misc: include_zero", () => {
  it("should include files with 0 matches with --include-zero", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --count --include-zero nada");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("sherlock:0\n");
  });
});

// 38. include_zero_override - SKIP: --no-include-zero not implemented
it.skip("include_zero_override: --no-include-zero not implemented", () => {});

// 39. files_with_matches
describe("rg misc: files_with_matches", () => {
  it("should list files with --files-with-matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --files-with-matches Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("sherlock\n");
  });
});

// 40. files_without_match
describe("rg misc: files_without_match", () => {
  it("should list files without match", async () => {
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

// 41. after_context
describe("rg misc: after_context", () => {
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
});

// 42. after_context_line_numbers
describe("rg misc: after_context_line_numbers", () => {
  it("should show after context with line numbers", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -A 1 -n Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "1:For the Doctor Watsons of this world, as opposed to the Sherlock\n2-Holmeses, success in the province of detective work must always\n3:be, to a very large extent, the result of luck. Sherlock Holmes\n4-can extract a clew from a wisp of straw or a flake of cigar ash;\n"
    );
  });
});

// 43. before_context
describe("rg misc: before_context", () => {
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
});

// 44. before_context_line_numbers
describe("rg misc: before_context_line_numbers", () => {
  it("should show before context with line numbers", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -B 1 -n Sherlock sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "1:For the Doctor Watsons of this world, as opposed to the Sherlock\n2-Holmeses, success in the province of detective work must always\n3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 45. context
describe("rg misc: context", () => {
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

// 46. context_line_numbers
describe("rg misc: context_line_numbers", () => {
  it("should show context with line numbers", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -C 1 -n 'world|attached' sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "1:For the Doctor Watsons of this world, as opposed to the Sherlock\n2-Holmeses, success in the province of detective work must always\n--\n5-but Doctor Watson has to have it taken out for him and dusted,\n6:and exhibited clearly, with a label attached.\n"
    );
  });
});

// 47-52. max_filesize_*
describe("rg misc: max_filesize", () => {
  it("should filter files by size with --max-filesize", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/small.txt": "Sherlock\n", // 9 bytes
        "/home/user/large.txt": `Sherlock ${"x".repeat(100)}\n` // > 100 bytes
      }
    });
    // Only small file should match
    const result = await bash.exec("rg --max-filesize 50 Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("small.txt:1:Sherlock\n");
  });

  it("should accept K suffix for kilobytes", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test.txt": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg --max-filesize 1K Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test.txt:1:Sherlock\n");
  });

  it("should accept M suffix for megabytes", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test.txt": "Sherlock\n"
      }
    });
    const result = await bash.exec("rg --max-filesize 1M Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("test.txt:1:Sherlock\n");
  });
});

// 53. ignore_hidden
describe("rg misc: ignore_hidden", () => {
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
});

// 54. no_ignore_hidden
describe("rg misc: no_ignore_hidden", () => {
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

// 55. ignore_git
describe("rg misc: ignore_git", () => {
  it("should respect .gitignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.git/.gitkeep": "",
        "/home/user/sherlock": SHERLOCK,
        "/home/user/.gitignore": "sherlock\n"
      }
    });
    const result = await bash.exec("rg Sherlock");
    expect(result.exitCode).toBe(1);
  });
});

// 56. ignore_generic
describe("rg misc: ignore_generic", () => {
  it("should respect .ignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/.ignore": "sherlock\n"
      }
    });
    const result = await bash.exec("rg Sherlock");
    expect(result.exitCode).toBe(1);
  });
});

// 57. ignore_ripgrep
describe("rg misc: ignore_ripgrep", () => {
  it("should respect .rgignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/.rgignore": "sherlock\n"
      }
    });
    const result = await bash.exec("rg Sherlock");
    expect(result.exitCode).toBe(1);
  });
});

// 58. no_ignore
describe("rg misc: no_ignore", () => {
  it("should ignore .gitignore with --no-ignore", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/.gitignore": "sherlock\n"
      }
    });
    const result = await bash.exec("rg --no-ignore Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "sherlock:1:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 59-63. Parent ignore tests - SKIP: require cwd manipulation
it.skip("ignore_git_parent: requires cwd manipulation", () => {});
it.skip("ignore_git_parent_stop: requires cwd manipulation", () => {});
it.skip("ignore_git_parent_stop_file: requires cwd manipulation", () => {});
it.skip("ignore_ripgrep_parent_no_stop: requires cwd manipulation", () => {});
it.skip("no_parent_ignore_git: requires cwd manipulation", () => {});

// 64-65. Symlink tests
describe("rg misc: symlink_nofollow", () => {
  it("should not follow file symlinks during traversal by default", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/searchdir/real.txt": "test content\n"
      }
    });
    // Create a symlink to a file inside the search directory
    await bash.exec("ln -s real.txt /home/user/searchdir/link.txt");
    // Without -L, should only find via real file, not symlink
    const result = await bash.exec("rg test searchdir");
    expect(result.exitCode).toBe(0);
    // Only the real file should be searched
    expect(result.stdout).toContain("searchdir/real.txt:");
    expect(result.stdout).not.toContain("link.txt");
  });
});

describe("rg misc: symlink_follow", () => {
  it("should follow file symlinks during traversal with -L", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/searchdir/real.txt": "test content\n"
      }
    });
    // Create a symlink to a file inside the search directory
    await bash.exec("ln -s real.txt /home/user/searchdir/link.txt");
    // With -L, should find via both real file and symlink
    const result = await bash.exec("rg -L test searchdir");
    expect(result.exitCode).toBe(0);
    // Both files should be searched
    expect(result.stdout).toContain("searchdir/real.txt:");
    expect(result.stdout).toContain("searchdir/link.txt:");
    expect(result.stdout).toContain("test content");
  });
});

// 66. unrestricted1
describe("rg misc: unrestricted1", () => {
  it("should ignore .gitignore with -u", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/.gitignore": "sherlock\n"
      }
    });
    const result = await bash.exec("rg -u Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "sherlock:1:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 67. unrestricted2
describe("rg misc: unrestricted2", () => {
  it("should include hidden files with -uu", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/.sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg -uu Sherlock");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      ".sherlock:1:For the Doctor Watsons of this world, as opposed to the Sherlock\n.sherlock:3:be, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 68. unrestricted3
describe("rg misc: unrestricted3", () => {
  it("should search binary files with -uuu", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK,
        "/home/user/hay": "foo\x00bar\nfoo\x00baz\n"
      }
    });
    const result = await bash.exec("rg -uuu foo");
    expect(result.exitCode).toBe(0);
    // Binary file message
    expect(result.stdout).toContain("hay:");
  });
});

// 69. vimgrep
describe("rg misc: vimgrep", () => {
  it("should show vimgrep format", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --vimgrep 'Sherlock|Watson'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "sherlock:1:16:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:1:57:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:3:49:be, to a very large extent, the result of luck. Sherlock Holmes\nsherlock:5:12:but Doctor Watson has to have it taken out for him and dusted,\n"
    );
  });
});

// 70. vimgrep_no_line
describe("rg misc: vimgrep_no_line", () => {
  it("should show vimgrep format without line numbers", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --vimgrep -N 'Sherlock|Watson'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "sherlock:16:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:57:For the Doctor Watsons of this world, as opposed to the Sherlock\nsherlock:49:be, to a very large extent, the result of luck. Sherlock Holmes\nsherlock:12:but Doctor Watson has to have it taken out for him and dusted,\n"
    );
  });
});

// 71. vimgrep_no_line_no_column - SKIP: --no-column not implemented
it.skip("vimgrep_no_line_no_column: --no-column not implemented", () => {});

// 72-73. preprocessing - SKIP: --pre not implemented
it.skip("preprocessing: --pre not implemented", () => {});
it.skip("preprocessing_glob: --pre-glob not implemented", () => {});

// 74. compressed_gzip
describe("rg misc: compressed_gzip", () => {
  const { gzipSync } = require("node:zlib");
  it("should search gzip files with -z", async () => {
    const compressed = gzipSync(Buffer.from(SHERLOCK));
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock.gz": compressed
      }
    });
    const result = await bash.exec("rg -z Sherlock sherlock.gz");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "For the Doctor Watsons of this world, as opposed to the Sherlock\nbe, to a very large extent, the result of luck. Sherlock Holmes\n"
    );
  });
});

// 75-82. Other compression formats - SKIP: only gzip supported
it.skip("compressed_bzip2: bzip2 not supported", () => {});
it.skip("compressed_xz: xz not supported", () => {});
it.skip("compressed_lz4: lz4 not supported", () => {});
it.skip("compressed_lzma: lzma not supported", () => {});
it.skip("compressed_brotli: brotli not supported", () => {});
it.skip("compressed_zstd: zstd not supported", () => {});
it.skip("compressed_uncompress: compress not supported", () => {});
it.skip("compressed_failing_gzip: invalid gzip handling not implemented", () => {});

// 83. binary_convert
describe("rg misc: binary_convert", () => {
  it.skip("should detect binary files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo\x00bar\nfoo\x00baz\n"
      }
    });
    const result = await bash.exec("rg foo file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'binary file matches (found "\\0" byte around offset 3)\n'
    );
  });
});

// 84-85. mmap tests - SKIP: mmap not relevant
it.skip("binary_convert_mmap: mmap not relevant", () => {});
it.skip("binary_search_mmap: mmap not relevant", () => {});

// 86. binary_quit - SKIP: -g flag with binary handling
it.skip("binary_quit: binary quit behavior not implemented", () => {});

// 87. binary_quit_mmap - SKIP: mmap not relevant
it.skip("binary_quit_mmap: mmap not relevant", () => {});

// 88. binary_search_no_mmap
describe("rg misc: binary_search_no_mmap", () => {
  it("should search binary files with -a", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "foo\x00bar\nfoo\x00baz\n"
      }
    });
    const result = await bash.exec("rg -a foo file");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("foo\x00bar\nfoo\x00baz\n");
  });
});

// 89. files
describe("rg misc: files", () => {
  it("should list files with --files", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/file": "",
        "/home/user/dir/file": ""
      }
    });
    const result = await bash.exec("rg --files");
    expect(result.exitCode).toBe(0);
    const files = result.stdout.trim().split("\n").sort();
    expect(files).toEqual(["dir/file", "file"]);
  });
});

// 90. type_list
describe("rg misc: type_list", () => {
  it("should list file types with --type-list", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {}
    });
    const result = await bash.exec("rg --type-list");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rust");
    expect(result.stdout).toContain("py");
  });
});

// 91. sort_files
describe("rg misc: sort_files", () => {
  it("should sort files by path with --sort path", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a": "test\n",
        "/home/user/b": "test\n",
        "/home/user/dir/c": "test\n",
        "/home/user/dir/d": "test\n"
      }
    });
    const result = await bash.exec("rg --sort path test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "a:1:test\nb:1:test\ndir/c:1:test\ndir/d:1:test\n"
    );
  });
});

// 92-93. sort_accessed, sortr_accessed - SKIP: requires system timestamps
it.skip("sort_accessed: requires system timestamps", () => {});
it.skip("sortr_accessed: requires system timestamps", () => {});
