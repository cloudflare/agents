import { describe, expect, it } from "vitest";
import { StateBatchOperationError } from "../index";
import { createWorkspaceStateBackend } from "../workspace";

describe("WorkspaceStateBackend", () => {
  it("reads and writes JSON through the workspace adapter", async () => {
    const files = new Map<string, string>();
    const backend = createWorkspaceStateBackend(
      createWorkspaceLike(files) as never
    );

    await backend.writeJson("/settings.json", {
      feature: true,
      retries: 3
    });

    await expect(backend.readJson("/settings.json")).resolves.toEqual({
      feature: true,
      retries: 3
    });
    expect(files.get("/settings.json")).toBe(
      '{\n  "feature": true,\n  "retries": 3\n}\n'
    );
  });

  it("searches and replaces text through the workspace adapter", async () => {
    const files = new Map<string, string>([
      ["/docs.txt", "alpha beta alpha\n"]
    ]);
    const backend = createWorkspaceStateBackend(
      createWorkspaceLike(files) as never
    );

    await expect(backend.searchText("/docs.txt", "alpha")).resolves.toEqual([
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
    ]);

    await expect(
      backend.replaceInFile("/docs.txt", "alpha", "omega")
    ).resolves.toEqual({
      replaced: 2,
      content: "omega beta omega\n"
    });
    expect(files.get("/docs.txt")).toBe("omega beta omega\n");
  });

  it("supports multi-file search, replacement, and batched edits", async () => {
    const files = new Map<string, string>([
      ["/src/a.ts", 'export const a = "foo";\n'],
      ["/src/b.ts", 'export const b = "foo";\n'],
      ["/src/c.ts", 'export const c = "nope";\n']
    ]);
    const backend = createWorkspaceStateBackend(
      createWorkspaceLike(files) as never
    );

    await expect(backend.searchFiles("/src/*.ts", "foo")).resolves.toEqual([
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
    ]);

    const preview = await backend.replaceInFiles("/src/*.ts", "foo", "bar", {
      dryRun: true
    });
    expect(preview.totalFiles).toBe(2);
    expect(preview.totalReplacements).toBe(2);
    expect(files.get("/src/a.ts")).toBe('export const a = "foo";\n');

    const applied = await backend.replaceInFiles("/src/*.ts", "foo", "bar");
    expect(applied.totalFiles).toBe(2);
    expect(files.get("/src/a.ts")).toBe('export const a = "bar";\n');
    expect(files.get("/src/b.ts")).toBe('export const b = "bar";\n');

    const editResult = await backend.applyEdits(
      [
        { path: "/src/a.ts", content: 'export const a = "baz";\n' },
        { path: "/src/d.ts", content: 'export const d = "new";\n' }
      ],
      { dryRun: true }
    );
    expect(editResult.totalChanged).toBe(2);
    expect(files.has("/src/d.ts")).toBe(false);
  });

  it("plans structured edits through the workspace adapter", async () => {
    const files = new Map<string, string>([
      ["/src/a.ts", 'export const a = "foo";\n'],
      ["/src/data.json", '{ "count": 1 }\n']
    ]);
    const backend = createWorkspaceStateBackend(
      createWorkspaceLike(files) as never
    );

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
      }
    ]);

    expect(plan.totalInstructions).toBe(2);
    expect(plan.totalChanged).toBe(2);
    expect(plan.edits[0].content).toBe('export const a = "bar";\n');
    expect(plan.edits[1].content).toBe('{\n  "count": 2\n}\n');

    await backend.applyEditPlan(plan);
    expect(files.get("/src/a.ts")).toBe('export const a = "bar";\n');
    expect(files.get("/src/data.json")).toBe('{\n  "count": 2\n}\n');
  });

  it("supports find, json query/update, tree, archive, hash, and file detection", async () => {
    const files = new Map<string, string>([
      ["/src/a.ts", 'export const a = "foo";\n'],
      ["/src/nested/b.json", '{ "count": 1 }\n'],
      ["/src/nested/c.txt", "plain"]
    ]);
    const backend = createWorkspaceStateBackend(
      createWorkspaceLike(files) as never
    );

    await expect(
      backend.find("/src", { type: "file", pathPattern: "/src/**/*.json" })
    ).resolves.toEqual([
      {
        path: "/src/nested/b.json",
        name: "b.json",
        type: "file",
        depth: 2,
        size: files.get("/src/nested/b.json")!.length,
        mtime: expect.any(Date)
      }
    ]);

    await expect(
      backend.queryJson("/src/nested/b.json", ".count")
    ).resolves.toBe(1);
    await backend.updateJson("/src/nested/b.json", [
      { op: "set", path: ".count", value: 2 }
    ]);
    expect(files.get("/src/nested/b.json")).toBe('{\n  "count": 2\n}\n');

    await expect(backend.summarizeTree("/src")).resolves.toEqual({
      files: 3,
      directories: 2,
      symlinks: 0,
      totalBytes:
        files.get("/src/a.ts")!.length +
        files.get("/src/nested/b.json")!.length +
        files.get("/src/nested/c.txt")!.length,
      maxDepth: 2
    });

    await backend.createArchive("/bundle.tar", ["/src"]);
    await expect(backend.listArchive("/bundle.tar")).resolves.toEqual([
      { path: "src", type: "directory", size: 0 },
      { path: "src/a.ts", type: "file", size: files.get("/src/a.ts")!.length },
      { path: "src/nested", type: "directory", size: 0 },
      {
        path: "src/nested/b.json",
        type: "file",
        size: files.get("/src/nested/b.json")!.length
      },
      {
        path: "src/nested/c.txt",
        type: "file",
        size: files.get("/src/nested/c.txt")!.length
      }
    ]);
    await backend.extractArchive("/bundle.tar", "/restored");
    expect(files.get("/restored/src/nested/c.txt")).toBe("plain");

    await expect(backend.hashFile("/src/nested/c.txt")).resolves.toBe(
      "a116c9ed46d6207734a43317d30fd88f52ac8634c37d904bbf4e41d865f90475"
    );
    await expect(backend.detectFile("/src/nested/c.txt")).resolves.toEqual({
      mime: "text/plain",
      extension: "txt",
      binary: false,
      description: "text/plain (txt)"
    });
  });

  it("rolls back workspace-backed batch writes on failure", async () => {
    const files = new Map<string, string>([
      ["/src/a.ts", 'export const a = "foo";\n'],
      ["/src/b.ts", 'export const b = "foo";\n']
    ]);
    const backend = createWorkspaceStateBackend(
      createWorkspaceLike(files, { failWritePath: "/src/b.ts" }) as never
    );

    await expect(
      backend.replaceInFiles("/src/*.ts", "foo", "bar")
    ).rejects.toMatchObject({
      name: "StateBatchOperationError",
      operation: "replaceInFiles",
      rolledBack: true
    } satisfies Partial<StateBatchOperationError>);

    expect(files.get("/src/a.ts")).toBe('export const a = "foo";\n');
    expect(files.get("/src/b.ts")).toBe('export const b = "foo";\n');
  });

  it("can opt out of rollback for workspace-backed batch writes", async () => {
    const files = new Map<string, string>([
      ["/src/a.ts", 'export const a = "foo";\n'],
      ["/src/b.ts", 'export const b = "foo";\n']
    ]);
    const backend = createWorkspaceStateBackend(
      createWorkspaceLike(files, { failWritePath: "/src/b.ts" }) as never
    );

    await expect(
      backend.applyEdits(
        [
          { path: "/src/a.ts", content: 'export const a = "bar";\n' },
          { path: "/src/b.ts", content: 'export const b = "bar";\n' }
        ],
        { rollbackOnError: false }
      )
    ).rejects.toMatchObject({
      name: "StateBatchOperationError",
      operation: "applyEdits",
      rolledBack: false
    } satisfies Partial<StateBatchOperationError>);

    expect(files.get("/src/a.ts")).toBe('export const a = "bar";\n');
    expect(files.get("/src/b.ts")).toBe('export const b = "foo";\n');
  });
});

