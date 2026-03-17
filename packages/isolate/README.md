# `@cloudflare/isolate`

Experimental isolate-based state runtime for sandboxed filesystem workflows.

Instead of parsing shell syntax, `@cloudflare/isolate` runs JavaScript inside an isolated Worker and exposes a typed `state` object for operating on a filesystem-like backend. It is designed for agent workflows that need structured state operations, predictable semantics, and coarse host-side filesystem primitives.

## What it is

- A runtime-neutral `StateBackend` interface for filesystem/state operations
- A Workers executor (`@cloudflare/isolate/workers`) that runs code in a dynamic isolate
- Backend adapters for an in-memory filesystem and `agents/experimental/workspace`
- A prebuilt `state` stdlib injected into the sandbox

## What it is not

This is not a bash replacement. It does not parse shell syntax, expose pipes, or emulate POSIX shell behavior. If you need shell compatibility, use `@cloudflare/shell`.

## Example

```ts
import { createMemoryStateBackend } from "@cloudflare/isolate";
import { DynamicStateExecutor } from "@cloudflare/isolate/workers";

const backend = createMemoryStateBackend({
  files: {
    "/src/app.ts": 'export const answer = "foo";\n'
  }
});

const executor = new DynamicStateExecutor({ loader: env.LOADER });

const result = await executor.execute(
  `async () => {
    const text = await state.readFile("/src/app.ts");
    await state.writeFile("/src/app.ts", text.replace("foo", "bar"));
    return await state.readFile("/src/app.ts");
  }`,
  backend
);
```

## Design goals

- Structured state operations instead of shell parsing
- Coarse host-side operations like `glob()` and `diff()` to avoid chatty RPC
- Compatibility with both ephemeral in-memory state and durable `Workspace`
- Secure execution with isolate-level timeouts and outbound network blocking by default

## Current helper surface

The `state` object now exposes two layers:

- Primitive filesystem operations like `readFile()`, `writeFile()`, `mkdir()`, `cp()`, `mv()`, `rm()`, `glob()`, and `diff()`
- Higher-level helpers for common agent workflows:
  - `readJson(path)`
  - `writeJson(path, value, { spaces? })`
  - `queryJson(path, query)`
  - `updateJson(path, operations)`
  - `find(path, options)`
  - `walkTree(path, { maxDepth? })`
  - `summarizeTree(path, { maxDepth? })`
  - `searchText(path, query, { regex?, wholeWord?, caseSensitive? })`
  - `replaceInFile(path, search, replacement, { regex?, wholeWord?, caseSensitive?, contextBefore?, contextAfter?, maxMatches? })`
  - `searchFiles(glob, query, { regex?, wholeWord?, caseSensitive?, contextBefore?, contextAfter?, maxMatches? })`
  - `replaceInFiles(glob, search, replacement, { dryRun?, rollbackOnError?, regex?, wholeWord?, caseSensitive?, contextBefore?, contextAfter?, maxMatches? })`
  - `createArchive(path, sources)`
  - `listArchive(path)`
  - `extractArchive(path, destination)`
  - `compressFile(path, destination?)`
  - `decompressFile(path, destination?)`
  - `hashFile(path, { algorithm? })`
  - `detectFile(path)`
  - `planEdits(instructions)`
  - `applyEditPlan(plan, { dryRun?, rollbackOnError? })`
  - `applyEdits(edits, { dryRun?, rollbackOnError? })`

## Multi-file workflow

The next layer above single-file helpers is batched codebase editing:

```ts
const preview = await state.replaceInFiles("src/**/*.ts", "foo", "bar", {
  dryRun: true
});

const plan = await state.planEdits([
  {
    kind: "replace",
    path: "/src/app.ts",
    search: "foo",
    replacement: "bar"
  },
  {
    kind: "writeJson",
    path: "/src/config.json",
    value: { enabled: true }
  }
]);

await state.applyEditPlan(plan);

const applied = await state.applyEdits([
  {
    path: "/src/generated.ts",
    content: "export const generated = true;\n"
  }
]);
```

These operations are host-side coarse calls. That means the isolate can
ask for a whole-tree search or replacement in one RPC call instead of
looping over many `readFile()` and `writeFile()` operations.

`planEdits()` adds a higher-level layer on top of raw writes. Instead of
immediately constructing `{ path, content }` edits, the isolate can
describe intent:

