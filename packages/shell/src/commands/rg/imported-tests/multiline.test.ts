/**
 * Multiline tests imported from ripgrep
 *
 * Source: https://github.com/BurntSushi/ripgrep/blob/master/tests/multiline.rs
 *
 * Note: Tests using \p{Any} Unicode property or --multiline-dotall are skipped
 * as JavaScript regex doesn't support Unicode properties and we don't implement
 * --multiline-dotall.
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../../Shell";

describe("rg multiline: basic overlapping matches", () => {
  // This tests that multiline matches that span multiple lines, but where
  // multiple matches may begin and end on the same line work correctly.
  it("overlap1: multiline matches spanning lines", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "xxx\nabc\ndefxxxabc\ndefxxx\nxxx"
      }
    });
    const result = await bash.exec("rg -n -U 'abc\\ndef' test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2:abc\n3:defxxxabc\n4:defxxx\n");
  });

  // Like overlap1, but tests the case where one match ends at precisely the same
  // location at which the next match begins.
  it("overlap2: adjacent multiline matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "xxx\nabc\ndefabc\ndefxxx\nxxx"
      }
    });
    const result = await bash.exec("rg -n -U 'abc\\ndef' test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("2:abc\n3:defabc\n4:defxxx\n");
  });
});

describe("rg multiline: dot behavior", () => {
  const SHERLOCK = `For the Doctor Watsons of this world, as opposed to the Sherlock
Holmeses, success in the province of detective work must always
be, to a very large extent, the result of luck. Sherlock Holmes
can extract a clew from a wisp of straw or a flake of cigar ash;
but Doctor Watson has to have it taken out for him and dusted,
and exhibited clearly, with a label attached.
`;

  // Tests that even in a multiline search, a '.' does not match a newline.
  it("dot_no_newline: dot does not match newline in multiline mode", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    // Pattern tries to match "of this world" followed by any chars and "detective work"
    // With standard multiline (no dotall), . doesn't match \n, so this should fail
    const result = await bash.exec(
      "rg -n -U 'of this world.+detective work' sherlock"
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  // NOTE: dot_all test is skipped - requires --multiline-dotall flag which is not implemented
});

// NOTE: The following tests from multiline.rs are skipped because they use
// \p{Any} which is a Unicode property not supported in JavaScript regex:
// - only_matching
// - vimgrep
// - stdin
// - context

// ============================================================================
// SKIPPED TESTS - Features not implemented
// ============================================================================

// Requires --multiline-dotall flag
describe("rg multiline: dot_all", () => {
  it("should make dot match newlines with --multiline-dotall", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test": "foo\nbar\n"
      }
    });
    const result = await bash.exec("rg --multiline-dotall 'foo.bar' test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("foo");
  });
});

// Uses \p{Any} Unicode property not supported in JavaScript
it.skip("only_matching: \\p{Any} Unicode property not supported", () => {});
it.skip("vimgrep: \\p{Any} Unicode property not supported", () => {});
it.skip("context: \\p{Any} Unicode property not supported", () => {});

// Requires stdin piping
it.skip("stdin: stdin piping not supported", () => {});
