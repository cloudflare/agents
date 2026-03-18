# Workspace

Durable file storage for Agents. A virtual filesystem backed by Durable Object SQLite with optional R2 spillover for large files. Includes symlinks, glob, diff, and streaming I/O.

**Status:** experimental (`@cloudflare/shell`)

## Problem

Agents that do code generation, document editing, or file management need a persistent filesystem. Durable Objects provide SQLite, but SQLite has a 2 MB row size limit and no filesystem abstraction. R2 can store large files but has per-request latency. Neither alone is a good fit for a general-purpose agent workspace.

We need a filesystem API that:

- Stores small files with zero network overhead (inline in SQLite)
- Handles large files without hitting DO storage limits (spill to R2)
- Provides POSIX-like operations (read, write, delete, mkdir, cp, mv, symlink, glob)
- Can be used as a backend for `@cloudflare/codemode` (via `statePlugin`) to run stateful code against the virtual filesystem
- Works within a single Durable Object with no external coordination

## How it works

### Storage model

Every file, directory, and symlink is a row in a namespaced SQLite table (`cf_workspace_{namespace}`). The table schema:

```
path            TEXT PRIMARY KEY
parent_path     TEXT NOT NULL        -- enables readDir via index lookup
name            TEXT NOT NULL
type            TEXT NOT NULL        -- 'file' | 'directory' | 'symlink'
mime_type       TEXT DEFAULT 'text/plain'
size            INTEGER DEFAULT 0
storage_backend TEXT DEFAULT 'inline' -- 'inline' | 'r2'
r2_key          TEXT                 -- set when storage_backend = 'r2'
target          TEXT                 -- symlink target
content_encoding TEXT DEFAULT 'utf8' -- 'utf8' | 'base64'
content         TEXT                 -- file content when inline
created_at      INTEGER
modified_at     INTEGER
```

An index on `parent_path` accelerates directory listings.

Files below the inline threshold (default 1.5 MB) store content directly in the `content` column. Binary data uses base64 encoding. Files at or above the threshold store metadata in SQLite and content in R2, keyed as `{r2Prefix}/{namespace}{path}`.

### Namespace isolation

Multiple `Workspace` instances can coexist on one Agent by using different `namespace` values. Each namespace gets its own table. A `WeakMap<WorkspaceHost, Set<string>>` registry prevents accidental duplicate registration on the same agent.

Namespace names must match `^[a-zA-Z][a-zA-Z0-9_]*$` — they are interpolated into SQL table names at construction time (not as query parameters), so the strict validation is a security boundary.

### Symlinks

Symlinks are stored as rows with `type = 'symlink'` and a `target` column. Resolution follows the target chain up to 40 levels deep (`MAX_SYMLINK_DEPTH`), raising `ELOOP` on cycles. Both absolute and relative targets are supported; relative targets resolve against the symlink's parent directory.

`stat()` resolves through symlinks (like POSIX `stat`). `lstat()` returns the symlink entry itself. `readlink()` returns the raw target string.

### Isolate-backed code execution

`Workspace` can be used as a sandbox filesystem backend via `@cloudflare/codemode`. Use `createWorkspaceStateBackend(workspace)` from `@cloudflare/shell` to wrap it, then pass `statePlugin(backend)` from `@cloudflare/shell/workers` to `DynamicWorkerExecutor` from `@cloudflare/codemode`. The state adapter maps all `state.*` calls to Workspace methods, so code running in the sandbox operates on the same virtual filesystem as direct API usage.

### Change events

`Workspace` accepts an `onChange` callback that fires on create, update, and delete operations. This is separate from observability — it is designed for wiring to `agent.broadcast()` for real-time client sync.

### Observability

Workspace publishes structured events to the `agents:workspace` diagnostics channel via `node:diagnostics_channel`. Events are emitted for: read, write, delete, mkdir, rm, cp, mv, state execution, and errors. Each event includes the agent name, workspace namespace, and operation-specific payload (path, storage backend, duration, etc.).

The channel is only active when subscribers exist — zero overhead otherwise.

### Streaming I/O

`readFileStream()` returns a `ReadableStream<Uint8Array>` for both inline and R2-backed files. For R2, it returns the object body directly. For inline content, it wraps the decoded bytes in a single-chunk stream.

`writeFileStream()` collects all chunks first, then decides inline vs R2 based on total size. This simplifies the write path but means the full content must fit in memory. A size hint could optimize this in the future.

### Security boundaries

- **Path validation:** all paths are normalized (no `..` traversal, no double slashes). Maximum path length is 4096 characters.
- **Symlink target validation:** max 4096 characters, must not be empty or whitespace-only.
- **Namespace validation:** alphanumeric + underscore, must start with a letter. Prevents SQL injection since namespace is interpolated into table names.
- **Execution limits:** caller-configured isolate timeouts prevent runaway scripts when using `@cloudflare/codemode`.
- **Network isolation:** isolate fetch access is blocked by default and must be explicitly enabled by the caller.

