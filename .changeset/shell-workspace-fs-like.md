---
"@cloudflare/shell": patch
---

Introduce `WorkspaceFsLike` — the minimum `Workspace` surface required by `WorkspaceFileSystem` and `createWorkspaceStateBackend`.

`WorkspaceFileSystem`'s constructor and `createWorkspaceStateBackend`'s parameter both now accept any `WorkspaceFsLike` (a `Pick<Workspace, …>` of the 16 filesystem methods the adapter reaches for) rather than a concrete `Workspace`. Non-breaking — `Workspace` still satisfies `WorkspaceFsLike` so every existing call site keeps working without changes.

This unlocks wrapping a real `Workspace` behind your own layer — most commonly a cross-DO proxy that forwards each call to a parent agent's workspace over RPC — and still using it as the storage for codemode's `state.*` sandbox API via `createWorkspaceStateBackend`. See `examples/assistant` for the end-to-end pattern with `SharedWorkspace`.
