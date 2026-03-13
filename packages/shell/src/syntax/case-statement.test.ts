import { describe, expect, it } from "vitest";
import { Bash } from "../Shell";

describe("Case Statement", () => {
  it("should match exact pattern", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case hello in
        hello) echo "matched hello";;
        world) echo "matched world";;
      esac
    `);
    expect(result.stdout).toBe("matched hello\n");
    expect(result.exitCode).toBe(0);
  });

  it("should match wildcard pattern", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "anything" in
        specific) echo "specific";;
        *) echo "wildcard";;
      esac
    `);
    expect(result.stdout).toBe("wildcard\n");
    expect(result.exitCode).toBe(0);
  });

  it("should match glob patterns", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "hello.txt" in
        *.txt) echo "text file";;
        *.md) echo "markdown file";;
        *) echo "other";;
      esac
    `);
    expect(result.stdout).toBe("text file\n");
    expect(result.exitCode).toBe(0);
  });

  it("should match multiple patterns with |", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "yes" in
        y|yes|Y|YES) echo "confirmed";;
        n|no|N|NO) echo "denied";;
        *) echo "unknown";;
      esac
    `);
    expect(result.stdout).toBe("confirmed\n");
    expect(result.exitCode).toBe(0);
  });

  it("should work with variables", async () => {
    const env = new Bash({ env: { FRUIT: "apple" } });
    const result = await env.exec(`
      case $FRUIT in
        apple) echo "It's an apple";;
        orange) echo "It's an orange";;
        *) echo "Unknown fruit";;
      esac
    `);
    expect(result.stdout).toBe("It's an apple\n");
    expect(result.exitCode).toBe(0);
  });

  it("should execute only first matching branch", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "test" in
        test) echo "first";;
        test) echo "second";;
        *) echo "wildcard";;
      esac
    `);
    expect(result.stdout).toBe("first\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle no match (empty output)", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "nomatch" in
        a) echo "a";;
        b) echo "b";;
      esac
    `);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("should handle single-line case", async () => {
    const env = new Bash();
    const result = await env.exec(
      'case "x" in x) echo "X";; y) echo "Y";; esac'
    );
    expect(result.stdout).toBe("X\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle question mark wildcard", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "abc" in
        a?c) echo "matches";;
        *) echo "no match";;
      esac
    `);
    expect(result.stdout).toBe("matches\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle character class", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "b" in
        [abc]) echo "a, b, or c";;
        [xyz]) echo "x, y, or z";;
        *) echo "other";;
      esac
    `);
    expect(result.stdout).toBe("a, b, or c\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle pattern with prefix wildcard", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "myfile.bak" in
        *.bak) echo "backup file";;
        *) echo "regular file";;
      esac
    `);
    expect(result.stdout).toBe("backup file\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle multiple commands in branch", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "multi" in
        multi)
          echo "first"
          echo "second"
          ;;
        *) echo "default";;
      esac
    `);
    expect(result.stdout).toBe("first\nsecond\n");
    expect(result.exitCode).toBe(0);
  });

  it("should work with command substitution in case word", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case $(echo test) in
        test) echo "matched";;
        *) echo "no match";;
      esac
    `);
    expect(result.stdout).toBe("matched\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle last branch without ;;", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "default" in
        a) echo "a";;
        *) echo "fallback"
      esac
    `);
    expect(result.stdout).toBe("fallback\n");
    expect(result.exitCode).toBe(0);
  });

  it("should match numbers", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "42" in
        [0-9]) echo "single digit";;
        [0-9][0-9]) echo "double digit";;
        *) echo "other";;
      esac
    `);
    expect(result.stdout).toBe("double digit\n");
    expect(result.exitCode).toBe(0);
  });

  it("should handle optional opening paren", async () => {
    const env = new Bash();
    const result = await env.exec(`
      case "test" in
        (test) echo "with paren";;
        other) echo "no match";;
      esac
    `);
    expect(result.stdout).toBe("with paren\n");
    expect(result.exitCode).toBe(0);
  });
});
