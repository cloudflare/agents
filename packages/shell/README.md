# `@cloudflare/shell`

> **Experimental.** API surface is still settling — expect breaking changes.

Sandboxed JavaScript execution and filesystem runtime for Cloudflare Workers agents.

Instead of parsing shell syntax, `@cloudflare/shell` runs JavaScript inside an isolated Worker and exposes a typed `state` object for operating on a filesystem backend. It is designed for agent workflows that need structured state operations, predictable semantics, and coarse host-side filesystem primitives.

## What it is

- A runtime-neutral `StateBackend` interface for filesystem/state operations
- A `FileSystem` interface with two implementations: `InMemoryFs` (ephemeral) and `WorkspaceFileSystem` (durable)
- `FileSystemStateBackend` — a single adapter wrapping any `FileSystem` into a `StateBackend`
- `Workspace` — durable file storage backed by SQLite + optional R2
- `stateTools(workspace)` — a `ToolProvider` for `@cloudflare/codemode` that exposes `state.*` in sandboxed executions
- A prebuilt `state` stdlib with type declarations for LLM prompts

## What it is not

This is **not** a bash interpreter. It does not parse shell syntax, expose pipes, or emulate POSIX shell behavior. It executes JavaScript.

## Example — in-memory state

```ts
import { createMemoryStateBackend } from "@cloudflare/shell";
import { stateToolsFromBackend } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";

const backend = createMemoryStateBackend({
  files: {
    "/src/app.ts": 'export const answer = "foo";\n'
  }
});

const executor = new DynamicWorkerExecutor({ loader: env.LOADER });

const result = await executor.execute(
  `async () => {
    const text = await state.readFile("/src/app.ts");
    await state.writeFile("/src/app.ts", text.replace("foo", "bar"));
    return await state.readFile("/src/app.ts");
  }`,
  [resolveProvider(stateToolsFromBackend(backend))]
);
```

## Example — durable Workspace

```ts
import { Agent } from "agents";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";

class MyAgent extends Agent<Env> {
  workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.MY_BUCKET,
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

## Design goals

- Structured state operations instead of shell parsing
- Coarse host-side operations like `glob()` and `diff()` to avoid chatty RPC
- Compatibility with both ephemeral in-memory state and durable `Workspace`
- Secure execution with isolate-level timeouts and outbound network blocking by default

## `state` object API

The `state` object is available inside every isolate and exposes:

### Primitive filesystem

`readFile`, `writeFile`, `appendFile`, `readFileBytes`, `writeFileBytes`, `mkdir`, `rm`, `cp`, `mv`, `symlink`, `readlink`, `realpath`, `readdir`, `glob`, `stat`, `lstat`, `exists`, `diff`, `diffContent`

### JSON helpers

`readJson(path)`, `writeJson(path, value, { spaces? })`, `queryJson(path, query)`, `updateJson(path, operations)`

### Search and replace

`searchText(path, query, options?)`, `searchFiles(glob, query, options?)`, `replaceInFile(path, search, replacement, options?)`, `replaceInFiles(glob, search, replacement, { dryRun?, rollbackOnError?, ...options })`

### Filesystem queries

`find(path, options?)`, `walkTree(path, { maxDepth? })`, `summarizeTree(path, { maxDepth? })`

### Archive and compression

`createArchive(path, sources)`, `listArchive(path)`, `extractArchive(path, destination)`, `compressFile(path, destination?)`, `decompressFile(path, destination?)`, `hashFile(path, { algorithm? })`, `detectFile(path)`

### Structured edit planning

`planEdits(instructions)`, `applyEditPlan(plan, { dryRun?, rollbackOnError? })`, `applyEdits(edits, { dryRun?, rollbackOnError? })`

## Multi-file workflow

```ts
// Preview changes without applying
const preview = await state.replaceInFiles("src/**/*.ts", "foo", "bar", {
  dryRun: true
});

// Plan structured edits with intent
const plan = await state.planEdits([
  { kind: "replace", path: "/src/app.ts", search: "foo", replacement: "bar" },
  { kind: "writeJson", path: "/src/config.json", value: { enabled: true } }
]);
await state.applyEditPlan(plan);

// Apply raw edits transactionally
await state.applyEdits([
  { path: "/src/generated.ts", content: "export const generated = true;\n" }
]);
```

Batch writes roll back by default if any write fails. Set `rollbackOnError: false` to allow partial progress.

## Rough command translation

| Shell command        | `state` equivalent                                                         |
| -------------------- | -------------------------------------------------------------------------- |
| `cat`                | `state.readFile()`                                                         |
| `echo x > file`      | `state.writeFile()`                                                        |
| `mkdir`              | `state.mkdir()`                                                            |
| `ls` / `find`        | `state.readdir()` / `state.glob()`                                         |
| `find` with filters  | `state.find()`                                                             |
| `tree` / `du`        | `state.walkTree()` / `state.summarizeTree()`                               |
| `cp` / `mv` / `rm`   | `state.cp()` / `state.mv()` / `state.rm()`                                 |
| `diff`               | `state.diff()` / `state.diffContent()`                                     |
| `grep`               | `state.searchText()` / `state.searchFiles()`                               |
| `sed`                | `state.replaceInFile()` / `state.replaceInFiles()`                         |
| `jq`                 | `state.readJson()` / `state.queryJson()` / `state.updateJson()`            |
| `tar`                | `state.createArchive()` / `state.listArchive()` / `state.extractArchive()` |
| `gzip` / `gunzip`    | `state.compressFile()` / `state.decompressFile()`                          |
| `sha256sum` / `file` | `state.hashFile()` / `state.detectFile()`                                  |

## Maybe later

- Stream-oriented transforms inspired by `sort`, `uniq`, `comm`, `cut`, `paste`, `tr`
- Full `rg` CLI parity — file types, ignore controls, multiple roots
- Richer JSON query semantics closer to `jq` filters
- Structured patch helpers covering more of diff / codemod workflows
- A smaller "command" library built on top of `state.*`

## Relationship to other packages

- `@cloudflare/codemode`: executes sandboxed JavaScript that orchestrates tools
- `@cloudflare/shell`: provides filesystem backends and `stateTools()` ToolProvider for codemode
