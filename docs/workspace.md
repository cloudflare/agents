# Workspace

Workspace provides a durable virtual filesystem backed by SQLite and optional R2 large-file storage. It works with any Durable Object that has SQLite storage, D1 databases, or custom SQL backends.

> **Experimental** — this feature may have breaking changes in future releases.

## Installation

```sh
npm install @cloudflare/shell
```

## Quick start

```typescript
import { Agent } from "agents";
import { Workspace } from "@cloudflare/shell";

class MyAgent extends Agent<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name
  });

  async onMessage(conn, msg) {
    await this.workspace.writeFile("/hello.txt", "world");
    const content = await this.workspace.readFile("/hello.txt");
    conn.send(content); // "world"
  }
}
```

## SQL backends

Workspace accepts any SQL source via the `sql` option. The constructor auto-detects which type you pass.

### Durable Object SQLite (SqlStorage)

Any Durable Object with SQLite storage — not just Agents:

```typescript
// Inside any Durable Object
const workspace = new Workspace({ sql: ctx.storage.sql });
```

### D1

```typescript
// Using a D1 database binding
const workspace = new Workspace({ sql: env.MY_DB });
```

### Custom backend

Implement the `SqlBackend` interface for any other SQL source:

```typescript
import type { SqlBackend } from "@cloudflare/shell";

const backend: SqlBackend = {
  query(sql, ...params) {
    // Return rows as an array of objects
    return myDb.execute(sql, params);
  },
  run(sql, ...params) {
    // Execute without returning rows
    myDb.execute(sql, params);
  }
};

const workspace = new Workspace({ sql: backend });
```

`query` and `run` may return synchronously or return a Promise — Workspace handles both.

## Constructor options

All options are passed as a single object to `new Workspace(options)`.

| Option            | Type                                     | Default      | Description                                      |
| ----------------- | ---------------------------------------- | ------------ | ------------------------------------------------ |
| `sql`             | `SqlStorage \| D1Database \| SqlBackend` | **required** | SQL backend for file metadata and inline content |
| `namespace`       | `string`                                 | `"default"`  | Table namespace for isolation                    |
| `r2`              | `R2Bucket`                               | `null`       | R2 bucket for large files                        |
| `r2Prefix`        | `string`                                 | `name`       | Key prefix for R2 objects                        |
| `inlineThreshold` | `number`                                 | `1_500_000`  | Byte size above which files spill to R2          |
| `name`            | `string \| () => string \| undefined`    | `undefined`  | Name for R2 prefix fallback and observability    |
| `onChange`        | `(event: WorkspaceChangeEvent) => void`  | `undefined`  | Callback fired on create, update, and delete     |

### Lazy name resolution

In Durable Objects, `this.name` is not available at class field initialization time. Pass a function to defer evaluation:

```typescript
class MyAgent extends Agent<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name // evaluated when needed, not at construction
  });
}
```

## File operations

### Read and write

```typescript
await workspace.writeFile(
  "/config.json",
  '{"debug": true}',
  "application/json"
);
const content = await workspace.readFile("/config.json"); // string | null
```

`readFile` returns `null` for missing files. It throws `EISDIR` if the path is a directory.

### Binary files

```typescript
await workspace.writeFileBytes("/image.png", pngBytes, "image/png");
const bytes = await workspace.readFileBytes("/image.png"); // Uint8Array | null
```

### Streaming

```typescript
const stream = await workspace.readFileStream("/large.bin");
await workspace.writeFileStream("/upload.bin", requestBody);
```

`writeFileStream` collects all chunks before deciding inline vs R2 storage. The maximum stream size is 100 MB.

### Append

```typescript
await workspace.appendFile("/log.txt", "new line\n");
```

For inline UTF-8 files, this is an efficient SQL `UPDATE content = content || ?`. For R2-backed files, it reads, concatenates, and rewrites.

### Delete

```typescript
const deleted = await workspace.deleteFile("/old.txt"); // true | false
```

Returns `false` for missing files. Throws `EISDIR` for directories — use `rm()` instead.

## Directory operations

```typescript
await workspace.mkdir("/src/components", { recursive: true });

const entries = await workspace.readDir("/src"); // FileInfo[]
// Each entry: { path, name, type, mimeType, size, createdAt, updatedAt }

const matches = await workspace.glob("/src/**/*.ts"); // FileInfo[]
```

### Remove

```typescript
await workspace.rm("/src", { recursive: true });
await workspace.rm("/maybe-missing", { force: true }); // no error if absent
```

### Copy and move

```typescript
await workspace.cp("/src", "/backup", { recursive: true });
await workspace.mv("/old.txt", "/new.txt");
```

## Stat and existence

