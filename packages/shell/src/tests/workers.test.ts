import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createMemoryStateBackend } from "../memory";
import { createWorkspaceStateBackend } from "../workspace";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { stateToolsFromBackend } from "../workers";

/** Resolve a state backend into executor-ready providers. */
function stateProviders(backend: ReturnType<typeof createMemoryStateBackend>) {
  return [resolveProvider(stateToolsFromBackend(backend))];
}

describe("stateTools", () => {
  it("executes code against the injected state runtime", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/app.ts": 'export const value = "foo";\n'
      }
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const file = await state.readFile("/src/app.ts");
        await state.writeFile("/src/app.ts", file.replace("foo", "bar"));
        return await state.readFile("/src/app.ts");
      }`,
      stateProviders(backend)
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe('export const value = "bar";\n');
  });

  it("supports concurrent state calls and captures logs", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/a.txt": "A",
        "/b.txt": "B"
      }
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const values = await Promise.all([
          state.readFile("/a.txt"),
          state.readFile("/b.txt")
        ]);
        console.log(values.join(","));
        return values;
      }`,
      stateProviders(backend)
    );

    expect(result.result).toEqual(["A", "B"]);
    expect(result.logs).toContain("A,B");
  });

  it("supports JSON helpers inside the sandbox", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/config.json": '{ "enabled": true, "count": 1 }\n'
      }
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const config = await state.readJson("/config.json");
        config.count += 1;
        await state.writeJson("/config.json", config);
        return await state.readJson("/config.json");
      }`,
      stateProviders(backend)
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      enabled: true,
      count: 2
    });
    await expect(backend.readFile("/config.json")).resolves.toBe(
      '{\n  "enabled": true,\n  "count": 2\n}\n'
    );
  });

  it("supports search and replace helpers inside the sandbox", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/notes.txt": "alpha beta alpha\n"
      }
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const matches = await state.searchText("/notes.txt", "alpha");
        const replacement = await state.replaceInFile(
          "/notes.txt",
          "alpha",
          "omega"
        );
        return { matches, replacement, next: await state.readFile("/notes.txt") };
      }`,
      stateProviders(backend)
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      matches: [
        {
          line: 1,
          column: 1,
          match: "alpha",
          lineText: "alpha beta alpha"
        },
        {
          line: 1,
          column: 12,
          match: "alpha",
          lineText: "alpha beta alpha"
        }
      ],
      replacement: {
        replaced: 2,
        content: "omega beta omega\n"
      },
      next: "omega beta omega\n"
    });
  });

  it("supports batch search, replace, and apply helpers inside the sandbox", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const a = "foo";\n',
        "/src/b.ts": 'export const b = "foo";\n',
        "/src/c.ts": 'export const c = "nope";\n'
      }
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const found = await state.searchFiles("/src/*.ts", "foo");
        const preview = await state.replaceInFiles(
          "/src/*.ts",
          "foo",
          "bar",
          { dryRun: true }
        );
        const applied = await state.applyEdits(
          [
            { path: "/src/a.ts", content: 'export const a = "baz";\\n' },
            { path: "/src/d.ts", content: 'export const d = "new";\\n' }
          ],
          { dryRun: true }
        );
        return { found, preview, applied };
      }`,
      stateProviders(backend)
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      found: [
        {
          path: "/src/a.ts",
          matches: [
            {
              line: 1,
              column: 19,
              match: "foo",
              lineText: 'export const a = "foo";'
            }
          ]
        },
        {
          path: "/src/b.ts",
          matches: [
            {
              line: 1,
              column: 19,
              match: "foo",
              lineText: 'export const b = "foo";'
            }
          ]
        }
      ],
      preview: {
        dryRun: true,
        files: [
          {
            path: "/src/a.ts",
            replaced: 1,
            content: 'export const a = "bar";\n',
            diff: expect.stringContaining("--- /src/a.ts")
          },
          {
            path: "/src/b.ts",
            replaced: 1,
            content: 'export const b = "bar";\n',
            diff: expect.stringContaining("--- /src/b.ts")
          }
        ],
        totalFiles: 2,
        totalReplacements: 2
      },
      applied: {
        dryRun: true,
        edits: [
          {
            path: "/src/a.ts",
            changed: true,
            content: 'export const a = "baz";\n',
            diff: expect.stringContaining("--- /src/a.ts")
          },
          {
            path: "/src/d.ts",
            changed: true,
            content: 'export const d = "new";\n',
            diff: expect.stringContaining("--- /src/d.ts")
          }
        ],
        totalChanged: 2
      }
    });

    await expect(backend.readFile("/src/a.ts")).resolves.toBe(
      'export const a = "foo";\n'
    );
    await expect(backend.exists("/src/d.ts")).resolves.toBe(false);
  });

  it("supports planning structured edits inside the sandbox", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const a = "foo";\n',
        "/src/data.json": '{ "count": 1 }\n'
      }
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const plan = await state.planEdits([
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
            content: 'export const created = true;\\n'
          }
        ]);

        const preview = await state.applyEditPlan(plan, { dryRun: true });
        const applied = await state.applyEditPlan(plan);
        return { plan, preview, applied, next: await state.readFile("/src/new.ts") };
      }`,
      stateProviders(backend)
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      plan: {
        edits: [
          {
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
          },
          {
            instruction: {
              kind: "writeJson",
              path: "/src/data.json",
              value: { count: 2 }
            },
            path: "/src/data.json",
            changed: true,
            content: '{\n  "count": 2\n}\n',
            diff: expect.stringContaining("--- /src/data.json")
          },
          {
            instruction: {
              kind: "write",
              path: "/src/new.ts",
              content: "export const created = true;\n"
            },
            path: "/src/new.ts",
            changed: true,
            content: "export const created = true;\n",
            diff: expect.stringContaining("--- /src/new.ts")
          }
        ],
        totalChanged: 3,
        totalInstructions: 3
      },
      preview: {
        dryRun: true,
        edits: [
          {
            path: "/src/a.ts",
            changed: true,
            content: 'export const a = "bar";\n',
            diff: expect.stringContaining("--- /src/a.ts")
          },
          {
            path: "/src/data.json",
            changed: true,
            content: '{\n  "count": 2\n}\n',
            diff: expect.stringContaining("--- /src/data.json")
          },
          {
            path: "/src/new.ts",
            changed: true,
            content: "export const created = true;\n",
            diff: expect.stringContaining("--- /src/new.ts")
          }
        ],
        totalChanged: 3
      },
      applied: {
        dryRun: false,
        edits: [
          {
            path: "/src/a.ts",
            changed: true,
            content: 'export const a = "bar";\n',
            diff: expect.stringContaining("--- /src/a.ts")
          },
          {
            path: "/src/data.json",
            changed: true,
            content: '{\n  "count": 2\n}\n',
            diff: expect.stringContaining("--- /src/data.json")
          },
          {
            path: "/src/new.ts",
            changed: true,
            content: "export const created = true;\n",
            diff: expect.stringContaining("--- /src/new.ts")
          }
        ],
        totalChanged: 3
      },
      next: "export const created = true;\n"
    });
  });

  it("supports find, json query/update, archive, tree, hash, and file detection inside the sandbox", async () => {
    const backend = createMemoryStateBackend({
      files: {
        "/src/a.ts": 'export const a = "foo";\n',
        "/src/config.json": '{ "enabled": true }\n',
        "/src/docs/readme.txt": "hello"
      }
    });
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const found = await state.find("/src", {
          type: "file",
          pathPattern: "/src/**/*.json"
        });
        const before = await state.queryJson("/src/config.json", ".enabled");
        await state.updateJson("/src/config.json", [
          { op: "set", path: ".enabled", value: false }
        ]);
        await state.createArchive("/bundle.tar", ["/src"]);
        const archive = await state.listArchive("/bundle.tar");
        const summary = await state.summarizeTree("/src");
        const hash = await state.hashFile("/src/docs/readme.txt");
        const detected = await state.detectFile("/src/docs/readme.txt");
        return { found, before, archive, summary, hash, detected };
      }`,
      stateProviders(backend)
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      found: [
        {
          path: "/src/config.json",
          name: "config.json",
          type: "file",
          depth: 1,
          size: 20,
          mtime: expect.any(String)
        }
      ],
      before: true,
      archive: [
        { path: "src", type: "directory", size: 0 },
        { path: "src/a.ts", type: "file", size: 24 },
        { path: "src/config.json", type: "file", size: 23 },
        { path: "src/docs", type: "directory", size: 0 },
        { path: "src/docs/readme.txt", type: "file", size: 5 }
      ],
      summary: {
        files: 3,
        directories: 2,
        symlinks: 0,
        totalBytes: 52,
        maxDepth: 2
      },
      hash: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      detected: {
        mime: "text/plain",
        extension: "txt",
        binary: false,
        description: "text/plain (txt)"
      }
    });
    await expect(backend.readJson("/src/config.json")).resolves.toEqual({
      enabled: false
    });
  });

  it("blocks external fetch by default", async () => {
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });
    const backend = createMemoryStateBackend();

    const result = await executor.execute(
      'async () => fetch("https://example.com").then((r) => r.status)',
      stateProviders(backend)
    );

    expect(result.error).toBeDefined();
  });

  it("supports custom modules inside the sandbox", async () => {
    const executor = new DynamicWorkerExecutor({
      loader: env.LOADER,
      modules: {
        "helpers.js": 'export function suffix(value) { return value + "-ok"; }'
      }
    });
    const backend = createMemoryStateBackend({
      files: {
        "/data.txt": "value"
      }
    });

    const result = await executor.execute(
      `async () => {
        const { suffix } = await import("helpers.js");
        return suffix(await state.readFile("/data.txt"));
      }`,
      stateProviders(backend)
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("value-ok");
  });

  it("routes coarse operations through the workspace adapter", async () => {
    const files = new Map<string, string>([
      ["/workspace/a.ts", "const answer = 1;\n"],
      ["/workspace/b.ts", "const other = 2;\n"]
    ]);
    let globCalls = 0;

    const workspaceLike = {
      async readFile(path: string) {
        return files.get(path) ?? null;
      },
      async readFileBytes(path: string) {
        const v = files.get(path);
        return v === undefined ? null : new TextEncoder().encode(v);
      },
      async writeFile(path: string, content: string) {
        files.set(path, content);
      },
      async writeFileBytes(path: string, content: Uint8Array) {
        files.set(path, new TextDecoder().decode(content));
      },
      async appendFile(path: string, content: string) {
        files.set(path, (files.get(path) ?? "") + content);
      },
      exists(path: string) {
        return files.has(path);
      },
      stat(_path: string) {
        return null;
      },
      lstat(_path: string) {
        return null;
      },
      mkdir(_path: string) {},
      readDir(_path: string) {
        return [];
      },
      async rm(_path: string) {},
      async cp(_src: string, _dest: string) {},
      async mv(_src: string, _dest: string) {},
      symlink(_target: string, _linkPath: string) {},
      readlink(_path: string) {
        return "";
      },
      glob(pattern: string) {
        globCalls++;
        if (pattern === "/workspace/*.ts")
          return [fileInfo("/workspace/a.ts"), fileInfo("/workspace/b.ts")];
        return [];
      },
      async diff(_pathA: string, _pathB: string) {
        return "";
      }
    };

    const backend = createWorkspaceStateBackend(workspaceLike as never);
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const matches = await state.glob("/workspace/*.ts");
        const diff = await state.diffContent("/workspace/a.ts", "const answer = 2;\\n");
        return { matches, diff };
      }`,
      [resolveProvider(stateToolsFromBackend(backend))]
    );

    expect(result.error).toBeUndefined();
    expect((result.result as { matches: string[] }).matches).toEqual([
      "/workspace/a.ts",
      "/workspace/b.ts"
    ]);
    expect((result.result as { diff: string }).diff).toEqual(
      expect.stringContaining("-const answer = 1;")
    );
    expect((result.result as { diff: string }).diff).toEqual(
      expect.stringContaining("+const answer = 2;")
    );
    expect(globCalls).toBe(1);
  });

  it("runs JSON and replace helpers through the workspace adapter", async () => {
    const files = new Map<string, string>([
      ["/workspace/config.json", '{ "name": "demo", "feature": "alpha" }\n']
    ]);
    let writeCalls = 0;

    const workspaceLike = {
      async readFile(path: string) {
        return files.get(path) ?? null;
      },
      async readFileBytes(path: string) {
        const v = files.get(path);
        return v === undefined ? null : new TextEncoder().encode(v);
      },
      async writeFile(path: string, content: string) {
        writeCalls++;
        files.set(path, content);
      },
      async writeFileBytes(path: string, content: Uint8Array) {
        writeCalls++;
        files.set(path, new TextDecoder().decode(content));
      },
      async appendFile(path: string, content: string) {
        files.set(path, (files.get(path) ?? "") + content);
      },
      exists(path: string) {
        return files.has(path);
      },
      stat(_path: string) {
        return null;
      },
      lstat(_path: string) {
        return null;
      },
      mkdir(_path: string) {},
      readDir(_path: string) {
        return [];
      },
      async rm(_path: string) {},
      async cp(_src: string, _dest: string) {},
      async mv(_src: string, _dest: string) {},
      symlink(_target: string, _linkPath: string) {},
      readlink(_path: string) {
        return "";
      },
      glob(_pattern: string) {
        return [];
      },
      async diff(_pathA: string, _pathB: string) {
        return "";
      },
      async diffContent(_path: string, _newContent: string) {
        return "";
      }
    };

    const backend = createWorkspaceStateBackend(workspaceLike as never);
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const config = await state.readJson("/workspace/config.json");
        await state.replaceInFile("/workspace/config.json", "alpha", "beta");
        const next = await state.readJson("/workspace/config.json");
        return { config, next };
      }`,
      [resolveProvider(stateToolsFromBackend(backend))]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      config: { name: "demo", feature: "alpha" },
      next: { name: "demo", feature: "beta" }
    });
    expect(writeCalls).toBe(1);
  });

  it("runs batch helpers through the workspace adapter", async () => {
    const files = new Map<string, string>([
      ["/workspace/a.ts", 'export const a = "foo";\n'],
      ["/workspace/b.ts", 'export const b = "foo";\n']
    ]);
    let writeCalls = 0;

    const workspaceLike = {
      async readFile(path: string) {
        return files.get(path) ?? null;
      },
      async readFileBytes(path: string) {
        const v = files.get(path);
        return v === undefined ? null : new TextEncoder().encode(v);
      },
      async writeFile(path: string, content: string) {
        writeCalls++;
        files.set(path, content);
      },
      async writeFileBytes(path: string, content: Uint8Array) {
        writeCalls++;
        files.set(path, new TextDecoder().decode(content));
      },
      async appendFile(path: string, content: string) {
        files.set(path, (files.get(path) ?? "") + content);
      },
      exists(path: string) {
        return files.has(path);
      },
      stat(_path: string) {
        return null;
      },
      lstat(path: string) {
        return files.has(path)
          ? {
              path,
              name: path.slice(path.lastIndexOf("/") + 1),
              type: "file" as const,
              mimeType: "text/plain",
              size: files.get(path)?.length ?? 0,
              createdAt: 0,
              updatedAt: 0
            }
          : null;
      },
      mkdir(_path: string) {},
      readDir(_path: string) {
        return [];
      },
      async rm(_path: string) {},
      async cp(_src: string, _dest: string) {},
      async mv(_src: string, _dest: string) {},
      symlink(_target: string, _linkPath: string) {},
      readlink(_path: string) {
        return "";
      },
      glob(pattern: string) {
        if (pattern === "/workspace/*.ts")
          return [fileInfo("/workspace/a.ts"), fileInfo("/workspace/b.ts")];
        return [];
      },
      async diff(_pathA: string, _pathB: string) {
        return "";
      },
      async diffContent(path: string, newContent: string) {
        const current = files.get(path) ?? "";
        return `--- ${path}\n+++ ${path}\n-${current.trim()}\n+${newContent.trim()}`;
      }
    };

    const backend = createWorkspaceStateBackend(workspaceLike as never);
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () => {
        const preview = await state.replaceInFiles(
          "/workspace/*.ts",
          "foo",
          "bar",
          { dryRun: true }
        );
        const applied = await state.applyEdits(
          [{ path: "/workspace/c.ts", content: 'export const c = "new";\\n' }],
          { dryRun: true }
        );
        return { preview, applied };
      }`,
      [resolveProvider(stateToolsFromBackend(backend))]
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      preview: {
        dryRun: true,
        files: [
          {
            path: "/workspace/a.ts",
            replaced: 1,
            content: 'export const a = "bar";\n',
            diff: expect.stringContaining("--- /workspace/a.ts")
          },
          {
            path: "/workspace/b.ts",
            replaced: 1,
            content: 'export const b = "bar";\n',
            diff: expect.stringContaining("--- /workspace/b.ts")
          }
        ],
        totalFiles: 2,
        totalReplacements: 2
      },
      applied: {
        dryRun: true,
        edits: [
          {
            path: "/workspace/c.ts",
            changed: true,
            content: 'export const c = "new";\n',
            diff: expect.stringContaining("--- /workspace/c.ts")
          }
        ],
        totalChanged: 1
      }
    });
    expect(writeCalls).toBe(0);
  });

  it("rolls back failed batch writes through the isolate bridge", async () => {
    const files = new Map<string, string>([
      ["/workspace/a.ts", 'export const a = "foo";\n'],
      ["/workspace/b.ts", 'export const b = "foo";\n']
    ]);

    const workspaceLike = {
      async readFile(path: string) {
        return files.get(path) ?? null;
      },
      async readFileBytes(path: string) {
        const v = files.get(path);
        return v === undefined ? null : new TextEncoder().encode(v);
      },
      async writeFile(path: string, content: string) {
        if (path === "/workspace/b.ts")
          throw new Error(`simulated write failure: ${path}`);
        files.set(path, content);
      },
      async writeFileBytes(path: string, content: Uint8Array) {
        if (path === "/workspace/b.ts")
          throw new Error(`simulated write failure: ${path}`);
        files.set(path, new TextDecoder().decode(content));
      },
      async appendFile(path: string, content: string) {
        files.set(path, (files.get(path) ?? "") + content);
      },
      exists(path: string) {
        return files.has(path);
      },
      stat(_path: string) {
        return null;
      },
      lstat(path: string) {
        return files.has(path)
          ? {
              path,
              name: path.slice(path.lastIndexOf("/") + 1),
              type: "file" as const,
              mimeType: "text/plain",
              size: files.get(path)?.length ?? 0,
              createdAt: 0,
              updatedAt: 0
            }
          : null;
      },
      mkdir(_path: string) {},
      readDir(_path: string) {
        return [];
      },
      async rm(_path: string) {},
      async deleteFile(path: string) {
        return files.delete(path);
      },
      async cp(_src: string, _dest: string) {},
      async mv(_src: string, _dest: string) {},
      symlink(_target: string, _linkPath: string) {},
      readlink(_path: string) {
        return "";
      },
      glob(pattern: string) {
        if (pattern === "/workspace/*.ts")
          return [fileInfo("/workspace/a.ts"), fileInfo("/workspace/b.ts")];
        return [];
      },
      async diff(_pathA: string, _pathB: string) {
        return "";
      },
      async diffContent(path: string, newContent: string) {
        const current = files.get(path) ?? "";
        return `--- ${path}\n+++ ${path}\n-${current.trim()}\n+${newContent.trim()}`;
      }
    };

    const backend = createWorkspaceStateBackend(workspaceLike as never);
    const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

    const result = await executor.execute(
      `async () =>
        state.replaceInFiles("/workspace/*.ts", "foo", "bar")`,
      [resolveProvider(stateToolsFromBackend(backend))]
    );

    expect(result.error).toContain("simulated write failure");
    expect(files.get("/workspace/a.ts")).toBe('export const a = "foo";\n');
    expect(files.get("/workspace/b.ts")).toBe('export const b = "foo";\n');
  });
});

function fileInfo(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    path,
    name,
    type: "file" as const,
    mimeType: "text/plain",
    size: 0,
    createdAt: 0,
    updatedAt: 0
  };
}