## Key decisions

### Why hybrid SQLite + R2, not pure R2?

Latency. Most agent files are small — config files, prompts, code snippets, tool outputs. Inline SQLite avoids a network round-trip for reads and writes. R2 is only used when a file exceeds the inline threshold, which is rare in practice. The threshold defaults to 1.5 MB, safely below the ~2 MB DO SQLite row limit.

### Why a flat table with path + parent_path, not a tree?

Simplicity. A single table with `path` as primary key and an index on `parent_path` covers all access patterns:

- **readDir:** `WHERE parent_path = ?`
- **glob:** `WHERE path LIKE ? ESCAPE '\'` with a prefix filter, then regex match in JS
- **recursive rm/cp:** `WHERE path LIKE ?%` to find all descendants
- **stat/read/write:** `WHERE path = ?`

No joins, no recursive CTEs, no adjacency list traversal. The tradeoff is that `mv` on a directory with many descendants requires `cp + rm` (re-inserting all rows), but single-file `mv` is a cheap `UPDATE`.

### Why no built-in process execution?

Workers have no process spawning capability. For code execution against a workspace, use `@cloudflare/codemode` with `statePlugin(createWorkspaceStateBackend(workspace))`. This keeps `Workspace` as a pure durable filesystem with no mandatory runtime dependency on the execution layer.

### Why experimental?

The API surface is large: files, directories, symlinks, glob, diff, streaming, change events, observability. We want real usage feedback before committing to stability guarantees. Known areas that may change:

- Streaming write optimization (currently collects all chunks before deciding storage)
- Multi-workspace transactions
- File locking / conflict resolution

### Why per-instance Workspace instead of a mixin on Agent?

Agents may need multiple workspaces with different configurations — different namespaces, different R2 buckets, different execution settings. Composition (`new Workspace(this, opts)`) is more flexible than inheritance. The `WorkspaceHost` interface is minimal (`sql` + optional `name`), so it could work with non-Agent hosts in the future.

### Why symlinks?

AI coding agents commonly create symlinks. Omitting them would create a class of "works locally but not in workspace" bugs. The implementation is straightforward — a `type = 'symlink'` row with a `target` column and chain resolution.

### Why namespace rather than separate DOs?

Multiple workspaces in one DO share the same SQLite database and alarm lifecycle. Separate DOs would require cross-DO coordination for operations that span workspaces. The namespace approach keeps everything in-process while providing table-level isolation.

## Tradeoffs

**No streaming writes to R2 in parallel.** `writeFileStream()` collects all chunks before deciding inline vs R2. This means the full file content must fit in memory. A size hint parameter could allow streaming directly to R2 for known-large files.

**State sessions don't survive hibernation.** `StateSession` holds cwd and env in memory. If the Durable Object hibernates, session state is lost. Serializing cwd/env to SQLite on each exec and restoring on wake is a potential future enhancement.

**`r2Prefix` collision risk.** Two agents sharing the same R2 bucket with the same (or empty default) prefix will collide on R2 keys. This is a configuration responsibility — not enforced by the runtime. Documenting the risk prominently would help.

**No file locking.** Concurrent writes to the same path from multiple connections are last-write-wins via SQLite's serialized writes. Acceptable for single-agent usage but problematic if multiple agents or connections write to the same workspace simultaneously.

**Glob is SQL prefix + JS regex.** The glob implementation extracts a literal prefix from the pattern for SQL `LIKE` filtering, then applies a full regex match in JS. This covers common patterns (`*.ts`, `src/**/*.js`) but may diverge from POSIX glob semantics on edge cases.

**Directory mv is O(n).** Moving a directory with many descendants falls back to `cp + rm` (re-inserting all rows and their R2 objects). Single-file and symlink `mv` is O(1) via SQL `UPDATE`. This is acceptable for typical agent workloads where directories are small, but could be expensive for large trees.

## Testing

Tests in `packages/shell/src/tests/workspace.test.ts`, running inside the Workers runtime via `@cloudflare/vitest-pool-workers`:

- **File I/O:** read/write roundtrip, missing files, overwrite, binary, streaming, mime types
- **Directories:** mkdir, readDir, recursive mkdir, nested listings
- **Symlinks:** create, readlink, lstat, resolution, cycles, dangling
- **Operations:** cp, mv, rm (files and directories, recursive)
- **Glob:** pattern matching, prefix optimization
- **Diff:** file-to-file, content diff
- **Security:** path traversal prevention, path length limits, symlink target validation
- **Change events:** create/update/delete callbacks
- **Observability:** event emission for all operations, timestamps, agent name, unsubscribe
