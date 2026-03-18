import { InMemoryFs } from "../fs/in-memory-fs";
import { describe, expect, it } from "vitest";
import { createMemoryStateBackend } from "../memory";
import { StateBatchOperationError } from "../index";

describe("MemoryStateBackend", () => {
  it("reads, writes, and appends text content", async () => {
    const backend = createMemoryStateBackend();

    await backend.writeFile("/notes/todo.txt", "hello");
    await backend.appendFile("/notes/todo.txt", "\nworld");

    await expect(backend.readFile("/notes/todo.txt")).resolves.toBe(
      "hello\nworld"
    );
  });

  it("reads and writes JSON content", async () => {
    const backend = createMemoryStateBackend();

    await backend.writeJson("/config.json", {
      name: "demo",
      flags: ["a", "b"]
    });

    await expect(backend.readJson("/config.json")).resolves.toEqual({
      name: "demo",
      flags: ["a", "b"]
    });
    await expect(backend.readFile("/config.json")).resolves.toBe(
      '{\n  "name": "demo",\n  "flags": [\n    "a",\n    "b"\n  ]\n}\n'
    );
  });

  it("throws a helpful error for invalid JSON", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/broken.json": "{ nope"
      }
    });

    await expect(backend.readJson("/broken.json")).rejects.toThrow(
      "Invalid JSON in /broken.json"
    );
  });

  it("supports host-side globbing and unified diffs", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": "export const a = 1;\n",
        "/src/b.ts": "export const b = 2;\n"
      }
    });

    await expect(backend.glob("/src/*.ts")).resolves.toEqual([
      "/src/a.ts",
      "/src/b.ts"
    ]);

    const diff = await backend.diffContent(
      "/src/a.ts",
      "export const a = 3;\n"
    );
    expect(diff).toContain("--- /src/a.ts");
    expect(diff).toContain("+++ /src/a.ts");
    expect(diff).toContain("-export const a = 1;");
    expect(diff).toContain("+export const a = 3;");
  });

  it("supports text search with plain text, regex, and word boundaries", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/notes.txt": "foo food\nFoo foo42\nfoo\n"
      }
    });

    await expect(backend.searchText("/notes.txt", "foo")).resolves.toEqual([
      { line: 1, column: 1, match: "foo", lineText: "foo food" },
      { line: 1, column: 5, match: "foo", lineText: "foo food" },
      { line: 2, column: 5, match: "foo", lineText: "Foo foo42" },
      { line: 3, column: 1, match: "foo", lineText: "foo" }
    ]);

    await expect(
      backend.searchText("/notes.txt", "foo", { caseSensitive: false })
    ).resolves.toEqual([
      { line: 1, column: 1, match: "foo", lineText: "foo food" },
      { line: 1, column: 5, match: "foo", lineText: "foo food" },
      { line: 2, column: 1, match: "Foo", lineText: "Foo foo42" },
      { line: 2, column: 5, match: "foo", lineText: "Foo foo42" },
      { line: 3, column: 1, match: "foo", lineText: "foo" }
    ]);

    await expect(
      backend.searchText("/notes.txt", "foo", { wholeWord: true })
    ).resolves.toEqual([
      { line: 1, column: 1, match: "foo", lineText: "foo food" },
      { line: 3, column: 1, match: "foo", lineText: "foo" }
    ]);

    await expect(
      backend.searchText("/notes.txt", "foo\\d+", { regex: true })
    ).resolves.toEqual([
      { line: 2, column: 5, match: "foo42", lineText: "Foo foo42" }
    ]);
  });

  it("supports richer search context and max match limits", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/search.txt": "zero\none foo\ntwo\nthree foo\nfour\n"
      }
    });

    await expect(
      backend.searchText("/search.txt", "foo", {
        contextBefore: 1,
        contextAfter: 1,
        maxMatches: 1
      })
    ).resolves.toEqual([
      {
        line: 2,
        column: 5,
        match: "foo",
        lineText: "one foo",
        beforeLines: ["zero"],
        afterLines: ["two"]
      }
    ]);
  });

  it("supports structured file discovery via find", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": "a",
        "/src/nested/b.ts": "bb",
        "/src/nested/c.txt": "ccc",
        "/empty.txt": ""
      }
    });

    await expect(
      backend.find("/src", { type: "file", pathPattern: "/src/**/*.ts" })
    ).resolves.toEqual([
      {
        path: "/src/a.ts",
        name: "a.ts",
        type: "file",
        depth: 1,
        size: 1,
        mtime: expect.any(Date)
      },
      {
        path: "/src/nested/b.ts",
        name: "b.ts",
        type: "file",
        depth: 2,
        size: 2,
        mtime: expect.any(Date)
      }
    ]);

    await expect(
      backend.find("/", { empty: true, type: "file" })
    ).resolves.toEqual([
      {
        path: "/empty.txt",
        name: "empty.txt",
        type: "file",
        depth: 1,
        size: 0,
        mtime: expect.any(Date)
      }
    ]);
  });

  it("supports JSON query and update operations", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/config.json": '{ "app": { "name": "demo", "flags": ["a", "b"] } }\n'
      }
    });

    await expect(
      backend.queryJson("/config.json", ".app.flags[1]")
    ).resolves.toBe("b");

    const updated = await backend.updateJson("/config.json", [
      { op: "set", path: ".app.name", value: "demo-2" },
      { op: "set", path: ".app.flags[2]", value: "c" },
      { op: "delete", path: ".app.flags[0]" }
    ]);

    expect(updated.operationsApplied).toBe(3);
    expect(updated.value).toEqual({
      app: { name: "demo-2", flags: ["b", "c"] }
    });
    await expect(backend.readJson("/config.json")).resolves.toEqual({
      app: { name: "demo-2", flags: ["b", "c"] }
    });
  });

  it("supports in-file replacement without touching unmatched content", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/replace.txt": "foo food foo\n"
      }
    });

    await expect(
      backend.replaceInFile("/replace.txt", "foo", "bar", {
        wholeWord: true
      })
    ).resolves.toEqual({
      replaced: 2,
      content: "bar food bar\n"
    });

    await expect(backend.readFile("/replace.txt")).resolves.toBe(
      "bar food bar\n"
    );
  });

  it("supports multi-file search across glob matches", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const alpha = "foo";\n',
        "/src/b.ts": 'export const beta = "bar";\n',
        "/src/c.ts": 'export const gamma = "foo";\n'
      }
    });

    await expect(backend.searchFiles("/src/*.ts", "foo")).resolves.toEqual([
      {
        path: "/src/a.ts",
        matches: [
          {
            line: 1,
            column: 23,
            match: "foo",
            lineText: 'export const alpha = "foo";'
          }
        ]
      },
      {
        path: "/src/c.ts",
        matches: [
          {
            line: 1,
            column: 23,
            match: "foo",
            lineText: 'export const gamma = "foo";'
          }
        ]
      }
    ]);
  });

  it("supports multi-file replacement with dry-run previews", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const alpha = "foo";\n',
        "/src/b.ts": 'export const beta = "foo";\n'
      }
    });

    const preview = await backend.replaceInFiles("/src/*.ts", "foo", "bar", {
      dryRun: true
    });

    expect(preview).toEqual({
      dryRun: true,
      files: [
        {
          path: "/src/a.ts",
          replaced: 1,
          content: 'export const alpha = "bar";\n',
          diff: '--- /src/a.ts\n+++ /src/a.ts\n@@ -1,2 +1,2 @@\n-export const alpha = "foo";\n+export const alpha = "bar";\n '
        },
        {
          path: "/src/b.ts",
          replaced: 1,
          content: 'export const beta = "bar";\n',
          diff: '--- /src/b.ts\n+++ /src/b.ts\n@@ -1,2 +1,2 @@\n-export const beta = "foo";\n+export const beta = "bar";\n '
        }
      ],
      totalFiles: 2,
      totalReplacements: 2
    });

    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const alpha = "foo";\n'
    );
  });

  it("applies multi-file replacements when not in dry-run mode", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const alpha = "foo";\n',
        "/src/b.ts": 'export const beta = "foo";\n',
        "/src/c.ts": 'export const gamma = "nope";\n'
      }
    });

    const result = await backend.replaceInFiles("/src/*.ts", "foo", "bar");

    expect(result.totalFiles).toBe(2);
    expect(result.totalReplacements).toBe(2);
    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const alpha = "bar";\n'
    );
    await expect(backend.readFile("/src/b.ts")).resolves.toBe(
      'export const beta = "bar";\n'
    );
    await expect(backend.readFile("/src/c.ts")).resolves.toBe(
      'export const gamma = "nope";\n'
    );
  });

  it("applies batches of edits with dry-run and no-op tracking", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": "a\n",
        "/src/b.ts": "b\n"
      }
    });

    const preview = await backend.applyEdits(
      [
        { path: "/src/a.ts", content: "aa\n" },
        { path: "/src/b.ts", content: "b\n" },
        { path: "/src/c.ts", content: "c\n" }
      ],
      { dryRun: true }
    );

    expect(preview.totalChanged).toBe(2);
    expect(preview.edits[0].changed).toBe(true);
    expect(preview.edits[1].changed).toBe(false);
    expect(preview.edits[2].changed).toBe(true);
    await expect(backend.exists("/src/c.ts")).resolves.toBe(false);

    const applied = await backend.applyEdits([
      { path: "/src/a.ts", content: "aa\n" },
      { path: "/src/b.ts", content: "b\n" },
      { path: "/src/c.ts", content: "c\n" }
    ]);

    expect(applied.totalChanged).toBe(2);
    await expect(backend.readFile("/src/a.ts")).resolves.toBe("aa\n");
    await expect(backend.readFile("/src/b.ts")).resolves.toBe("b\n");
    await expect(backend.readFile("/src/c.ts")).resolves.toBe("c\n");
  });

  it("plans structured edits by intent and applies the resulting plan", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const a = "foo";\n',
        "/src/data.json": '{ "count": 1 }\n'
      }
    });

    const plan = await backend.planEdits([
      {
        kind: "replace",
        path: "/src/a.ts",
        search: "foo",
        replacement: "bar"
      },
      {
        kind: "writeJson",
        path: "/src/data.json",
        value: { count: 2 }
      },
      {
        kind: "write",
        path: "/src/new.ts",
        content: "export const created = true;\n"
      }
    ]);

    expect(plan.totalInstructions).toBe(3);
    expect(plan.totalChanged).toBe(3);
    expect(plan.edits[0]).toEqual({
      instruction: {
        kind: "replace",
        path: "/src/a.ts",
        search: "foo",
        replacement: "bar"
      },
      path: "/src/a.ts",
      changed: true,
      content: 'export const a = "bar";\n',
      diff: expect.stringContaining("--- /src/a.ts")
    });
    expect(plan.edits[1]).toEqual({
      instruction: {
        kind: "writeJson",
        path: "/src/data.json",
        value: { count: 2 }
      },
      path: "/src/data.json",
      changed: true,
      content: '{\n  "count": 2\n}\n',
      diff: expect.stringContaining("--- /src/data.json")
    });
    expect(plan.edits[2]).toEqual({
      instruction: {
        kind: "write",
        path: "/src/new.ts",
        content: "export const created = true;\n"
      },
      path: "/src/new.ts",
      changed: true,
      content: "export const created = true;\n",
      diff: expect.stringContaining("--- /src/new.ts")
    });

    await expect(
      backend.applyEditPlan(plan, { dryRun: true })
    ).resolves.toMatchObject({
      dryRun: true,
      totalChanged: 3
    });
    await expect(backend.exists("/src/new.ts")).resolves.toBe(false);

    const applied = await backend.applyEditPlan(plan);
    expect(applied.totalChanged).toBe(3);
    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const a = "bar";\n'
    );
    await expect(backend.readFile("/src/data.json")).resolves.toBe(
      '{\n  "count": 2\n}\n'
    );
    await expect(backend.readFile("/src/new.ts")).resolves.toBe(
      "export const created = true;\n"
    );
  });

  it("fails planning when a replace instruction targets a missing file", async () => {
    const backend = createMemoryStateBackend();

    await expect(
      backend.planEdits([
        {
          kind: "replace",
          path: "/src/missing.ts",
          search: "foo",
          replacement: "bar"
        }
      ])
    ).rejects.toThrow("ENOENT: no such file: /src/missing.ts");
  });

  it("rolls back multi-file replacements when a later write fails", async () => {
    const backend = createMemoryStateBackend({
      fs: new FailingWriteFs(
        new InMemoryFs({
          "/src/a.ts": 'export const alpha = "foo";\n',
          "/src/b.ts": 'export const beta = "foo";\n'
        }),
        "/src/b.ts"
      )
    });

    await expect(
      backend.replaceInFiles("/src/*.ts", "foo", "bar")
    ).rejects.toMatchObject({
      name: "StateBatchOperationError",
      operation: "replaceInFiles",
      rolledBack: true
    } satisfies Partial<StateBatchOperationError>);

    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const alpha = "foo";\n'
    );
    await expect(backend.readFile("/src/b.ts")).resolves.toBe(
      'export const beta = "foo";\n'
    );
  });

  it("can leave partial writes in place when rollback is disabled", async () => {
    const backend = createMemoryStateBackend({
      fs: new FailingWriteFs(
        new InMemoryFs({
          "/src/a.ts": 'export const alpha = "foo";\n',
          "/src/b.ts": 'export const beta = "foo";\n'
        }),
        "/src/b.ts"
      )
    });

    await expect(
      backend.replaceInFiles("/src/*.ts", "foo", "bar", {
        rollbackOnError: false
      })
    ).rejects.toMatchObject({
      name: "StateBatchOperationError",
      operation: "replaceInFiles",
      rolledBack: false
    } satisfies Partial<StateBatchOperationError>);

    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const alpha = "bar";\n'
    );
    await expect(backend.readFile("/src/b.ts")).resolves.toBe(
      'export const beta = "foo";\n'
    );
  });

  it("rolls back applied edits when a later edit write fails", async () => {
    const backend = createMemoryStateBackend({
      fs: new FailingWriteFs(
        new InMemoryFs({
          "/src/a.ts": "a\n",
          "/src/b.ts": "b\n"
        }),
        "/src/b.ts"
      )
    });

    await expect(
      backend.applyEdits([
        { path: "/src/a.ts", content: "aa\n" },
        { path: "/src/b.ts", content: "bb\n" },
        { path: "/src/c.ts", content: "cc\n" }
      ])
    ).rejects.toMatchObject({
      name: "StateBatchOperationError",
      operation: "applyEdits",
      rolledBack: true
    } satisfies Partial<StateBatchOperationError>);

    await expect(backend.readFile("/src/a.ts")).resolves.toBe("a\n");
    await expect(backend.readFile("/src/b.ts")).resolves.toBe("b\n");
    await expect(backend.exists("/src/c.ts")).resolves.toBe(false);
  });

  it("supports recursive copy and move helpers", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/project/src/index.ts": "export const value = 1;\n"
      }
    });

    await backend.copyTree("/project", "/project-copy");
    await backend.moveTree("/project-copy", "/archive/project-copy");

    await expect(
      backend.readFile("/archive/project-copy/src/index.ts")
    ).resolves.toBe("export const value = 1;\n");
    await expect(backend.exists("/project-copy")).resolves.toBe(false);
  });

  it("supports tree walking and directory summaries", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/tree/a.txt": "a",
        "/tree/nested/b.txt": "bb",
        "/tree/nested/deeper/c.txt": "ccc"
      }
    });

    const tree = await backend.walkTree("/tree", { maxDepth: 2 });
    expect(tree).toEqual({
      path: "/tree",
      name: "tree",
      type: "directory",
      size: 0,
      children: [
        {
          path: "/tree/a.txt",
          name: "a.txt",
          type: "file",
          size: 1
        },
        {
          path: "/tree/nested",
          name: "nested",
          type: "directory",
          size: 0,
          children: [
            {
              path: "/tree/nested/b.txt",
              name: "b.txt",
              type: "file",
              size: 2
            },
            {
              path: "/tree/nested/deeper",
              name: "deeper",
              type: "directory",
              size: 0
            }
          ]
        }
      ]
    });

    await expect(backend.summarizeTree("/tree")).resolves.toEqual({
      files: 3,
      directories: 3,
      symlinks: 0,
      totalBytes: 6,
      maxDepth: 3
    });
  });

  it("supports archive creation, listing, extraction, compression, hashing, and file detection", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/archive-src/a.txt": "hello",
        "/archive-src/nested/b.txt": "world"
      }
    });

    const archive = await backend.createArchive("/bundle.tar", [
      "/archive-src"
    ]);
    expect(archive.path).toBe("/bundle.tar");
    expect(archive.entries).toEqual([
      { path: "archive-src", type: "directory", size: 0 },
      { path: "archive-src/a.txt", type: "file", size: 5 },
      { path: "archive-src/nested", type: "directory", size: 0 },
      { path: "archive-src/nested/b.txt", type: "file", size: 5 }
    ]);

    await expect(backend.listArchive("/bundle.tar")).resolves.toEqual(
      archive.entries
    );

    const extracted = await backend.extractArchive("/bundle.tar", "/restored");
    expect(extracted.destination).toBe("/restored");
    await expect(backend.readFile("/restored/archive-src/a.txt")).resolves.toBe(
      "hello"
    );
    await expect(
      backend.readFile("/restored/archive-src/nested/b.txt")
    ).resolves.toBe("world");

    const compressed = await backend.compressFile("/archive-src/a.txt");
    expect(compressed.destination).toBe("/archive-src/a.txt.gz");
    const decompressed = await backend.decompressFile(
      "/archive-src/a.txt.gz",
      "/archive-src/a-restored.txt"
    );
    expect(decompressed.destination).toBe("/archive-src/a-restored.txt");
    await expect(backend.readFile("/archive-src/a-restored.txt")).resolves.toBe(
      "hello"
    );

    await expect(
      backend.hashFile("/archive-src/a.txt", { algorithm: "sha256" })
    ).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );

    await expect(backend.detectFile("/archive-src/a.txt")).resolves.toEqual({
      mime: "text/plain",
      extension: "txt",
      binary: false,
      description: "text/plain (txt)"
    });
  });
});

