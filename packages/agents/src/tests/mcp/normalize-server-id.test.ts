import { describe, it, expect } from "vitest";
import { normalizeServerId, MCP_SERVER_ID_MAX_LENGTH } from "../../mcp/client";

describe("normalizeServerId", () => {
  it("passes already-valid ids through unchanged", () => {
    expect(normalizeServerId("my-supplied-id")).toBe("my-supplied-id");
    expect(normalizeServerId("github")).toBe("github");
    expect(normalizeServerId("slack_v2")).toBe("slack_v2");
    expect(normalizeServerId("a")).toBe("a");
  });

  it("lowercases the input", () => {
    expect(normalizeServerId("GitHub")).toBe("github");
    expect(normalizeServerId("My-Supplied-ID")).toBe("my-supplied-id");
  });

  it("replaces disallowed characters with a single hyphen", () => {
    expect(normalizeServerId("GitHub MCP!")).toBe("github-mcp");
    expect(normalizeServerId("foo/bar.baz")).toBe("foo-bar-baz");
    expect(normalizeServerId("a   b")).toBe("a-b");
    expect(normalizeServerId("a@@@b")).toBe("a-b");
  });

  it("collapses repeated hyphens", () => {
    expect(normalizeServerId("foo---bar")).toBe("foo-bar");
    expect(normalizeServerId("foo - - bar")).toBe("foo-bar");
  });

  it("trims leading and trailing hyphens and underscores", () => {
    expect(normalizeServerId("---github---")).toBe("github");
    expect(normalizeServerId("__slack__")).toBe("slack");
    expect(normalizeServerId("-_foo_-")).toBe("foo");
  });

  it("prefixes with id- when the result doesn't start with a letter", () => {
    expect(normalizeServerId("42-things")).toBe("id-42-things");
    expect(normalizeServerId("123")).toBe("id-123");
    expect(normalizeServerId("_underscore_first")).toBe("underscore_first");
    expect(normalizeServerId("-leading-hyphen")).toBe("leading-hyphen");
  });

  it("prefixes with id- when the input is empty after stripping", () => {
    expect(normalizeServerId("")).toBe("id");
    expect(normalizeServerId("!!!")).toBe("id");
    expect(normalizeServerId("   ")).toBe("id");
  });

  it("truncates to MCP_SERVER_ID_MAX_LENGTH", () => {
    const long = "a".repeat(MCP_SERVER_ID_MAX_LENGTH + 50);
    const out = normalizeServerId(long);
    expect(out.length).toBe(MCP_SERVER_ID_MAX_LENGTH);
    expect(out).toBe("a".repeat(MCP_SERVER_ID_MAX_LENGTH));
  });

  it("does not leave trailing hyphens after truncation", () => {
    // Build an id whose 64th char would be a hyphen
    const input = `${"a".repeat(MCP_SERVER_ID_MAX_LENGTH - 1)}-tail`;
    const out = normalizeServerId(input);
    expect(out.endsWith("-")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(MCP_SERVER_ID_MAX_LENGTH);
  });

  it("normalizes inputs idempotently", () => {
    const samples = [
      "my-supplied-id",
      "GitHub MCP!",
      "42-things",
      "---foo---",
      "!!!",
      "a".repeat(200)
    ];
    for (const s of samples) {
      const once = normalizeServerId(s);
      const twice = normalizeServerId(once);
      expect(twice).toBe(once);
    }
  });

  it("produces ids that match the AI SDK tool-name character set when hyphens are stripped", () => {
    // mcp/client.ts builds tool keys as `tool_${id.replace(/-/g, "")}_${name}`
    // which must match /^[A-Za-z0-9_]+$/.
    const samples = [
      "my-supplied-id",
      "GitHub MCP!",
      "42-things",
      "foo/bar.baz",
      "---weird---",
      "a@@@b"
    ];
    for (const s of samples) {
      const id = normalizeServerId(s);
      const toolKey = `tool_${id.replace(/-/g, "")}_test`;
      expect(toolKey).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it("throws on non-string input", () => {
    expect(() => normalizeServerId(undefined as unknown as string)).toThrow(
      TypeError
    );
    expect(() => normalizeServerId(123 as unknown as string)).toThrow(
      TypeError
    );
  });
});
