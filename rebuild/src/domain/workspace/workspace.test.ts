import { describe, expect, it } from "vitest";
import { createMemoryKeyValueStore } from "../../adapters/memory/store.js";
import { systemClock } from "../../ports/clock.js";
import type { KeyValueStore } from "../../ports/storage.js";
import { createWorkspace, globToRegExp } from "./workspace.js";

function makeWorkspace(store: KeyValueStore = createMemoryKeyValueStore()) {
  return { store, ws: createWorkspace({ store, clock: systemClock }) };
}

describe("createWorkspace", () => {
  describe("path normalization", () => {
    it("accepts paths with and without a leading slash as equivalent", () => {
      const { ws } = makeWorkspace();
      ws.write("/a/b.txt", "hi");
      expect(ws.read("a/b.txt")?.content).toBe("hi");
      expect(ws.exists("/a/b.txt")).toBe(true);
    });

    it("rejects .. traversal", () => {
      const { ws } = makeWorkspace();
      expect(() => ws.write("../etc/passwd", "x")).toThrow();
      expect(() => ws.write("a/../../b", "x")).toThrow();
    });

    it("rejects empty path segments", () => {
      const { ws } = makeWorkspace();
      expect(() => ws.write("a//b", "x")).toThrow();
      expect(() => ws.write("", "x")).toThrow();
    });
  });

  it("round-trips binary content stored as base64", () => {
    const { ws } = makeWorkspace();
    const base64 = "aGVsbG8gYmluYXJ5"; // "hello binary"
    ws.write("img.png", base64, { encoding: "base64", mediaType: "image/png" });
    expect(ws.read("img.png")).toEqual({
      content: base64,
      encoding: "base64",
      mediaType: "image/png",
    });
  });

  it("read returns null for a missing path", () => {
    const { ws } = makeWorkspace();
    expect(ws.read("missing.txt")).toBeNull();
  });

  describe("list", () => {
    it("lists only direct children by default (non-recursive)", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "1");
      ws.write("dir/b.txt", "2");
      ws.write("dir/sub/c.txt", "3");
      expect(ws.list().map((e) => e.path)).toEqual(["a.txt"]);
    });

    it("lists nested files when recursive is true", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "1");
      ws.write("dir/b.txt", "2");
      ws.write("dir/sub/c.txt", "3");
      expect(ws.list(undefined, { recursive: true }).map((e) => e.path)).toEqual([
        "a.txt",
        "dir/b.txt",
        "dir/sub/c.txt",
      ]);
    });

    it("scopes listing to a directory", () => {
      const { ws } = makeWorkspace();
      ws.write("dir/b.txt", "2");
      ws.write("dir/sub/c.txt", "3");
      ws.write("other/d.txt", "4");
      expect(ws.list("dir", { recursive: true }).map((e) => e.path)).toEqual([
        "dir/b.txt",
        "dir/sub/c.txt",
      ]);
      expect(ws.list("dir").map((e) => e.path)).toEqual(["dir/b.txt"]);
    });
  });

  describe("find", () => {
    it("matches ** and * glob patterns across paths", () => {
      const { ws } = makeWorkspace();
      ws.write("src/a.ts", "1");
      ws.write("src/b.js", "2");
      ws.write("src/nested/c.ts", "3");
      ws.write("readme.md", "4");
      expect(ws.find("**/*.ts").sort()).toEqual(["src/a.ts", "src/nested/c.ts"]);
      expect(ws.find("src/*.ts")).toEqual(["src/a.ts"]);
    });
  });

  describe("grep", () => {
    it("returns line numbers and matched text", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "hello\nworld\nhello again");
      expect(ws.grep("hello")).toEqual([
        { path: "a.txt", line: 1, text: "hello" },
        { path: "a.txt", line: 3, text: "hello again" },
      ]);
    });

    it("filters by glob", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "target");
      ws.write("b.md", "target");
      expect(ws.grep("target", { glob: "*.txt" }).map((r) => r.path)).toEqual(["a.txt"]);
    });

    it("bounds results with maxMatches", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "x\nx\nx\nx");
      expect(ws.grep("x", { maxMatches: 2 })).toHaveLength(2);
    });
  });

  describe("edit", () => {
    it("returns not_found for a missing path", () => {
      const { ws } = makeWorkspace();
      expect(ws.edit("missing.txt", "a", "b")).toEqual({ ok: false, reason: "not_found" });
    });

    it("returns no_match when oldString is absent", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "hello world");
      expect(ws.edit("a.txt", "xyz", "abc")).toEqual({ ok: false, reason: "no_match" });
    });

    it("returns not_unique for 2+ occurrences without replaceAll", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "foo foo");
      expect(ws.edit("a.txt", "foo", "bar")).toEqual({ ok: false, reason: "not_unique" });
    });

    it("replaces the single occurrence", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "foo bar");
      expect(ws.edit("a.txt", "foo", "baz")).toEqual({ ok: true });
      expect(ws.read("a.txt")?.content).toBe("baz bar");
    });

    it("replaces all occurrences with replaceAll", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "foo foo foo");
      expect(ws.edit("a.txt", "foo", "bar", { replaceAll: true })).toEqual({ ok: true });
      expect(ws.read("a.txt")?.content).toBe("bar bar bar");
    });
  });

  it("persists across workspace instances sharing the same store", () => {
    const store = createMemoryKeyValueStore();
    const ws1 = createWorkspace({ store, clock: systemClock });
    ws1.write("a.txt", "persisted");
    const ws2 = createWorkspace({ store, clock: systemClock });
    expect(ws2.read("a.txt")?.content).toBe("persisted");
  });

  describe("delete", () => {
    it("deletes a file and reports whether it existed", () => {
      const { ws } = makeWorkspace();
      ws.write("a.txt", "1");
      expect(ws.delete("a.txt")).toBe(true);
      expect(ws.delete("a.txt")).toBe(false);
      expect(ws.exists("a.txt")).toBe(false);
    });

    it("deletes everything under a directory", () => {
      const { ws } = makeWorkspace();
      ws.write("dir/a.txt", "1");
      ws.write("dir/b.txt", "2");
      expect(ws.delete("dir")).toBe(true);
      expect(ws.exists("dir/a.txt")).toBe(false);
      expect(ws.exists("dir/b.txt")).toBe(false);
    });
  });

  it("sums stored file sizes in totalBytes", () => {
    const { ws } = makeWorkspace();
    ws.write("a.txt", "hi"); // 2 bytes
    ws.write("b.txt", "hello"); // 5 bytes
    expect(ws.totalBytes()).toBe(7);
  });
});

describe("globToRegExp", () => {
  it("matches ** across path separators", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a/b/c.ts")).toBe(true);
    expect(re.test("a/b/c.js")).toBe(false);
  });

  it("matches * within a single path segment only", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/nested/a.ts")).toBe(false);
  });

  it("escapes regex special characters in literal segments", () => {
    const re = globToRegExp("a.b+c");
    expect(re.test("a.b+c")).toBe(true);
    expect(re.test("aXb+c")).toBe(false);
  });
});