- `"write"` for direct file writes
- `"replace"` for targeted in-file replacements
- `"writeJson"` for structured JSON output

The result is a concrete edit plan with fully rendered content and diffs,
which can then be passed to `applyEditPlan()`.

By default, batched writes are transactional at the helper level:

- `replaceInFiles()` rolls back earlier writes if a later write fails
- `applyEdits()` rolls back earlier writes if a later write fails
- Set `rollbackOnError: false` to allow partial progress when that is more useful than all-or-nothing behavior

## Shell feature map

This package is a fresh take on the problem space covered by
`@cloudflare/shell`, so it helps to keep an explicit list of which
features we want to preserve and which ones we do not.

### Take from `@cloudflare/shell`

- Virtual filesystem semantics: files, directories, symlinks, relative path resolution, and stat-style metadata
- Coarse filesystem operations: `mkdir`, `rm`, `cp`, `mv`, `readlink`, `realpath`, `glob`, `diff`
- Structured helpers for common shell workflows: JSON read/write, text search, in-file replacement, and batched multi-file edits
- Structured edit planning so batched changes can carry intent and previews before apply
- Structured filesystem queries and summaries inspired by `find`, `tree`, `du`, and `file`
- Archive, compression, and hashing helpers inspired by `tar`, `gzip`, and checksum commands
- Safe sandbox defaults: no host filesystem access, no outbound network by default, explicit execution limits
- Runtime portability: support in-memory state and durable `Workspace` backends
- Extensibility: a small host-controlled capability surface instead of ambient runtime access

### Do not take from `@cloudflare/shell`

- Bash parsing and quoting rules
- Pipes, redirects, heredocs, and stdout/stderr-oriented composition as the primary programming model
- Shell variables, parameter expansion, command substitution, arrays, aliases, and shell options
- POSIX compatibility as a design goal
- The 80+ built-in command surface as a one-to-one requirement for this package

### Maybe later

- Stream-oriented transforms inspired by `sort`, `uniq`, `comm`, `join`, `cut`, `paste`, and `tr`
- More advanced search modes inspired by full `rg` CLI parity, including roots, file types, and ignore controls
- Richer JSON query/update semantics closer to `jq` filters
- Structured patch helpers that cover more of diff or codemod workflows
- An adapter layer that lets `@cloudflare/shell` consume a `StateBackend`
- A smaller "command" library built on top of `state.*`, if that proves more ergonomic than raw method calls

### Rough command translation

The current mental model is not "port every shell command", but
"replace the common ones with typed state operations":

- `cat` -> `state.readFile()`
- `jq` for simple file-backed JSON -> `state.readJson()` and `state.writeJson()`
- `jq` for path-based JSON access -> `state.queryJson()` and `state.updateJson()`
- `find` -> `state.find()`
- `tree` or `du` -> `state.walkTree()` and `state.summarizeTree()`
- `grep` on a single file -> `state.searchText()`
- `grep` or `rg` across a tree -> `state.searchFiles()`
- `sed` for simple in-file replacement -> `state.replaceInFile()`
- `sed` across many files -> `state.replaceInFiles()`
- `tar` -> `state.createArchive()`, `state.listArchive()`, and `state.extractArchive()`
- `gzip` / `gunzip` -> `state.compressFile()` and `state.decompressFile()`
- `sha256sum` / `file` -> `state.hashFile()` and `state.detectFile()`
- codemod-style planned edits -> `state.planEdits()` and `state.applyEditPlan()`
- `echo foo > file` -> `state.writeFile()`
- `mkdir` -> `state.mkdir()`
- `ls` or `find` -> `state.readdir()` or `state.glob()`
- `cp` -> `state.cp()` or `state.copyTree()`
- `mv` -> `state.mv()` or `state.moveTree()`
- `rm` -> `state.rm()` or `state.removeTree()`
- `diff` -> `state.diff()` or `state.diffContent()`

Anything that depends on shell syntax rather than filesystem state is
explicitly out of scope for v0.

## Relationship to other packages

- `@cloudflare/codemode`: executes sandboxed JavaScript that orchestrates tools
- `@cloudflare/isolate`: executes sandboxed JavaScript that operates on a state backend
- `@cloudflare/shell`: runs shell syntax against a virtual filesystem

## Status

Experimental. Expect breaking changes while the API surface is still settling.
