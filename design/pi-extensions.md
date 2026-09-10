# Pi extensions on the Cloudflare pi harness

How the pi harness example (`examples/next/harnesses/pi`) runs pi's own
extension surface — tools, slash commands, flags, blocking UI and file/shell
execution — inside a Durable Object, and what has to change before it becomes
part of `packages/agents`.

## The problem

The harness example runs pi's durable `AgentHarness` as a Lifecycle capability
(see [`rfc-pi-harness-example.md`](./rfc-pi-harness-example.md)). Its only
extension seam was an untyped `configure(hooks)` callback: no `ExtensionAPI`,
no extension-registered tools, no slash commands, no extension UI, no
filesystem or shell. Anything a pi user already wrote against pi's extension
API had to be rewritten as harness hooks, and the agent could not touch files.

The goal is a Cloudflare take on pi's coding agent where pi holds as much of
the code as possible, and where every piece is modular enough to lift into
`packages/agents` once the APIs settle.

## The decision

**Keep `AgentHarness` as the core and vendor pi's extension runtime verbatim.**

Two paths existed. `AgentSession` (pi's coding-agent package) already owns the
whole extension surface, but it cannot bundle for workerd at any entry point —
a 547-file graph reaching `child_process`, `vm`, `net`, `undici`, `jiti` and
`pi-tui` — it runs on the legacy `Agent` rather than `AgentHarness`, and
upstream is moving away from it. Porting `AgentSession` would mean owning a
fork of pi's session layer.

The extension _runtime_ is a different story: `core/extensions/types.ts` has no
imports at all, `runner.ts` has one value import, `wrapper.ts` and the
factory-load half of `loader.ts` are pure, `ExtensionRunner` reads nothing from
`SessionManager` and only three methods from `ModelRegistry`. So the runtime is
copied byte-for-byte from a pinned upstream commit, and the harness supplies
adapters for everything it wants to read: a read-only session view projected
from the durable transcript, a model registry over the example's providers, and
actions over the harness's lanes.

That keeps upstream's semantics (including its error handling and its handler
ordering) and makes re-vendoring a mechanical, verifiable step
(`pnpm vendor:pi:check`) instead of a merge.

## Module map

```
examples/next/harnesses/pi/
  vendor/pi-dev/                     published-shape pi tarballs (dependencies)
  vendor/pi-coding-agent-src/        pi extension runtime, verbatim + stubs + 1 patch
    core/extensions/{types,runner,wrapper,loader}.ts
    core/{messages,diagnostics,source-info,slash-commands,prompt-templates}.ts
    …stubs at upstream import paths (config, theme, event-bus, session-manager, …)
    MANIFEST.json                    upstream, commit, per-file sha256
  src/harness/
    extensions/                      the adapter layer — never imports pi-harness.ts
      runtime.ts                     load order, lifetime, teardown
      hooks-adapter.ts               AgentHarness hooks → extension events
      events-adapter.ts              harness event stream → extension events
      actions.ts                     ExtensionActions over the lanes
      context-actions.ts             ExtensionContextActions / command context
      session-view.ts                ReadonlySessionManager from a lane snapshot
      model-registry.ts              registerProvider onto the example's registry
      tools.ts                       wrapRegisteredTool → AgentHarnessTool
      ui-bridge.ts                   ctx.ui over the WebSocket protocol
      state.ts                       per-lane extension state
    env/
      workspace-execution-env.ts     pi ExecutionEnv over @cloudflare/shell + just-bash
  src/extensions/                    the example's own extensions
```

The one-way dependency matters: `src/harness/extensions/**` and
`src/harness/env/**` know about pi and about small injected ports, never about
`PiHarness`. They lift into `packages/agents` unchanged.

## Hook mapping

Extension events that can change what happens are driven from
`AgentHarness.hooks`, all registered under one hook id (`pi-extensions`):

| Harness hook        | Extension event                          | Effect honoured                          |
| ------------------- | ---------------------------------------- | ---------------------------------------- |
| `before_tool`       | `tool_call`                              | `block` + `reason`, in-place input edits |
| `after_tool`        | `tool_result`                            | content, details, `isError`, usage       |
| `transform_context` | `context`                                | replaced message list (+ system prompt)  |
| `before_run`        | `before_agent_start`                     | system-prompt override, stashed per run  |
| `before_payload`    | `before_provider_request`                | replaced payload                         |
| `before_request`    | `before_provider_headers`                | header mutations                         |
| `after_response`    | `after_provider_response`, `message_end` | replaced final message                   |
| `before_compaction` | `session_before_compact`                 | `cancel` → decline                       |
| `before_navigation` | `session_before_tree`                    | `cancel` → decline                       |
| `submit()`          | `input`                                  | rewritten or swallowed input             |

`input` is emitted in `PiHarness.submit()`, _before_ the durable operation is
enqueued, so an extension that rewrites or handles the input never leaves a
half-accepted operation behind.

## Event mapping

Notification-only events come from the harness's own event stream
(`#dispatchEvent`), so they replay consistently for a recovered operation:

| Harness event                                     | Extension event                                    |
| ------------------------------------------------- | -------------------------------------------------- |
| `run_start` / `run_end`                           | `agent_start` / `agent_end` + `agent_settled`      |
| `turn_start` / `turn_end`                         | `turn_start` / `turn_end`                          |
| `message_start` / `message_delta` / `message_end` | `message_start` / `message_update` / `message_end` |
| `tool_start` / `tool_update` / `tool_end`         | `tool_execution_start` / `_update` / `_end`        |
| `config_update` (model, thinking level)           | `model_select`, `thinking_level_select`            |
| `compaction_end`                                  | `session_compact`, `session_compact_failed`        |
| `navigation_end`                                  | `session_tree`                                     |
| `value_update` (session name)                     | `session_info_changed`                             |
| attach / close                                    | `session_start`, `session_shutdown`                |
| attach                                            | `resources_discover`                               |

A handler that throws does not fail the run: the error is projected as a
`handler_error` event (`kind`, `source`, `message`) and streamed to the client
like any other lane event.

## Unsupported, and why

| Surface                                                                | Status   | Reason                                                                  |
| ---------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `project_trust`                                                        | declined | No project-trust model in a Durable Object; there is no local project   |
| `user_bash`                                                            | declined | No interactive `!` shell — the client submits prompts, not shell lines  |
| `session_before_switch`, `session_before_fork`                         | declined | Sessions are Durable Object identities; a host swaps objects, not files |
| `newSession`, `fork`, `switchSession`, `reload`                        | declined | Same reason; the actions resolve to their "cancelled" defaults          |
| Terminal UI (`setFooter`, `setHeader`, keybindings, `onTerminalInput`) | no-op    | Terminal-only; the client is a browser                                  |
| `registerShortcut`                                                     | no-op    | Terminal-only                                                           |

Extension mode is reported as `"rpc"` with `hasUI: true`, which is the mode
upstream already uses for a non-terminal front end.

## UI and protocol

`ui-bridge.ts` is a port of pi's `rpc-mode.ts` dialog plumbing. Blocking calls
(`select`, `confirm`, `input`, `editor`) become an `extension_ui_request` frame
on the lane's socket and resolve on `extension_ui_response`. Two deliberate
differences from upstream: with zero subscribers the promise resolves to its
default immediately, and a timeout (`uiRequestTimeoutMs`, default 30 s) always
applies. Both exist because a dialog holds a hook — and therefore a durable
operation — open.

Protocol additions: server→client `extension_ui_request`, `commands`, `flags`,
`handler_error`; client→server `extension_ui_response`, `get_commands`,
`set_flag`, `command`.

## Execution environment

Pi's own `read`, `write`, `edit` and `bash` tools take an injectable
`ExecutionEnv` (`FileSystem` + `Shell`, every method returning a `Result`).
`workspace-execution-env.ts` implements it over a `Workspace` from
`@cloudflare/shell` — durable SQLite files with R2 spill — with `bash` running
`just-bash` in-isolate over a snapshot of the workspace, syncing changed files
back when the command exits. The same `Shell` backs `ExtensionAPI.exec`.

Tradeoffs: `just-bash` supports its built-in command set only (no arbitrary
binaries, no network tools), and each invocation snapshots the whole workspace.
Both are contained behind the `ExecutionEnv` port.

## Tradeoffs

- **Vendored source drifts.** Upstream adding a value import silently changes
  what has to be stubbed. `pnpm vendor:pi:check` plus typecheck catch it, but
  re-vendoring is a recurring cost until pi publishes the runtime.
- **Sync actions over an async lane.** `ExtensionActions` is synchronous;
  the lanes are not. Calls are serialized onto a per-lane promise chain over a
  cached read model refreshed per snapshot, so ordering holds but a caller
  cannot observe the result of its own action.
- **Extension commands run out of band** in v1 — no durable operation, so a
  command that is interrupted by an eviction is simply lost.

## Folding into `packages/agents`

1. A published pi release that exports the extension runtime, so
   `vendor/pi-coding-agent-src` can be deleted rather than re-vendored.
2. A public `Tasks` aperture the harness can depend on from the package.
3. Move `src/harness/extensions/**` and `src/harness/env/**` into
   `packages/agents/src/harness/` unchanged — they already avoid importing the
   harness.
4. Replace the `ExtensionAPI` re-export with a structural `PiExtensionApi`
   projection, so the package's public type does not depend on vendored source.
5. Replace the `just-bash` `Shell` with `@cloudflare/workspace` containers
   behind the same `ExecutionEnv` port, keeping the in-isolate shell as the
   miniflare-friendly default.

## Open questions

- **Durable extension commands.** Should a slash command be able to run as a
  durable operation (surviving eviction, replayable) rather than out of band?
  That needs a serializable command invocation, which extension closures are
  not.
- **Provider registration.** `registerProvider` currently writes into the
  process-local model registry, so it is gone after an eviction until the
  extension re-registers. Persisting provider config raises a credentials
  question the example deliberately avoids.
- **Flags over the wire.** Flags are seeded from config and settable from any
  connected client, with no authorization and no persistence. A package version
  needs an owner for flag state and a rule for who may change it.

## History

- [rfc-pi-harness-example.md](./rfc-pi-harness-example.md) — pi `AgentHarness`
  as an example-local Lifecycle capability, and what must land before it
  becomes a package export.