class FailingWriteFs {
  constructor(
    private readonly inner: InMemoryFs,
    private readonly failPath: string
  ) {}

  async readFile(path: string) {
    return this.inner.readFile(path);
  }

  async readFileBytes(path: string) {
    return this.inner.readFileBytes(path);
  }

  async writeFile(path: string, content: string) {
    if (path === this.failPath) {
      throw new Error(`simulated write failure: ${path}`);
    }
    return this.inner.writeFile(path, content);
  }

  async writeFileBytes(path: string, content: Uint8Array) {
    if (path === this.failPath) {
      throw new Error(`simulated write failure: ${path}`);
    }
    return this.inner.writeFileBytes(path, content);
  }

  async appendFile(path: string, content: string | Uint8Array) {
    return this.inner.appendFile(path, content);
  }

  async exists(path: string) {
    return this.inner.exists(path);
  }

  async stat(path: string) {
    return this.inner.stat(path);
  }

  async lstat(path: string) {
    return this.inner.lstat(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    return this.inner.mkdir(path, options);
  }

  async readdir(path: string) {
    return this.inner.readdir(path);
  }

  async readdirWithFileTypes(path: string) {
    return this.inner.readdirWithFileTypes(path);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
    return this.inner.rm(path, options);
  }

  async cp(src: string, dest: string, options?: { recursive?: boolean }) {
    return this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string) {
    return this.inner.mv(src, dest);
  }

  resolvePath(base: string, path: string) {
    return this.inner.resolvePath(base, path);
  }

  async glob(pattern: string) {
    return this.inner.glob(pattern);
  }

  async chmod(path: string, mode: number) {
    return this.inner.chmod(path, mode);
  }

  async symlink(target: string, linkPath: string) {
    return this.inner.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string) {
    return this.inner.link(existingPath, newPath);
  }

  async readlink(path: string) {
    return this.inner.readlink(path);
  }

  async realpath(path: string) {
    return this.inner.realpath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date) {
    return this.inner.utimes(path, atime, mtime);
  }
}
