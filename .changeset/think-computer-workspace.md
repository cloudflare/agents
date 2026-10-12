---
"@cloudflare/think": minor
---

Think's `workspace` is now a `Workspace` from `@cloudflare/computer`. By default Think creates one on the agent's own storage, with no execution backends. To add backends, mounts, or git, override `workspace` with `new Workspace({ storage: this.ctx.storage, ... })`. For a Workspace another Durable Object owns, use `lazyWorkspace(async () => getWorkspace(stub))`.

Breaking changes:

- `@cloudflare/computer` is a new peer dependency. Install it alongside `@cloudflare/think`.
- `Workspace` is no longer re-exported. Import it from `@cloudflare/computer`.
- `WorkspaceLike` is replaced by `ThinkWorkspace`, which needs only `workspace.fs`.
- Think writes its own files under `/workspace`. Evicted media goes to `/workspace/attachments/evicted/`, and the fetch tool saves responses to `/workspace/fetched/`.
- `createExecuteTool(this)` no longer builds `state.*` from the agent's workspace. Pass `state` explicitly.
- Media eviction and skill projection now work with every workspace. The `writeFileBytes` checks and their warnings are gone.

Files a `@cloudflare/shell` Workspace stored are not moved. See [Migrating to `@cloudflare/computer`](https://github.com/cloudflare/agents/blob/main/docs/shell/migrating-to-computer.md).
