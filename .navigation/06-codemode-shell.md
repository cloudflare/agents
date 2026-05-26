# 06 — Code Execution and the Virtual Filesystem

Two packages work together to let an LLM write and run code safely:

- **`@cloudflare/shell`** (`packages/shell/`) — a durable virtual filesystem backed by SQLite (with optional R2 spillover for large files) and git integration.
- **`@cloudflare/codemode`** (`packages/codemode/`) — takes LLM-generated JavaScript, runs it in a sandbox, and gives it access to tools.

The typical flow: the LLM calls the `execute` tool → codemode runs the generated code in a Workers sandbox → the code calls workspace tools to read/write files → results flow back to the LLM.

---

## Virtual filesystem (`packages/shell/`)

### Core types (`src/backend.ts`)

[`StateCapabilities`, `StateStat`, `StateDirent`, `StateSearchOptions`](../packages/shell/src/backend.ts#L1-L100) — the type vocabulary for file operations. `StateSearchOptions` controls text search behaviour: case sensitivity, regex, whole-word matching, lines of context.

### `FileSystemStateBackend` (`src/memory.ts`)

[FileSystemStateBackend — class setup, readFile(), writeFile(), stat(), and JSON helpers](../packages/shell/src/memory.ts#L1-L200) and [FileSystemStateBackend — searchText(), searchFiles(), replaceInFile(), rm(), cp(), mv(), and symlink()](../packages/shell/src/memory.ts#L200-L400) and [FileSystemStateBackend — planEdits(), applyEdits(), applyEditPlan(), and private helpers](../packages/shell/src/memory.ts#L400-L541) — the concrete `StateBackend` implementation. Wraps any `FileSystem` (pass `InMemoryFs` for ephemeral state or `WorkspaceFileSystem` for durable storage). Delegates all low-level I/O to the underlying `FileSystem` and adds higher-level operations: JSON read/write/query/update, text search and replace across files, atomic edit plans (`planEdits`/`applyEdits`), and archive operations via helpers in `extras.ts`.

### Backend type vocabulary (`src/backend.ts`)

[backend.ts — StateStat, StateDirent, operation options, and StateSearchOptions](../packages/shell/src/backend.ts#L1-L150) and [backend.ts — StateArchiveEntry, StateFileDetection, StateFindOptions, and StateHashOptions](../packages/shell/src/backend.ts#L150-L290) and [backend.ts — StateJsonUpdateOperation, StateTreeNode, StateTreeOptions, and remaining types](../packages/shell/src/backend.ts#L290-L420) — the complete vocabulary of types for file operations in `@cloudflare/shell`. Beyond the basics already mentioned, this file defines: `StateArchiveEntry` (for zip/tar operations), `StateFileDetection` (MIME type inference), `StateFindOptions` (for `find`-style glob traversal), `StateHashOptions` (for computing file hashes), `StateJsonUpdateOperation` (for atomic JSON field updates), `StateTreeNode` and `StateTreeOptions` (for directory tree summaries), and the full set of options for each operation.

### The `Workspace` class (`src/filesystem.ts`)

[Module doc, `SqlBackend` interface, `SqlSource` type, and `WorkspaceOptions`](../packages/shell/src/filesystem.ts#L1-L200) — the entry point for the `Workspace` class. Defines `SqlBackend` (the two-method `query`/`run` interface), `SqlSource` (the auto-detect union of `SqlStorage | D1Database | SqlBackend`), `WorkspaceOptions` (SQL backend, namespace, R2 bucket, inline threshold, `onChange` hook), and the public `FileInfo`/`FileStat`/`WorkspaceFsLike` types used throughout the package.

[`SqlBackend` interface](../packages/shell/src/filesystem.ts#L37-L43) — the two-method interface (`query()` and `run()`) that any SQL-like storage must implement to back the workspace.

[`DEFAULT_INLINE_THRESHOLD`](../packages/shell/src/filesystem.ts#L184-L200) — files larger than 1.5 MB are spilled to R2 instead of stored inline in SQLite. The database row stores the R2 key; reads are transparent.

[Workspace — constructor, ensureInit(), R2 helpers, symlink resolution, and symlink API](../packages/shell/src/filesystem.ts#L200-L450) and [Workspace — stat(), lstat(), readFile(), and readFileBytes()](../packages/shell/src/filesystem.ts#L450-L700) and [Workspace — writeFileBytes(), writeFile(), and readFileStream()](../packages/shell/src/filesystem.ts#L700-L900) — the core file operations. The constructor validates namespace, registers the config in a `WeakMap` (prevents conflicting R2/threshold settings on the same SQL source), and lazily creates the SQLite table via `ensureInit()`. `readFile()`/`readFileBytes()` check whether a row's `storage_backend` is `'r2'` and fetch from R2 if so; `writeFileBytes()` spills to R2 when the file exceeds `DEFAULT_INLINE_THRESHOLD` (1.5 MB).

[Workspace — deleteFile(), fileExists(), exists(), and readDir()](../packages/shell/src/filesystem.ts#L900-L1100) — secondary read/write helpers. `deleteFile()` cleans up R2 objects before removing the SQLite row. `readDir()` queries children by `parent_path` with optional `limit`/`offset` pagination. `glob()` uses a SQL `LIKE` prefix narrowing followed by a `RegExp` filter built by the local `globToRegex()`.

[Workspace — mkdir(), rm(), and cp()](../packages/shell/src/filesystem.ts#L1100-L1270) — directory and deletion primitives. `mkdir()` creates parent directories recursively (guarded against infinite loops by `MAX_MKDIR_DEPTH`). `rm()` deletes R2 objects for any file stored externally before removing the SQL row; recursive removal calls `deleteDescendants()` which batches the R2 deletes. `cp()` handles symlinks (re-creates the link rather than copying the target), directories (recursive), and files (streams bytes through `readFileBytes`/`writeFileBytes`).

[Workspace — mv()](../packages/shell/src/filesystem.ts#L1264-L1370) and [Workspace — diff(), diffContent(), getWorkspaceInfo(), and internal helpers](../packages/shell/src/filesystem.ts#L1370-L1541) — `mv()` has a fast path for R2-backed files: it copies the R2 object to a new key, deletes the old key, then updates the SQL row in one statement (avoids a full data round-trip). `diff()` and `diffContent()` produce unified diffs between two files or between a file and a proposed new content string. `getWorkspaceInfo()` returns aggregate counts and total byte usage via a single SQL aggregate query. `deleteDescendants()` uses a `LIKE '%'` pattern to bulk-delete all descendants of a directory, including their R2 objects.

[Base64 helpers, path utilities, `globToRegex()`, `unifiedDiff()`, and `myersDiff()`](../packages/shell/src/filesystem.ts#L1541-L1843) — private module-level helpers used throughout the class. `bytesToBase64`/`base64ToBytes` serialize binary file content for inline SQLite storage. `normalizePath()` resolves `.` and `..` segments and enforces `MAX_PATH_LENGTH`. `globToRegex()` converts glob patterns to `RegExp` for post-filter after the SQL `LIKE` prefix scan. `unifiedDiff()` and `myersDiff()` implement the Myers O(n+m) diff algorithm used by `diff()` and `diffContent()`.

### Filesystem abstraction (`src/fs/`)

[`FileSystem` interface in `src/fs/interface.ts`](../packages/shell/src/fs/interface.ts#L1-L75) — the common interface shared by `WorkspaceFileSystem` (SQLite-backed adapter) and `InMemoryFs` (test/ephemeral). Methods: `readFile`, `writeFile`, `stat`, `lstat`, `mkdir`, `readdir`, `readdirWithFileTypes`, `rm`, `cp`, `mv`, `symlink`, `readlink`, `realpath`, `glob`. Callers throw `ENOENT` errors (never return null) — the key semantic difference from `Workspace`'s nullable returns.

[`InMemoryFs` class](../packages/shell/src/fs/in-memory-fs.ts#L1-L100) — a pure in-memory implementation backed by a rooted tree of `Map`s (not a flat hash). Used in tests and for temporary scratch workspaces that don't need persistence.

### Helpers (`src/helpers.ts`)

[`createGlobMatcher(pattern)` function](../packages/shell/src/helpers.ts#L54-L104) — converts a glob pattern to a `RegExp`. Handles `**`, `*`, `?`, and `[...]` character classes correctly, including the tricky `**/` prefix case.

[`searchTextContent(content, options)` function](../packages/shell/src/helpers.ts#L145-L201) — line-by-line text search with context lines. Returns an array of `StateTextMatch` objects: `{line, column, match, lineText, beforeLines?, afterLines?}`. Supports regex, case-insensitive, whole-word, and `maxMatches` via `createTextMatcher()`.

[`replaceTextContent(content, search, replacement)` function](../packages/shell/src/helpers.ts#L203-L220) — search-and-replace using the same `createTextMatcher()` regex builder as `searchTextContent`. Returns `{replaced: number, content: string}` — the replacement count and the updated string. Used by `replaceInFile()` and `replaceInFiles()` in `FileSystemStateBackend`.

[`diffContent(a, b)` function](../packages/shell/src/helpers.ts#L37-L52) — unified diff of two text strings. Uses Myers diff algorithm (implemented at the bottom of the file). Capped at 10 000 lines to avoid runaway computation.

[`myersDiff()` algorithm](../packages/shell/src/helpers.ts#L506-L582) — the classic O(n+m) diff algorithm. Worth knowing it's here if you ever need to understand how edits are represented.

[helpers.ts — collectFileSearchResults(), collectFileReplaceResults(), applyTextEdits(), and planTextEdits()](../packages/shell/src/helpers.ts#L220-L506) — the batch-operation helpers used by `FileSystemStateBackend`. `collectFileSearchResults` and `collectFileReplaceResults` fan out single-file operations across a list of glob-matched paths and roll back on error when `rollbackOnError` is set. `applyTextEdits` writes a list of `{path, content}` edits atomically (with rollback). `planTextEdits` does the same dry-run computation that `StateBackend.planEdits` exposes to callers. The section ends with `createTextMatcher()` (builds the regex from `StateSearchOptions`) and `escapeRegExp()`.

### Git integration (`src/git/`)

[`createGit(filesystem, defaultDir)` factory](../packages/shell/src/git/index.ts#L52-L200) — binds the `isomorphic-git` library to a `FileSystem` instance. Returns an object with `clone`, `status`, `add`, `rm`, `commit`, `log`, `branch`, `checkout`, and `fetch` operations.

[`createGitFs(filesystem)` adapter](../packages/shell/src/git/fs-adapter.ts#L1-L183) — adapts the custom `FileSystem` interface to the callback-style `fs` object that `isomorphic-git` expects. The bridge between the two worlds.

---

## Code execution (`packages/codemode/`)

### Executor abstraction (`src/executor.ts`)

[`Executor` interface](../packages/codemode/src/executor.ts#L1-L50) — the single abstraction that hides *how* code runs. Implementations include a Cloudflare Workers sandbox, a browser `<iframe>` sandbox, and (outside Workers) Node.js `vm`. All the higher-level tooling is written against this interface.

[Binary codec helpers](../packages/codemode/src/executor.ts#L24-L139) — base64 encode/decode utilities for `Uint8Array`, `ArrayBuffer`, and `ArrayBufferView`. Needed because structured-clone doesn't cross the sandbox boundary; binary data is base64-encoded before transfer and decoded on the other side. The codec string (`SANDBOX_CODEC`) is injected into the sandbox at startup.

### Workers sandbox executor (`src/executor.ts` continued)

[`ToolProvider` interface](../packages/codemode/src/executor.ts#L177-L195) — the shape of a tool provider as seen by the executor: a `name` (namespace prefix in the sandbox), and a `tools` record (name → function). Providers are available inside generated code as `namespace.toolName(args)`.

[`ToolDispatcher` class](../packages/codemode/src/executor.ts#L195-L221) — a `RpcTarget` subclass that dispatches tool calls from the sandbox Worker to the host Worker. The host holds the real tool implementations; the sandbox calls them over RPC via `ToolDispatcher`.

[`DynamicWorkerExecutorOptions` and `DynamicWorkerExecutor` class](../packages/codemode/src/executor.ts#L221-L431) — the Cloudflare Workers implementation of `Executor`. Creates a new Worker binding for each execution using Worker Loader. The generated code runs in a completely separate Durable Object instance with no access to the host's state. Results are passed back via RPC.

### JSON Schema → TypeScript types (`src/json-schema-types.ts`)

[`generateTypesFromJsonSchema(schema)` function](../packages/codemode/src/json-schema-types.ts#L1-L50) — converts a JSON Schema object to JSDoc/TypeScript type declarations. These are injected into the sandbox as inline type comments so the LLM's generated code is properly typed without a separate compilation step.

[jsonSchemaToTypeString() — primitive, array, and object type handling](../packages/codemode/src/json-schema-types.ts#L50-L220) and [jsonSchemaToTypeString() — oneOf/anyOf/allOf unions, $ref resolution, and nullable](../packages/codemode/src/json-schema-types.ts#L220-L397) — the full recursive implementation: handles `$ref` resolution, `oneOf`/`anyOf`/`allOf` unions, `nullable`, array and object types, and nested schemas. The output is valid TypeScript that can be pasted directly into the sandbox's type declarations.

### MCP integration (`src/mcp.ts`)

[`truncateResponse()` function](../packages/codemode/src/mcp.ts#L25-L39) — limits tool output to ~6 000 tokens (~24 KB) before returning it to the LLM. Long outputs are truncated with a notice.

[`unwrapMcpResult()` function](../packages/codemode/src/mcp.ts#L70-L100) — converts the MCP SDK's result format (an envelope with `content` array) to a plain value the executor can work with.

[`createMcpCodeTool()` and MCP server setup](../packages/codemode/src/mcp.ts#L100-L300) — builds an MCP `Server` instance that exposes the `execute_code` tool. The server's tool handler runs generated code in the configured executor and returns the result as MCP tool output.

[`CodemodeServer` class](../packages/codemode/src/mcp.ts#L300-L551) — a higher-level wrapper that handles the full MCP server lifecycle: initialise, register tools from descriptors, handle requests, and shut down. Used by `createMcpHandler()` in `packages/agents/src/mcp/handler.ts`.

### Browser iframe sandbox (`src/iframe-executor.ts`)

[`IframeSandboxExecutor` class](../packages/codemode/src/iframe-executor.ts#L1-L100) — runs generated code inside a `<iframe sandbox="allow-scripts">` in the browser. No network, no DOM access beyond `postMessage`. The sandbox's CSP is `"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval';"`. Timeout: 30 seconds.

[`buildSrcdoc()` method](../packages/codemode/src/iframe-executor.ts#L49-L64) — constructs the `srcdoc` attribute: an HTML document that includes the binary codec, the tool dispatch loop, and the user's code. Tools are dispatched as structured `postMessage` calls.

### Browser code tool descriptor (`src/browser-tool.ts`)

[`createBrowserCodeTool()` function](../packages/codemode/src/browser-tool.ts#L1-L100) — creates a tool descriptor (name, description, input/output schemas) for the browser sandbox. The description auto-includes the TypeScript type definitions generated from the tool schemas, so the LLM knows the types it can use in its generated code.

[`createBrowserCodeTool()` implementation details](../packages/codemode/src/browser-tool.ts#L100-L217) — how the tool descriptor is assembled: collecting tool names from both array and object forms, building the input schema (just `{code: string}`), generating the JSDoc types via `generateTypesFromJsonSchema()`, and wrapping everything in `BrowserCodeToolDescriptor`. The default description embeds the type definitions inline so the LLM can code against typed tool APIs.

### The `tool()` builder (`src/tool.ts`)

[`createCodeTool(options)` function](../packages/codemode/src/tool.ts#L1-L123) — the main public API for creating a code execution tool for the AI SDK. Takes an `Executor`, a set of `ToolDescriptors`, and optional configuration. Returns a single AI SDK `Tool` that the LLM can call with a JavaScript code string.

### Tool descriptors and type generation (`src/tool-types.ts`)

[`ToolDescriptor` interface and `generateTypes()` function](../packages/codemode/src/tool-types.ts#L1-L254) — `ToolDescriptor` is the codemode-internal representation of a tool: name, description, Zod/JSON Schema input, optional output schema, optional `execute` function. `generateTypes()` takes a `ToolDescriptors` map and returns TypeScript type declarations for every tool, which are injected into the sandbox so the LLM's code is typed.

### Shared configuration (`src/shared.ts`, `src/executor-types.ts`)

[`CreateCodeToolOptions`, `CodeInput`, `CodeOutput`, `normalizeProviders()`](../packages/codemode/src/shared.ts#L1-L55) — the canonical options type for codemode tools, the input/output shapes (just a `code` string in, arbitrary `result` out), and the helper that normalises an array or keyed object of providers into the internal `ResolvedProvider[]` format.

[`Executor`, `ExecuteResult`, `ResolvedProvider` interfaces in `executor-types.ts`](../packages/codemode/src/executor-types.ts#L1-L35) — the three core contracts of the execution layer. `Executor.execute(code, providers)` is all any sandbox needs to implement.

### Code runner (`src/run-code.ts`)

[`runCode(code, executor, providers)` function](../packages/codemode/src/run-code.ts#L1-L27) — the thin glue between the tool layer and the executor abstraction. Validates the code string, calls `executor.execute()`, and unwraps the `ExecuteResult`.

### Module resolution (`src/resolve.ts`)

[`filterTools(tools, patterns)` function in `resolve.ts`](../packages/codemode/src/resolve.ts#L1-L69) — filters a `ToolSet` to only include tools whose names match a glob pattern list. Used when you want to expose only a subset of your tools to the sandbox.

### Utilities (`src/utils.ts`, `src/normalize.ts`, `src/messages.ts`)

[`sanitizeToolName()` and `toPascalCase()` in `utils.ts`](../packages/codemode/src/utils.ts#L1-L162) — name normalisation for tools: strips invalid identifier characters, converts to PascalCase for type generation. Also includes `escapeJsDoc()` for embedding descriptions safely in JSDoc comments.

[`normalizeInput()` and schema helpers in `normalize.ts`](../packages/codemode/src/normalize.ts#L1-L82) — normalises tool input between Zod schemas and raw JSON Schema 7. Both forms are accepted at the API boundary; this module converts them to a canonical form.

[`buildMessages()` and conversation helpers in `messages.ts`](../packages/codemode/src/messages.ts#L1-L104) — utility functions for building the message array passed to `streamText()` in the code execution loop. Handles the multi-turn conversation pattern where the LLM can iterate on its code based on execution results.

### Browser executor entry point (`src/browser.ts`, `src/index.ts`)

[Browser exports in `src/browser.ts`](../packages/codemode/src/browser.ts#L1-L21) — re-exports `IframeSandboxExecutor` and `createBrowserCodeTool()` as the browser-specific entry point. Only import this on the client side; it references browser APIs.

[Main package exports in `src/index.ts`](../packages/codemode/src/index.ts#L1-L19) — the package's main entry point. Re-exports everything from the tool layer, executor types, and MCP integration.

### Iframe sandbox executor (`src/iframe-executor.ts` continued)

[`IframeSandboxExecutor` implementation](../packages/codemode/src/iframe-executor.ts#L100-L329) — the `execute()` method: creates the iframe, waits for a `ready` message, sends the code and provider function list, waits for the result `postMessage`, then destroys the iframe. A timeout kills the iframe if no response arrives in 30 seconds. The executor is single-use per call; a new iframe is created for each `execute()` invocation.

### Iframe runtime (`src/iframe-runtime.ts`)

[`iframeSandboxRuntimeMain()` function](../packages/codemode/src/iframe-runtime.ts#L1-L193) — the self-contained runtime that runs *inside* the sandboxed iframe. This function is serialised via `.toString()` and injected into the iframe's `srcdoc`. It sets up a `postMessage` dispatch loop, makes tools callable as namespaced functions, captures console logs, and returns results. Since it runs in the iframe, it cannot import anything — it is fully self-contained.

### TanStack AI integration (`src/tanstack-ai.ts`)

[tanstack-ai.ts — `generateTypes()` for TanStack AI tools and `tanstackTools()` factory](../packages/codemode/src/tanstack-ai.ts#L1-L160) and [tanstack-ai.ts — `createCodeTool()` returning a `ServerTool` and `generateTypesFromRecord()` fallback](../packages/codemode/src/tanstack-ai.ts#L160-L310) — TanStack AI integration for codemode. `generateTypes()` converts an array of `TanStackTool` objects (which may use Zod, ArkType, or plain JSON Schema) into TypeScript type declarations via `convertSchemaToJsonSchema()`. `tanstackTools()` wraps a `TanStackTool[]` into a `ToolProvider` for use with `createCodeTool`. `createCodeTool()` returns a single `ServerTool` (TanStack AI's server-side tool format) rather than an AI SDK tool — use this module's entry point when your agent uses `@tanstack/ai`'s `chat()` adapter.

---

## Extended shell utilities

### The `Workspace` FileSystem adapter (`src/workspace.ts`)

[`WorkspaceFileSystem` class and `createWorkspaceStateBackend()` factory](../packages/shell/src/workspace.ts#L1-L216) — `WorkspaceFileSystem` adapts a `WorkspaceFsLike` (the concrete `Workspace` or a cross-DO proxy) to the `FileSystem` interface. The key conversion: `Workspace` returns `null` on missing files while `FileSystem` contracts require `ENOENT` errors. `createWorkspaceStateBackend(workspace)` is a convenience factory that composes `WorkspaceFileSystem` with `FileSystemStateBackend` to produce a `StateBackend` suitable for codemode's `state.*` sandbox API.

### Extras — advanced file operations (`src/extras.ts`)

[`queryJsonValue(value, query)` and JSON path helpers](../packages/shell/src/extras.ts#L1-L200) — JSONPath-style querying into nested objects. Used by workspace tools that need to read or update specific fields in JSON files without rewriting them entirely.

[extras.ts — extractTar(), TarInputEntry type, and parseJsonPath()/setJsonPathValue()/deleteJsonPathValue()](../packages/shell/src/extras.ts#L200-L430) and [extras.ts — matchesFind(), transformBytes(), concatBytes(), createTarHeader(), parseTar(), and file-type utilities](../packages/shell/src/extras.ts#L430-L629) — the middle section contains the JSON path mutation helpers (`parseJsonPath` tokenises dot/bracket notation; `setJsonPathValue`/`deleteJsonPathValue` mutate a cloned object in-place). The lower section is the raw tar encoding/decoding engine: `createTarHeader()` builds the 512-byte POSIX ustar block, `parseTar()` reads it back, and `transformBytes()` streams data through `CompressionStream`/`DecompressionStream` for the gzip helpers. `detectFile()` and `hashBytes()` round out the utility exports.

### Prompt generation (`src/prompt.ts`)

[prompt.ts — STATE_TYPES: primitive types, options, and search type declarations](../packages/shell/src/prompt.ts#L1-L175) and [prompt.ts — STATE_TYPES: JSON, archive, tree types and STATE_SYSTEM_PROMPT template](../packages/shell/src/prompt.ts#L175-L341) — TypeScript type declarations for the `state` API that is injected into every sandbox execution. Export `STATE_TYPES` into your system prompt so the LLM knows the exact types it can use when writing code that calls the workspace filesystem. The `STATE_SYSTEM_PROMPT` template includes instructions for how to use the state API.

### Workers entry point (`src/workers.ts`)

[`stateTools(workspace)` and `stateToolsFromBackend(backend)` in `src/workers.ts`](../packages/shell/src/workers.ts#L1-L67) — convenience functions that create a codemode `ToolProvider` exposing all `StateBackend` methods as `state.*` inside a sandbox. `stateTools(workspace)` is the common path: it wraps a `Workspace` in `createWorkspaceStateBackend()` then registers every method from `STATE_METHOD_NAMES`. The provider includes `STATE_TYPES` as its type declarations so the LLM's generated code is fully typed.

### FileSystem primitives (`src/fs/`)

[`FileSystem` interface in `src/fs/interface.ts`](../packages/shell/src/fs/interface.ts#L1-L130) — the protocol that both `WorkspaceFileSystem` and `InMemoryFs` implement. Covers: `readFile`, `readFileBytes`, `writeFile`, `writeFileBytes`, `stat`, `lstat`, `mkdir`, `readdir`, `rm`, `cp`, `mv`, `symlink`, `glob`, and directory listing.

[InMemoryFs — class setup, readFile(), writeFile(), stat(), and lstat()](../packages/shell/src/fs/in-memory-fs.ts#L1-L250) and [InMemoryFs — mkdir(), readdir(), rm(), cp(), mv(), and symlink()](../packages/shell/src/fs/in-memory-fs.ts#L250-L500) and [InMemoryFs — glob(), tree walking, and internal node structure](../packages/shell/src/fs/in-memory-fs.ts#L500-L745) — a pure in-memory implementation backed by a `Map`. No SQLite, no R2. Used in tests, in the browser sandbox, and anywhere you need a throwaway filesystem. Supports all the same operations as `WorkspaceFileSystem` including symlinks and recursive operations.

[File encoding utilities in `src/fs/encoding.ts`](../packages/shell/src/fs/encoding.ts#L1-L93) — `encodeText(s)` / `decodeText(bytes)` UTF-8 converters, and helpers for detecting binary vs. text files. Used throughout the read/write path to handle binary files transparently.

[Path utilities in `src/fs/path-utils.ts`](../packages/shell/src/fs/path-utils.ts#L1-L71) — `normalizePath()`, `joinPath()`, `dirname()`, `basename()` that work identically in Workers and Node. Avoids the `path` module which is not available in the Workers runtime.

### Git operations (`src/git/`)

[createGit() — clone(), status(), add(), commit(), and push()](../packages/shell/src/git/index.ts#L1-L200) and [createGit() — pull(), log(), diff(), branch(), checkout(), and GitStatusEntry types](../packages/shell/src/git/index.ts#L200-L407) — the main git integration. Wraps `isomorphic-git` to provide a high-level API: `clone(url)`, `status()`, `add(path)`, `commit(message)`, `push()`, `pull()`, `log()`, `diff()`, `branch()`, `checkout()`. Returns `GitStatusEntry[]` (file path, working-tree status, index status) and `GitLogEntry[]` (hash, message, author, date).

[`createGitFs(filesystem)` adapter in `src/git/fs-adapter.ts`](../packages/shell/src/git/fs-adapter.ts#L1-L183) — adapts the `FileSystem` interface to the shape `isomorphic-git` expects. `isomorphic-git` uses a custom `fs` object with a specific callback-style API; this adapter bridges the gap.

[Git provider in `src/git/provider.ts`](../packages/shell/src/git/provider.ts#L1-L175) — a higher-level `GitProvider` class that manages authentication (token injection), remote URL normalisation, and error handling around the raw `createGit()` operations.

### Package index (`src/index.ts`)

[Shell package exports in `src/index.ts`](../packages/shell/src/index.ts#L1-L32) — the public surface of `@cloudflare/shell`: `Workspace`, `InMemoryFs`, `WorkspaceFileSystem`, `createGit`, and all their associated types.