```typescript
const stat = await workspace.stat("/file.txt"); // FileStat | null
// { path, name, type, mimeType, size, createdAt, updatedAt }

const exists = await workspace.exists("/file.txt"); // true for files and dirs
const isFile = await workspace.fileExists("/file.txt"); // true only for files
```

`stat` follows symlinks. Use `lstat` to get the symlink entry itself.

## Symlinks

```typescript
await workspace.symlink("/real.txt", "/link.txt");

const target = await workspace.readlink("/link.txt"); // "/real.txt"
const stat = await workspace.lstat("/link.txt"); // type: "symlink"
```

Reading or writing through a symlink follows the target chain (up to 40 levels). Both absolute and relative targets are supported.

## Diff

```typescript
const diff = await workspace.diff("/a.txt", "/b.txt"); // unified diff string
const diff2 = await workspace.diffContent("/file.txt", newContent); // compare against string
```

Returns an empty string when the inputs are identical. Files larger than 10,000 lines are rejected.

## Workspace info

```typescript
const info = await workspace.getWorkspaceInfo();
// { fileCount, directoryCount, totalBytes, r2FileCount }
```

## Namespace isolation

Multiple Workspace instances can coexist on the same SQL source by using different namespaces. Each namespace gets its own table (`cf_workspace_<namespace>`):

```typescript
const code = new Workspace({ sql: ctx.storage.sql, namespace: "code" });
const data = new Workspace({ sql: ctx.storage.sql, namespace: "data" });
```

Namespace names must start with a letter and contain only alphanumeric characters or underscores.

## R2 large-file storage

Files below the inline threshold (default 1.5 MB) are stored directly in SQLite. Larger files store metadata in SQLite and content in R2:

```typescript
const workspace = new Workspace({
  sql: this.ctx.storage.sql,
  r2: this.env.WORKSPACE_FILES,
  name: () => this.name,
  inlineThreshold: 2_000_000 // 2 MB
});
```

R2 keys follow the pattern `{name}/{namespace}{path}`. If no `r2Prefix` is provided, `name` is used as the prefix.

When a file exceeds the threshold but no R2 bucket is configured, the file is stored inline with a console warning.

## Change events

Pass an `onChange` callback to react to file changes in real time:

```typescript
const workspace = new Workspace({
  sql: this.ctx.storage.sql,
  onChange: (event) => {
    // event: { type: "create" | "update" | "delete", path, entryType }
    this.broadcast(JSON.stringify(event));
  }
});
```

## Observability

Workspace publishes structured events to the `agents:workspace` diagnostics channel via `node:diagnostics_channel`. Events are emitted for reads, writes, deletes, mkdir, rm, cp, and mv. Each event includes the workspace name, namespace, and operation-specific payload.

```typescript
import { subscribe } from "node:diagnostics_channel";

subscribe("agents:workspace", (message) => {
  console.log(message);
  // { type: "workspace:write", name: "my-agent", payload: { path, size, storage, namespace }, timestamp }
});
```

The channel is only active when subscribers exist — zero overhead otherwise.

## Using with codemode

Workspace integrates with `@cloudflare/codemode` to give sandboxed code access to the filesystem via a `state` object. Use `stateTools()` from `@cloudflare/shell/workers`:

```typescript
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";

class MyAgent extends Agent<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    name: () => this.name
  });

  async run(code: string) {
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    return executor.execute(code, [
      resolveProvider(stateTools(this.workspace))
    ]);
  }
}
```

Inside the sandbox, the `state` object exposes file operations, search/replace, JSON helpers, archive tools, and more. See [Codemode](./codemode.md) for details.

## Types

```typescript
import type {
  SqlBackend,
  SqlSource,
  SqlParam,
  WorkspaceOptions,
  EntryType, // "file" | "directory" | "symlink"
  FileInfo, // { path, name, type, mimeType, size, createdAt, updatedAt, target? }
  FileStat, // same as FileInfo
  WorkspaceChangeEvent, // { type, path, entryType }
  WorkspaceChangeType // "create" | "update" | "delete"
} from "@cloudflare/shell";
```

## Path handling

- Paths are normalized: leading `/` is added if missing, `..` and `.` segments are resolved, duplicate slashes are collapsed
- Maximum path length is 4,096 characters
- `writeFile` and `writeFileBytes` automatically create parent directories

## Security considerations

- **Path traversal** — `..` segments are resolved during normalization, preventing directory escape
- **SQL injection** — table names derive from the namespace, which is validated against `^[a-zA-Z][a-zA-Z0-9_]*$`; all query parameters use parameterized queries
- **Symlink loops** — resolution is capped at 40 levels, raising `ELOOP` on cycles
- **Stream size** — `writeFileStream` rejects streams exceeding 100 MB
- **Diff size** — `diff` and `diffContent` reject files exceeding 10,000 lines
