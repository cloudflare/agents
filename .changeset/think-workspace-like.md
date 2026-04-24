---
"@cloudflare/think": patch
---

Introduce `WorkspaceLike` — type the `this.workspace` field as the minimum surface Think actually uses instead of the concrete `Workspace` class.

`Think`'s `workspace` is now typed as `WorkspaceLike` (`Pick<Workspace, "readFile" | "writeFile" | "readDir" | "rm" | "glob" | "mkdir" | "stat">`) rather than `Workspace`. `createWorkspaceTools()` likewise accepts any `WorkspaceLike`. The default runtime value is unchanged — a full `Workspace` backed by the DO's SQLite — so the vast majority of consumers need no changes.

This unlocks patterns like a shared workspace across multiple agents: a child agent can override `workspace` with a proxy that forwards each call to a parent DO via RPC, and the rest of Think's workspace-aware code (the builtin tools, lifecycle hooks) keeps working without cast gymnastics. See `examples/assistant` for the cross-chat shared workspace built on this.

Consumers who use `createWorkspaceStateBackend(workspace)` from `@cloudflare/shell` (codemode's `state.*` API) still need a concrete `Workspace` — that helper reaches for more of the filesystem surface than `WorkspaceLike` covers.
