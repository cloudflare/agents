import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "./worker";
import { getAgentByName } from "agents";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

async function freshAgent(name: string) {
  return getAgentByName(env.TestAssistantToolsAgent, name);
}

// ── Read tool ─────────────────────────────────────────────────────────

describe("assistant tools — read", () => {
  it("reads a file with line numbers", async () => {
    const agent = await freshAgent("read-basic");
    await agent.seed([{ path: "/hello.txt", content: "line1\nline2\nline3" }]);
    const result = (await agent.toolRead("/hello.txt")) as {
      path: string;
      content: string;
      totalLines: number;
    };
    expect(result.path).toBe("/hello.txt");
    expect(result.totalLines).toBe(3);
    expect(result.content).toContain("1\tline1");
    expect(result.content).toContain("2\tline2");
    expect(result.content).toContain("3\tline3");
  });

  it("returns error for missing file", async () => {
    const agent = await freshAgent("read-missing");
    const result = (await agent.toolRead("/nope.txt")) as { error: string };
    expect(result.error).toContain("File not found");
  });

  it("returns error for directory", async () => {
    const agent = await freshAgent("read-dir");
    await agent.seedDir("/mydir");
    const result = (await agent.toolRead("/mydir")) as { error: string };
    expect(result.error).toContain("directory");
  });

  it("supports offset and limit", async () => {
    const agent = await freshAgent("read-offset");
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join(
      "\n"
    );
    await agent.seed([{ path: "/big.txt", content: lines }]);
    const result = (await agent.toolRead("/big.txt", 3, 2)) as {
      content: string;
      fromLine: number;
      toLine: number;
    };
    expect(result.fromLine).toBe(3);
    expect(result.toLine).toBe(4);
    expect(result.content).toContain("3\tline3");
    expect(result.content).toContain("4\tline4");
    expect(result.content).not.toContain("2\tline2");
    expect(result.content).not.toContain("5\tline5");
  });
});

// ── Write tool ────────────────────────────────────────────────────────

describe("assistant tools — write", () => {
  it("writes a file and reports stats", async () => {
    const agent = await freshAgent("write-basic");
    const result = (await agent.toolWrite("/out.txt", "hello world")) as {
      path: string;
      bytesWritten: number;
      lines: number;
    };
    expect(result.path).toBe("/out.txt");
    expect(result.bytesWritten).toBe(11);
    expect(result.lines).toBe(1);

    // Verify via read
    const readResult = (await agent.toolRead("/out.txt")) as {
      content: string;
    };
    expect(readResult.content).toContain("hello world");
  });

  it("creates parent directories", async () => {
    const agent = await freshAgent("write-mkdir");
    await agent.toolWrite("/a/b/c/deep.txt", "deep");
    const result = (await agent.toolRead("/a/b/c/deep.txt")) as {
      content: string;
    };
    expect(result.content).toContain("deep");
  });
});

// ── Edit tool ─────────────────────────────────────────────────────────

describe("assistant tools — edit", () => {
  it("replaces exact match", async () => {
    const agent = await freshAgent("edit-exact");
    await agent.seed([{ path: "/f.txt", content: "hello world" }]);
    const result = (await agent.toolEdit("/f.txt", "hello", "goodbye")) as {
      replaced: boolean;
    };
    expect(result.replaced).toBe(true);

    const read = (await agent.toolRead("/f.txt")) as { content: string };
    expect(read.content).toContain("goodbye world");
  });

  it("returns error for missing file", async () => {
    const agent = await freshAgent("edit-missing");
    const result = (await agent.toolEdit("/nope.txt", "a", "b")) as {
      error: string;
    };
    expect(result.error).toContain("File not found");
  });

  it("returns error when old_string not found", async () => {
    const agent = await freshAgent("edit-not-found");
    await agent.seed([{ path: "/f.txt", content: "hello" }]);
    const result = (await agent.toolEdit("/f.txt", "xyz", "abc")) as {
      error: string;
    };
    expect(result.error).toContain("not found");
  });

  it("returns error when old_string has multiple matches", async () => {
    const agent = await freshAgent("edit-multiple");
    await agent.seed([{ path: "/f.txt", content: "aa bb aa" }]);
    const result = (await agent.toolEdit("/f.txt", "aa", "cc")) as {
      error: string;
    };
    expect(result.error).toContain("2 times");
  });

  it("creates new file with empty old_string", async () => {
    const agent = await freshAgent("edit-create");
    const result = (await agent.toolEdit("/new.txt", "", "new content")) as {
      created: boolean;
    };
    expect(result.created).toBe(true);

    const read = (await agent.toolRead("/new.txt")) as { content: string };
    expect(read.content).toContain("new content");
  });

  it("fuzzy matches on whitespace differences", async () => {
    const agent = await freshAgent("edit-fuzzy");
    await agent.seed([{ path: "/f.txt", content: "hello   world" }]);
    const result = (await agent.toolEdit(
      "/f.txt",
      "hello world",
      "goodbye world"
    )) as { replaced: boolean; fuzzyMatch: boolean };
    expect(result.replaced).toBe(true);
    expect(result.fuzzyMatch).toBe(true);

    const read = (await agent.toolRead("/f.txt")) as { content: string };
    expect(read.content).toContain("goodbye world");
  });
});

