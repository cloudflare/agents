# @cloudflare/agents-opencode

Library for integrating [OpenCode](https://opencode.ai) into Cloudflare Agents SDK applications. Provides lifecycle management for OpenCode sessions running inside sandbox containers, with streaming observation via AI SDK `UIMessage[]` primitives.

## API Levels

### High-level: `opencodeTask()`

A pre-built AI SDK `tool()` for drop-in use with `streamText`. Handles session lifecycle, provider detection, streaming, and backup automatically.

```typescript
import { opencodeTask } from "@cloudflare/agents-opencode";

const result = streamText({
  model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
  tools: {
    opencode: opencodeTask({
      sandbox: env.Sandbox,
      name: this.name,
      env,
      storage: this.ctx.storage
    })
  }
});
```

### Low-level: `OpenCodeSession`

Full lifecycle control for custom integrations.

```typescript
import { OpenCodeSession } from "@cloudflare/agents-opencode";

const session = new OpenCodeSession(env.Sandbox, agentName);
await session.start(env, storage, {
  userConfig: { model: "anthropic/claude-sonnet-4-20250514" }
});

for await (const snapshot of session.run("Build a TODO app")) {
  // snapshot: OpenCodeRunOutput with UIMessage[], status, files, etc.
}

await session.backup(storage);
```

## Files

| File              | Purpose                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `index.ts`        | Public barrel — exports both API levels + all types                                 |
| `tool.ts`         | `opencodeTask()` — high-level AI SDK tool factory                                   |
| `session.ts`      | `OpenCodeSession` — sandbox lifecycle, OpenCode server/client, one-shot runs        |
| `stream.ts`       | `OpenCodeStreamAccumulator` — translates all OpenCode SSE events into `UIMessage[]` |
| `providers.ts`    | Combinatory provider detection + config resolution with deep-merge                  |
| `backup.ts`       | Backup/restore of sandbox FS + OpenCode session state to DO storage                 |
| `file-watcher.ts` | `FileWatcher` — inotify-based filesystem observation                                |
| `types.ts`        | Shared types, re-exports SDK types (`FileDiff`, `Todo`, `Pty`, etc.)                |

## Provider Detection

All available provider credentials from the environment are detected and merged:

- `ANTHROPIC_API_KEY` → Anthropic (Claude)
- `OPENAI_API_KEY` → OpenAI
- `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_KEY` → Cloudflare Workers AI

The default provider is inferred from `userConfig.model` if set (e.g. `"anthropic/claude-sonnet-4"` → anthropic). Otherwise, the first detected provider is used.

User-provided config (`userConfig`) is recursively deep-merged on top of auto-detected config and takes precedence.

## Event Handling

`OpenCodeStreamAccumulator` handles the full set of OpenCode SSE event types from `@opencode-ai/sdk/v2`:

| Event                                | Handling                                                     |
| ------------------------------------ | ------------------------------------------------------------ |
| `message.part.updated`               | Text parts, tool call lifecycle                              |
| `message.part.delta`                 | Incremental text streaming                                   |
| `message.part.removed`               | Part pruned (compaction)                                     |
| `message.updated`                    | Provider errors on assistant messages                        |
| `message.removed`                    | Message pruned                                               |
| `session.idle`                       | Run completed                                                |
| `session.status`                     | Idle/busy/retry tracking                                     |
| `session.error`                      | Typed error union (ProviderAuth, API, ContextOverflow, etc.) |
| `session.compacted`                  | Marks dirty for UI awareness                                 |
| `session.diff`                       | File-level diffs at end of run                               |
| `permission.asked`                   | Surfaced as error (should not happen with `allow` config)    |
| `question.asked`                     | Surfaced as error (non-interactive mode)                     |
| `file.edited`                        | Tracks files explicitly edited                               |
| `file.watcher.updated`               | File system changes from inotify                             |
| `lsp.client.diagnostics`             | LSP diagnostic events                                        |
| `pty.created/updated/exited/deleted` | Shell process lifecycle                                      |
| `todo.updated`                       | Agent task tracking                                          |

Events not relevant to the sub-conversation (tui._, project._, installation._, server._, mcp._, vcs._, workspace._, worktree._) are silently ignored.

## Dependencies

Peer dependencies:

- `@cloudflare/sandbox` (>=0.8.0) — provides sandbox container management
- `@opencode-ai/sdk` (>=0.1.0) — provides OpenCode client and types
- `ai` (^6.0.0) — AI SDK for tool/message primitives
- `zod` (^4.0.0) — schema validation
