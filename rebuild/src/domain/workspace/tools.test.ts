import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { systemClock } from "../../ports/clock.js";
import { createWorkspace, type Workspace } from "./workspace.js";
import { createWorkspaceTools } from "./tools.js";

function makeTools(opts?: Parameters<typeof createWorkspaceTools>[1]) {
  const ws = createWorkspace({ store: createMemoryKeyValueStore(), clock: systemClock });
  const tools = createWorkspaceTools(ws, opts);
  return { ws, tools };
}

const ctx = {
  toolCallId: "call_1",
  requestId: "req_1",
  messages: [],
  signal: new AbortController().signal,
};

async function run(tools: ReturnType<typeof createWorkspaceTools>, name: string, input: unknown) {
  const t = tools[name];
  if (!t?.execute) throw new Error(`no executable tool named ${name}`);
  return t.execute(input, ctx);
}

describe("createWorkspaceTools", () => {
  it("tags every tool with capability=workspace metadata", () => {
    const { tools } = makeTools();
    for (const name of ["read", "write", "edit", "list", "find", "grep", "delete"]) {
      expect(tools[name]?.metadata?.capability).toBe("workspace");
    }
  });

  it("does not expose a bash tool", () => {
    const { tools } = makeTools();
    expect(tools.bash).toBeUndefined();
  });

  describe("read", () => {
    it("returns line-numbered text with the N→content format", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "one\ntwo\nthree");
      const out = await run(tools, "read", { path: "a.txt" });
      expect(out).toBe("1→one\n2→two\n3→three");
    });

    it("windows by offset and limit", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "one\ntwo\nthree\nfour");
      const out = await run(tools, "read", { path: "a.txt", offset: 1, limit: 2 });
      expect(out).toBe("2→two\n3→three");
    });

    it("defaults the window to 2000 lines", async () => {
      const { ws, tools } = makeTools({ maxModelChars: 1_000_000 });
      const lines = Array.from({ length: 2500 }, (_, i) => `l${i}`);
      ws.write("big.txt", lines.join("\n"));
      const out = (await run(tools, "read", { path: "big.txt" })) as string;
      const rendered = out.split("\n");
      expect(rendered).toHaveLength(2000);
      expect(rendered[0]).toBe("1→l0");
      expect(rendered[1999]).toBe("2000→l1999");
    });

    it("returns a compact descriptor for binary content instead of the raw bytes", async () => {
      const { ws, tools } = makeTools();
      ws.write("img.png", "aGVsbG8=", { encoding: "base64", mediaType: "image/png" });
      const out = await run(tools, "read", { path: "img.png" });
      expect(out).toMatchObject({ path: "img.png", mediaType: "image/png" });
      expect((out as { content?: unknown }).content).toBeUndefined();
      expect((out as { note: string }).note).toEqual(expect.any(String));
    });

    it("returns an error value for a missing path instead of throwing", async () => {
      const { tools } = makeTools();
      const out = await run(tools, "read", { path: "missing.txt" });
      expect(out).toEqual({ error: expect.stringContaining("missing.txt") });
    });

    it("returns an error value (not a throw) for path traversal", async () => {
      const { tools } = makeTools();
      const out = await run(tools, "read", { path: "../etc/passwd" });
      expect(out).toHaveProperty("error");
    });
  });

  describe("write", () => {
    it("creates a file and returns path + byte count", async () => {
      const { ws, tools } = makeTools();
      const out = await run(tools, "write", { path: "a.txt", content: "hello" });
      expect(out).toEqual({ path: "a.txt", bytes: 5 });
      expect(ws.read("a.txt")?.content).toBe("hello");
    });

    it("overwrites an existing file", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "old");
      await run(tools, "write", { path: "a.txt", content: "new" });
      expect(ws.read("a.txt")?.content).toBe("new");
    });
  });

  describe("edit", () => {
    it("phrases no_match as 'old_string not found'", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "hello world");
      const out = await run(tools, "edit", { path: "a.txt", old_string: "xyz", new_string: "abc" });
      expect(out).toEqual({ ok: false, error: expect.stringContaining("old_string not found") });
    });

    it("phrases not_unique with the occurrence count", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "foo foo foo");
      const out = await run(tools, "edit", { path: "a.txt", old_string: "foo", new_string: "bar" });
      expect(out).toEqual({
        ok: false,
        error: expect.stringContaining("appears 3 times — provide more context or replace_all"),
      });
    });

    it("edits the unique occurrence", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "foo bar");
      const out = await run(tools, "edit", { path: "a.txt", old_string: "foo", new_string: "baz" });
      expect(out).toEqual({ ok: true });
      expect(ws.read("a.txt")?.content).toBe("baz bar");
    });

    it("replaces all occurrences when replace_all is set", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "foo foo");
      const out = await run(tools, "edit", {
        path: "a.txt",
        old_string: "foo",
        new_string: "bar",
        replace_all: true,
      });
      expect(out).toEqual({ ok: true });
      expect(ws.read("a.txt")?.content).toBe("bar bar");
    });

    it("reports missing files without throwing", async () => {
      const { tools } = makeTools();
      const out = await run(tools, "edit", { path: "missing.txt", old_string: "a", new_string: "b" });
      expect(out).toEqual({ ok: false, error: expect.any(String) });
    });
  });

  describe("list", () => {
    it("lists entries with sizes", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "hi");
      ws.write("dir/b.txt", "hello");
      const out = await run(tools, "list", {});
      expect(out).toBe("a.txt\t2");
    });

    it("lists recursively when requested", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "hi");
      ws.write("dir/b.txt", "hello");
      const out = (await run(tools, "list", { recursive: true })) as string;
      expect(out.split("\n").sort()).toEqual(["a.txt\t2", "dir/b.txt\t5"]);
    });

    it("scopes to a path", async () => {
      const { ws, tools } = makeTools();
      ws.write("dir/b.txt", "hello");
      ws.write("other/c.txt", "x");
      const out = await run(tools, "list", { path: "dir" });
      expect(out).toBe("dir/b.txt\t5");
    });
  });

  describe("find", () => {
    it("matches paths by glob", async () => {
      const { ws, tools } = makeTools();
      ws.write("src/a.ts", "1");
      ws.write("src/b.js", "2");
      const out = await run(tools, "find", { pattern: "src/*.ts" });
      expect(out).toBe("src/a.ts");
    });
  });

  describe("grep", () => {
    it("renders path:line: text rows", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "hello\nworld");
      const out = await run(tools, "grep", { pattern: "hello" });
      expect(out).toBe("a.txt:1: hello");
    });

    it("bounds matches to 100 by default", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", Array.from({ length: 150 }, () => "x").join("\n"));
      const out = (await run(tools, "grep", { pattern: "x" })) as string;
      expect(out.split("\n")).toHaveLength(100);
    });

    it("honors max_matches", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "x\nx\nx\nx");
      const out = (await run(tools, "grep", { pattern: "x", max_matches: 2 })) as string;
      expect(out.split("\n")).toHaveLength(2);
    });

    it("filters by glob", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "target");
      ws.write("b.md", "target");
      const out = await run(tools, "grep", { pattern: "target", glob: "*.txt" });
      expect(out).toBe("a.txt:1: target");
    });

    it("returns an error value for an invalid regex instead of throwing", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "hi");
      const out = await run(tools, "grep", { pattern: "(unclosed" });
      expect(out).toHaveProperty("error");
    });
  });

  describe("delete", () => {
    it("deletes an existing file", async () => {
      const { ws, tools } = makeTools();
      ws.write("a.txt", "1");
      const out = await run(tools, "delete", { path: "a.txt" });
      expect(out).toEqual({ deleted: true });
      expect(ws.exists("a.txt")).toBe(false);
    });

    it("reports false for a missing file", async () => {
      const { tools } = makeTools();
      const out = await run(tools, "delete", { path: "missing.txt" });
      expect(out).toEqual({ deleted: false });
    });
  });

  describe("output truncation", () => {
    it("truncates large text output via truncateForModel", async () => {
      const { ws, tools } = makeTools({ maxModelChars: 50 });
      ws.write("big.txt", Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
      const out = (await run(tools, "read", { path: "big.txt" })) as string;
      expect(out.length).toBeGreaterThan(50);
      expect(out).toContain("…[truncated");
    });
  });

  describe("input validation", () => {
    it("validates tool inputs via zod schemas", () => {
      const { tools } = makeTools();
      expect(() => tools.write?.inputSchema && "parse" in tools.write.inputSchema).toBeTruthy();
      const schema = tools.write?.inputSchema as { parse: (v: unknown) => unknown };
      expect(() => schema.parse({ path: "a.txt" })).toThrow();
      expect(() => schema.parse({ path: "a.txt", content: "x" })).not.toThrow();
    });
  });
});