// ── List tool ─────────────────────────────────────────────────────────

describe("assistant tools — list", () => {
  it("lists files and directories", async () => {
    const agent = await freshAgent("list-basic");
    await agent.seed([
      { path: "/readme.md", content: "# Hello" },
      { path: "/src/index.ts", content: "export {}" }
    ]);
    const result = (await agent.toolList("/")) as {
      count: number;
      entries: string[];
    };
    expect(result.count).toBeGreaterThanOrEqual(2);
    expect(result.entries.some((e: string) => e.includes("readme.md"))).toBe(
      true
    );
    expect(result.entries.some((e: string) => e.includes("src/"))).toBe(true);
  });
});

// ── Find tool ─────────────────────────────────────────────────────────

describe("assistant tools — find", () => {
  it("finds files by glob pattern", async () => {
    const agent = await freshAgent("find-basic");
    await agent.seed([
      { path: "/src/a.ts", content: "a" },
      { path: "/src/b.ts", content: "b" },
      { path: "/src/c.js", content: "c" },
      { path: "/readme.md", content: "# Hi" }
    ]);
    const result = (await agent.toolFind("/src/**/*.ts")) as {
      count: number;
      files: string[];
    };
    expect(result.count).toBe(2);
    expect(result.files).toContain("/src/a.ts");
    expect(result.files).toContain("/src/b.ts");
  });
});

// ── Grep tool ─────────────────────────────────────────────────────────

describe("assistant tools — grep", () => {
  it("searches file contents with regex", async () => {
    const agent = await freshAgent("grep-regex");
    await agent.seed([
      { path: "/a.ts", content: "const foo = 1;\nconst bar = 2;" },
      { path: "/b.ts", content: "let baz = 3;" }
    ]);
    const result = (await agent.toolGrep("const", "/**.ts")) as {
      totalMatches: number;
      filesWithMatches: number;
    };
    expect(result.totalMatches).toBe(2);
    expect(result.filesWithMatches).toBe(1);
  });

  it("searches with fixed string", async () => {
    const agent = await freshAgent("grep-fixed");
    await agent.seed([
      { path: "/a.txt", content: "hello (world)" },
      { path: "/b.txt", content: "no match" }
    ]);
    const result = (await agent.toolGrep("(world)", "/**.txt", true)) as {
      totalMatches: number;
    };
    expect(result.totalMatches).toBe(1);
  });

  it("supports case-sensitive search", async () => {
    const agent = await freshAgent("grep-case");
    await agent.seed([{ path: "/a.txt", content: "Hello\nhello\nHELLO" }]);
    const insensitive = (await agent.toolGrep(
      "hello",
      "/**.txt",
      true,
      false
    )) as { totalMatches: number };
    expect(insensitive.totalMatches).toBe(3);

    const sensitive = (await agent.toolGrep(
      "hello",
      "/**.txt",
      true,
      true
    )) as { totalMatches: number };
    expect(sensitive.totalMatches).toBe(1);
  });

  it("returns context lines when requested", async () => {
    const agent = await freshAgent("grep-context");
    await agent.seed([
      { path: "/a.txt", content: "line1\nline2\nMATCH\nline4\nline5" }
    ]);
    const result = (await agent.toolGrep(
      "MATCH",
      "/**.txt",
      true,
      true,
      1
    )) as { matches: Array<{ context: string }> };
    expect(result.matches.length).toBe(1);
    const ctx = result.matches[0].context;
    expect(ctx).toContain("line2");
    expect(ctx).toContain("MATCH");
    expect(ctx).toContain("line4");
  });
});
