/**
 * JSON output tests imported from ripgrep
 *
 * Source: https://github.com/BurntSushi/ripgrep/blob/master/tests/json.rs
 *
 * Not implemented (tests not imported):
 * - notutf8, notutf8_file: Non-UTF8 file handling not supported
 * - crlf, r1095_missing_crlf, r1095_crlf_empty_match: --crlf flag not implemented
 * - r1412_look_behind_match_missing: Requires PCRE2 look-behind
 */

import { describe, expect, it } from "vitest";
import { Bash } from "../../../Shell";

const SHERLOCK = `For the Doctor Watsons of this world, as opposed to the Sherlock
Holmeses, success in the province of detective work must always
be, to a very large extent, the result of luck. Sherlock Holmes
can extract a clew from a wisp of straw or a flake of cigar ash;
but Doctor Watson has to have it taken out for him and dusted,
and exhibited clearly, with a label attached.
`;

interface JsonMessage {
  type: "begin" | "end" | "match" | "context" | "summary";
  data: Record<string, unknown>;
}

function parseJsonLines(output: string): JsonMessage[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonMessage);
}

describe("rg json: basic", () => {
  it("basic: JSON output structure", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec("rg --json 'Sherlock Holmes' sherlock");
    expect(result.exitCode).toBe(0);

    const msgs = parseJsonLines(result.stdout);

    // Check begin message
    expect(msgs[0].type).toBe("begin");
    expect(msgs[0].data.path).toEqual({ text: "sherlock" });

    // Check match message
    expect(msgs[1].type).toBe("match");
    expect(msgs[1].data.path).toEqual({ text: "sherlock" });
    expect(msgs[1].data.lines).toEqual({
      text: "be, to a very large extent, the result of luck. Sherlock Holmes\n"
    });
    expect(msgs[1].data.line_number).toBe(3);
    expect(msgs[1].data.absolute_offset).toBe(129);
    const submatches = msgs[1].data.submatches as Array<{
      match: { text: string };
      start: number;
      end: number;
    }>;
    expect(submatches.length).toBe(1);
    expect(submatches[0].match).toEqual({ text: "Sherlock Holmes" });
    expect(submatches[0].start).toBe(48);
    expect(submatches[0].end).toBe(63);

    // Check end message
    expect(msgs[2].type).toBe("end");
    expect(msgs[2].data.path).toEqual({ text: "sherlock" });
    expect(msgs[2].data.binary_offset).toBeNull();

    // Check summary message
    expect(msgs[3].type).toBe("summary");
    const stats = msgs[3].data.stats as { searches_with_match: number };
    expect(stats.searches_with_match).toBe(1);
  });

  it("replacement: JSON output with replacement text", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec(
      "rg --json 'Sherlock Holmes' -r 'John Watson' sherlock"
    );
    expect(result.exitCode).toBe(0);

    const msgs = parseJsonLines(result.stdout);
    expect(msgs[1].type).toBe("match");
    const submatches = msgs[1].data.submatches as Array<{
      match: { text: string };
      replacement: { text: string };
    }>;
    expect(submatches[0].replacement).toEqual({ text: "John Watson" });
  });

  it("quiet_stats: JSON with --quiet shows only summary", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/sherlock": SHERLOCK
      }
    });
    const result = await bash.exec(
      "rg --json --quiet 'Sherlock Holmes' sherlock"
    );
    expect(result.exitCode).toBe(0);
    // ripgrep behavior: --quiet --json outputs only the summary
    const msgs = parseJsonLines(result.stdout);
    expect(msgs.length).toBe(1);
    expect(msgs[0].type).toBe("summary");
    const stats = msgs[0].data.stats as { searches_with_match: number };
    expect(stats.searches_with_match).toBe(1);
  });
});

describe("rg json: multiple matches", () => {
  it("should output all matches with correct submatches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test.txt": "foo bar foo baz foo\n"
      }
    });
    const result = await bash.exec("rg --json foo test.txt");
    expect(result.exitCode).toBe(0);

    const msgs = parseJsonLines(result.stdout);
    const match = msgs.find((m) => m.type === "match");
    expect(match).toBeDefined();

    const submatches = match?.data.submatches as Array<{
      match: { text: string };
      start: number;
      end: number;
    }>;
    expect(submatches.length).toBe(3);
    expect(submatches[0]).toEqual({ match: { text: "foo" }, start: 0, end: 3 });
    expect(submatches[1]).toEqual({
      match: { text: "foo" },
      start: 8,
      end: 11
    });
    expect(submatches[2]).toEqual({
      match: { text: "foo" },
      start: 16,
      end: 19
    });
  });

  it("should output multiple files with begin/end messages", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/a.txt": "hello\n",
        "/home/user/b.txt": "hello\n"
      }
    });
    const result = await bash.exec("rg --json hello");
    expect(result.exitCode).toBe(0);

    const msgs = parseJsonLines(result.stdout);

    // Should have begin/match/end for each file plus summary
    const begins = msgs.filter((m) => m.type === "begin");
    const ends = msgs.filter((m) => m.type === "end");
    const matches = msgs.filter((m) => m.type === "match");
    const summaries = msgs.filter((m) => m.type === "summary");

    expect(begins.length).toBe(2);
    expect(ends.length).toBe(2);
    expect(matches.length).toBe(2);
    expect(summaries.length).toBe(1);
  });
});

// ============================================================================
// SKIPPED TESTS - Features not implemented
// ============================================================================
it.skip("r1412_look_behind_match_missing: PCRE2 look-behind not supported", () => {});

describe("rg json: edge cases", () => {
  it("should output summary even with no matches", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/test.txt": "hello world\n"
      }
    });
    const result = await bash.exec("rg --json notfound");
    expect(result.exitCode).toBe(1);

    // Always outputs summary with stats
    const msgs = parseJsonLines(result.stdout);
    const summary = msgs.find((m) => m.type === "summary");
    expect(summary).toBeDefined();
    const stats = summary?.data.stats as { searches_with_match: number };
    expect(stats.searches_with_match).toBe(0);
  });

  it("should handle empty file with summary", async () => {
    const bash = new Bash({
      cwd: "/home/user",
      files: {
        "/home/user/empty.txt": ""
      }
    });
    const result = await bash.exec("rg --json foo empty.txt");
    expect(result.exitCode).toBe(1);

    const msgs = parseJsonLines(result.stdout);
    const summary = msgs.find((m) => m.type === "summary");
    expect(summary).toBeDefined();
    const stats = summary?.data.stats as {
      searches_with_match: number;
      bytes_searched: number;
    };
    expect(stats.searches_with_match).toBe(0);
    expect(stats.bytes_searched).toBe(0);
  });
});