function createWorkspaceLike(
  files: Map<string, string>,
  options?: { failWritePath?: string }
) {
  return {
    async readFile(path: string) {
      return files.get(path) ?? null;
    },
    async readFileBytes(path: string) {
      const value = files.get(path);
      return value === undefined ? null : new TextEncoder().encode(value);
    },
    async writeFile(path: string, content: string) {
      if (path === options?.failWritePath) {
        throw new Error(`simulated write failure: ${path}`);
      }
      files.set(path, content);
    },
    async writeFileBytes(path: string, content: Uint8Array) {
      if (path === options?.failWritePath) {
        throw new Error(`simulated write failure: ${path}`);
      }
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
      const directFile = files.get(path);
      if (directFile !== undefined) {
        return {
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          type: "file" as const,
          mimeType: "text/plain",
          size: directFile.length,
          createdAt: 0,
          updatedAt: 0
        };
      }
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const hasChildren = Array.from(files.keys()).some((filePath) =>
        filePath.startsWith(prefix)
      );
      if (hasChildren) {
        return {
          path,
          name: path.slice(path.lastIndexOf("/") + 1),
          type: "directory" as const,
          mimeType: "text/plain",
          size: 0,
          createdAt: 0,
          updatedAt: 0
        };
      }
      return null;
    },
    mkdir(_path: string) {},
    readDir(path: string) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const directories = new Map<string, ReturnType<typeof fileInfo>>();
      const fileEntries: ReturnType<typeof fileInfo>[] = [];
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (!rest.includes("/")) {
          fileEntries.push({
            path: filePath,
            name: filePath.slice(filePath.lastIndexOf("/") + 1),
            type: "file" as const,
            mimeType: "text/plain",
            size: files.get(filePath)?.length ?? 0,
            createdAt: 0,
            updatedAt: 0
          });
          continue;
        }
        const nextDir = rest.slice(0, rest.indexOf("/"));
        const dirPath = `${path === "/" ? "" : path}/${nextDir}`.replace(
          /\/+/g,
          "/"
        );
        directories.set(dirPath, {
          path: dirPath,
          name: nextDir,
          type: "directory" as const,
          mimeType: "text/plain",
          size: 0,
          createdAt: 0,
          updatedAt: 0
        });
      }
      return [...directories.values(), ...fileEntries];
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
      if (pattern === "/src/*.ts") {
        return Array.from(files.keys())
          .filter((path) => path.startsWith("/src/") && path.endsWith(".ts"))
          .map((path) => ({
            path,
            name: path.slice(path.lastIndexOf("/") + 1),
            type: "file" as const,
            mimeType: "text/plain",
            size: files.get(path)?.length ?? 0,
            createdAt: 0,
            updatedAt: 0
          }));
      }
      return [];
    },
    async diff(_pathA: string, _pathB: string) {
      return "";
    },
    async diffContent(_path: string, _newContent: string) {
      return "";
    }
  };
}
