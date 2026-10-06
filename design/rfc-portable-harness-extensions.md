Status: proposed

# One extension format for every harness

## The problem

We are building four harnesses: `PiHarness` (on main), `OpenCodeHarness`
(#2483), `ThinkHarness` (#2396) and a container harness (#2285 and the
pi-shaped follow-up). Each has its own way to extend it:

| Harness           | Native extension                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `PiHarness`       | pi-durable `Extension`: a named bundle of tools, prompt sections, task hooks and wraps in a `Registry` |
| `OpenCodeHarness` | OpenCode 2 plugins (`@opencode/plugin`): `setup(ctx)` registering domain transforms and hooks          |
| `ThinkHarness`    | none; one `hooks` object plus `tools()` and `system()` functions on its options                        |
| Container         | whatever the engine in the container has (Claude Code hooks, MCP); host tools proxied to the DO        |

Someone who writes a guard that refuses `rm -rf`, an MCP bridge, or a web
search tool has to write it once per harness. We already pay this cost
inside the SDK: `browserTool` ships three adapters (`browser/ai-sdk.ts`,
`browser/tanstack-ai.ts`, and `browser/pi.ts` in #2484).

We want one top-level extension format, so switching harness does not mean
rewriting extensions. Native extensions stay. The portable format covers
what every harness can honour, and says loudly when a harness cannot.

An earlier attempt (#2229, closed) vendored pi coding-agent's
`ExtensionAPI` into the old `AgentHarness` example. It ran real pi
extensions, but it was pi's API on pi's old harness, 17k lines with a
vendored runtime, and `PiHarness` on main now runs on pi-durable, where
none of it applies.

## The proposal

`agents/harness/extensions` (experimental). An extension is a function of
its context. A harness takes an array of them.

```ts
import type { ExtensionContext } from "agents/harness/extensions";
import { z } from "zod";

function guard(ctx: ExtensionContext) {
  ctx.tool.add({
    id: "add",
    description: "Add two numbers.",
    input: z.object({ a: z.number(), b: z.number() }),
    replay: "safe",
    execute: ({ a, b }) => ({ content: String(a + b) })
  });
  ctx.instructions.set("guard", "Never run destructive commands.");
  ctx.tool.hook("execute.before", (event) => {
    const command = String(event.input.command ?? "");
    if (/\brm\s+-rf\b/.test(command)) event.block = "destructive command";
    else if (/\bdeploy\b/.test(command)) event.ask = `Run "${command}"?`;
  });
}

new PiHarness({
  extensions: [guard, webAccess({ search }), mcp],
  harness: ({ storage, context, registry }) => {
    registry.install(nativePiExtension);
    return Harness.open(storage, { models, registry }, context);
  }
});
```

The names follow OpenCode 2's plugin API, because OpenCode solved the part
that is hard: [hot reload without stacked
state](https://anoma.ly/notes/opencode-reloaded/). Registration is
synchronous; nothing in an extension needs `await` unless it fetches.

### What an extension can do

| `ctx.`                                           | Kind      | What it is                                                                |
| ------------------------------------------------ | --------- | ------------------------------------------------------------------------- |
| `tool.add(tool)`, `tool.transform(draft => …)`   | transform | the tool catalog: native tools first, then every transform                |
| `tool.hook("execute.before" \| "execute.after")` | hook      | edit a call's input, block it, ask the person, or replace its result      |
| `instructions.set(key, text)`, `.transform`      | transform | named system prompt sections                                              |
| `skill.add(source)`, `.transform`                | transform | `agents/skills` sources, offered through `activate_skill`                 |
| `command.add(command)`, `.transform`             | transform | slash commands, resolved before anything is stored                        |
| `event.on(name, handler)`                        | handler   | `session.created`, `message.end`, `tool.end`, `turn.end`; observe only    |
| `storage(namespace)`                             |           | synchronous durable KV, with `.session(id)` scoping                       |
| `session(id)`                                    |           | `submit`, `note`, and `tools.activate/deactivate/offered` for one session |
| `supports(feature)`                              |           | whether the harness honours a feature                                     |

Inside a tool, `call` has `signal`, `progress(text)`, `update(metadata)`
and `ask(request)`. A result has `content`, `isError`, `metadata` (never
shown to the model) and `activate` (deferred tools to offer this session).

### Transforms rebuild from scratch

A rebuild starts from the domain's base (the harness's native tools for
`tool`, empty for the rest) and runs every transform once: by extension
order, then registration order. A refresh cannot undo a policy, an edit
cannot apply twice, and a removed source's tools disappear. Those are the
three bugs in the OpenCode post, and `host.test.ts` reproduces each one.
Rebuilds of a domain are serialized and coalesced. An extension's start is
batched into one rebuild per domain, and extensions start one at a time. A
transform cannot register anything while it replays.

Keep network calls outside transforms. A domain's rebuild replays every
extension's transforms, so a transform that fetched would fetch whenever
any extension reloaded. Fetch, keep the result, then `reload()`. A
transform may read `ctx.storage`, which is synchronous, so a rebuild is a
function of stored state.

### Hooks and events

`execute.before` hooks edit `event.input`, set `event.block`, or set
`event.ask`. The first block stops the chain. A hook that throws blocks the
call (fail closed). Once every hook has run, the harness asks `event.ask`
and blocks the call on a refusal. `execute.after` hooks replace
`event.result`; one that throws is reported and skipped. Hooks see every
tool call, native tools included.

Event handlers observe and cannot change anything. Delivery is at least
once: after an eviction a harness may deliver an event again.

### Per-session tools

A tool marked `deferred` is in the catalog but not offered. A session
offers it once activated, either by a tool's result (`activate: [...]`,
which is how a loader like `web_enable` works) or by
`ctx.session(id).tools.activate()`. The selection is per session and
durable, so it survives evictions, and forks inherit it.

### Asking the person

`call.ask({ kind: "confirm" | "select" | "input", ... })` stores the
question and waits. The harness lists open questions in `requests()`, and
`reply(id, answer)` answers one. The answer must fit the kind. If the
object dies while waiting, the harness reruns the tool's `execute` from
the top after it restarts, and `ask` finds the same question and its
stored answer. So a tool that asks must be `replay: "safe"`, and asking
from any other tool throws. The same mechanism serves `event.ask`.

### Commands and injected messages

`/name args` sent to a session runs the command before anything is stored.
A command that returns `{ prompt }` becomes that prompt's ordinary durable
submission, so prompt templates survive eviction like any prompt. One that
returns `{ text }` or nothing is settled by the harness as that text. The
outcome is recorded by operation id, so a retried submit neither reruns
the command nor submits twice. `session.submit()` and `session.note()`
require an `operationId` for the same reason; a note goes in the transcript
for clients and never reaches the model.

### Rules for a Durable Object

- Extensions run every time the harness opens, which on a Durable Object
  means after every eviction. State that must survive goes in
  `ctx.storage`.
- Tool ids must be stable across restarts. pi resumes an interrupted tool
  call by its tool's name.
- `replay: "safe"` lets a harness rerun an interrupted call. The default,
  `unsafe`, reports it interrupted.
- `ctx.session()` works from tools, hooks, commands and handlers, not
  while extensions start: the harness is not open yet.

### Features and failure

A harness declares the features it honours. Using one it lacks throws
`ExtensionFeatureUnsupported`; while an extension starts, that fails it,
the harness rolls it back and reports it, and the rest run. Editing a
native tool where the harness cannot is reported as a failed transform.
An extension that wants to degrade checks `ctx.supports(feature)` first.
Nothing is silently dropped.

## How it maps onto each harness

Pi is built. The rest are designs to check against those harnesses as
they land.

| Portable                  | Pi (built)                                                            | OpenCode                                                          | Think                                          | Container (Claude Code)                                               |
| ------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| tool catalog              | one projected pi extension, rebuilt per rebuild                       | `ctx.tool.transform` (schema conversion to confirm)               | `tools(turn)` from the snapshot                | host tools on the daemon's MCP server; the DO runs `execute`          |
| native tools in the draft | composed from the factory's registry; remove, rename, re-describe     | OpenCode's tool editor already lists them                         | whatever `tools()` returns                     | remove (`disallowedTools`); no re-describing built-ins                |
| `deferred` + `activate`   | a pi extension per deferred tool, selected in the session's agent doc | per-session agent tools (to confirm)                              | `activeTools` in `beforeTurn`, from storage    | `allowedTools` on the next query                                      |
| `execute.before`          | `ToolTask` `beforeTool`: `block` / `arguments`                        | `ctx.tool.hook("execute.before")`; block by throwing (to confirm) | `beforeToolCall`: `block` / `allow` with input | `PreToolUse`, answered by the DO: deny or `updatedInput`              |
| `execute.after`           | `afterTool` returns the replaced result                               | `ctx.tool.hook("execute.after")`                                  | needs `afterToolCall` to return a replacement  | not for built-in tools; `PostToolUse` cannot replace their output     |
| `ask` / `event.ask`       | stored request; the id is a memo on the tool task                     | OpenCode's permission and question flow                           | park the turn, as Think parks on approvals     | #2285's `requests()` / `reply()`, natively                            |
| `metadata`                | pi `details`                                                          | `metadata`                                                        | the tool output object                         | stored DO-side only                                                   |
| instructions              | one `PromptSection` per key                                           | `ctx.session.hook("context")` pushes `system` parts               | `system(turn)` joins the sections              | `appendSystemPrompt` when a query starts                              |
| skills                    | `activate_skill` tools and catalog section                            | `ctx.skill.transform`                                             | the same `activate_skill` tools                | `SKILL.md` files in the container, or host tools                      |
| commands                  | resolved in `submit()`, recorded by operation id                      | `ctx.command.transform`                                           | resolved before a turn is queued               | resolved DO-side before the prompt                                    |
| events                    | tool hooks and `GenerationTask` `afterResponse` / `onYield`           | `ctx.event.subscribe`                                             | `afterToolCall`, `onStepFinish`, `onTurnEnd`   | the daemon's frames                                                   |
| `storage`                 | the object's `ctx.storage.kv`                                         | the object's `ctx.storage.kv`                                     | the object's `ctx.storage.kv`                  | the object's `ctx.storage.kv` (extensions run in the DO)              |
| `submit` / `note`         | pi input and write submissions, deduplicated by request id            | `session.prompt` / `session.synthetic`                            | queue a turn / write a display part            | `prompt()` / a DO-side transcript entry                               |
| reload takes effect       | next request and next tool call, mid-run included                     | at once (OpenCode's own reload)                                   | next turn                                      | next query, or sooner if Claude Code honours MCP `tools/list_changed` |

How pi does it, since it is the one that is built:

- `PiHarness` hands the factory a registry view. Native pi extensions go
  into it as before. pi sees exactly one installed extension,
  `agents.extensions`, so it is every conversation's default selection. It
  carries the native extensions' sections, hooks and wraps, and the tools
  the portable `tool` domain produced. Native extensions stay registered
  underneath, so their tasks still resolve.
- Each deferred tool is its own pi extension, resolvable by name but not
  installed. Activation adds it to the session's `pi.agent` document,
  either in the tool's own commit (a result's `activate`) or in a commit of
  its own (`session.tools.activate`). pi resolves the agent at every
  request and every tool call, so activation and reloads apply mid-run.
  The test "a loader's result offers deferred tools to its session only"
  enables and calls a deferred tool in the same run.
- `ask` keys its request on a memo of the asking tool task. After a crash
  pi reruns the safe tool from `execute`, the memo returns the same id, and
  the stored answer comes back.
- If the factory opens pi with its own registry instead of the one it was
  handed, `PiHarness` refuses to open, rather than run without the
  extensions.

## What cannot be ported

| Native capability                                          | Where                                                                           | Why not                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Message/context rewriting before a request                 | pi `beforeRequest`, OpenCode `session.hook("context")`, Think `beforeStep`      | Message types differ per harness, and Claude Code has no request hook.                                            |
| Provider request, header and HTTP hooks                    | OpenCode `aisdk`, `session.hook("http.*")`, pi-coding-agent `before_provider_*` | Provider layers stay native ([rfc-harness-model-provider-boundary.md](./rfc-harness-model-provider-boundary.md)). |
| Compaction control                                         | pi `beforeCompact`, OpenCode `session.hook("compaction")`                       | Compaction policy differs per harness, and Claude Code compacts inside the container.                             |
| Custom durable tasks, memos, `ToolControl.handoff`         | pi-durable                                                                      | pi's task engine has no counterpart elsewhere.                                                                    |
| Streaming chunks (`onChunk`, `onModelChunk`)               | Think                                                                           | Chunk types differ per harness. Observability belongs on the harness's event stream.                              |
| Terminal UI: widgets, footers, shortcuts, custom renderers | pi coding-agent                                                                 | No terminal. A browser client renders `metadata`, requests and notes.                                             |
| Agents, models, providers and MCP as domains               | OpenCode                                                                        | Out of scope. MCP is expressible as deferred tools (see the port below).                                          |

## Trying it: the five most downloaded pi packages

I took the five most downloaded pi packages by weekly npm downloads (week
ending 2026-10-05, from the `pi-package` keyword) and counted, with grep
over each published tarball, which pi `ExtensionAPI` calls each makes:

| Package                              | Weekly | `registerTool` sites | Hooks used                                                  | Also needs                                                                   |
| ------------------------------------ | ------ | -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pi-mcp-adapter`                     | 534k   | 6                    | `tool_result`, `before_agent_start`, `input`                | `setActiveTools` (9), `ui.*` (50+), commands, flags, `exec`, stdio servers   |
| `billion-context`                    | 388k   | 2                    | `before_provider_request/headers`, `session_before_compact` | a local proxy process, `registerProvider`, patched `globalThis.fetch`        |
| `pi-web-access`                      | 230k   | 10                   | `tool_call`, `before_agent_start`                           | `setActiveTools` (8), model registry API keys, `appendEntry`, `ui.*`         |
| `pi-subagents`                       | 190k   | 14                   | `tool_result`, `agent_end`, `before_agent_start`            | child `pi` processes, 18 `registerCommand` sites, renderers, skills, prompts |
| `@juicesharp/rpiv-ask-user-question` | 96k    | 1                    | `before_agent_start`                                        | `ui.custom` blocking dialog, `setActiveTools`                                |

None of them runs on `PiHarness` as published. They target pi
coding-agent's `ExtensionAPI`, and `PiHarness` runs pi-durable. They also
import Node APIs (`child_process`, `fs`, the OS keyring).

So I ported each package's model-facing behaviour to the portable format
(`packages/agents/src/harness/pi/tests/ported-extensions.ts`) and ran the
ports on `PiHarness` with pi's faux model (`extensions.test.ts`):

| Package                | Port                                                                                                                         | Left out                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| pi-mcp-adapter         | server tools as deferred tools behind `mcp_enable`; one transform over a fetched catalog, so no `unregisterTool`; `/mcp`     | stdio servers, OS keyring OAuth, the TUI panel            |
| billion-context        | nothing; its manifest tools and `/acp` commands would be the same shapes as the MCP port                                     | the proxy, provider hooks, compaction cancelling          |
| pi-web-access          | `web_enable` loader activating deferred `web_search`/`fetch_content`/`get_search_content`; pages kept per session in storage | curator UI and widgets; API keys come in through `search` |
| pi-subagents           | `subagent` tool running a child `PiHarness` session, live `update()` metadata, its skills, a prompt template as a command    | workflow TUI, intercom, watchdog, renderers               |
| rpiv-ask-user-question | `ask_user_question` with `call.ask({ kind: "select" })`, answered through `reply()`, across a crash                          | TUI rendering, i18n                                       |

A `guard` extension, in the shape of the permission packages, blocks
`rm -rf` on a native pi tool, asks before `deploy`, and redacts secrets
from results.

## The gaps the first version found, and what closed them

The first version had tools, instructions and skills only. Running the
ports against it found six gaps. Each is now closed:

1. **Per-session tool selection** (3 of 5 call `setActiveTools`):
   `deferred` tools, `activate` on results, `session.tools`.
2. **Commands, asking the user, injected messages** (4 of 5): the
   `command` domain, `call.ask` and `event.ask` with `requests()` /
   `reply()`, `session.submit` and `session.note`.
3. **Lifecycle events** (all 5): `ctx.event.on`.
4. **Native tools in the draft**: the tool draft starts with the
   harness's tools, gated by `tool.native.remove` / `tool.native.update`.
5. **Tool-result metadata**: `metadata` on results, `call.update()`.
6. **State across evictions**: `ctx.storage`. The tool-maker test makes
   a tool, crashes the object, and calls the tool again.

## Known limits

- **A parked `ask` keeps the object awake.** `PiHarness`'s wake job waits
  on live pi work with a heartbeat, and a tool waiting on a person is live
  work. A graceful eviction also waits for it, which is why the crash test
  aborts the object instead. Letting the object sleep needs a parked task
  state in pi-durable.
- **`activate` is read from the tool's own result.** An `execute.after`
  hook runs where pi has no commit, so a hook calls
  `ctx.session(id).tools.activate()` instead.
- **Explicit selections bypass the projection.** A conversation whose pi
  agent selects extensions by an explicit array sees only what it names,
  and no portable extension unless it names `agents.extensions`.
- **`session.created` covers the harness's own API.** Conversations that
  pi tools create themselves do not report it.
- **A command's `run` is not durable.** It runs before anything is stored.
  Its outcome is recorded, but a crash during `run` reruns it on retry.
- **Per-session storage outlives the session on pi.** `PiHarness` has no
  session delete yet; `deleteSessionStorage` is there for harnesses that
  do.

## The alternatives

- **Adopt `@opencode/plugin`'s types as the portable format.** OpenCode
  plugins would run on pi unchanged. But the types pull in Effect schemas
  and branded ids, and they expose domains no other harness can honour.
  Mirroring the names gets most of the benefit without the dependency.
- **Port pi's `ExtensionAPI` to every harness (#2229's direction).** It
  has the largest ecosystem, but it is imperative (`registerTool`,
  `setActiveTools`, `unregisterTool`) and terminal-shaped. The stacking
  bugs OpenCode fixed come back, and half its API is `ctx.ui`.
- **Extensions as objects (`defineExtension({ id, setup })`).** The first
  version of this PR. An id per extension buys little: the host keys
  extensions by reference, reports use the function's name, and storage
  takes an explicit namespace.
- **Per-session transforms (`transform((draft, session) => …)`)** for
  tool selection. One rebuild per session, and the result would depend on
  mutable session state.
- **Ask as a separate `{ request }` result plus a `resume(reply)`
  handler.** No re-execution, but a tool's logic splits in two and its
  local state has to be serialized by hand.
- **A declarative manifest, like Think's sandboxed extensions.** Portable
  across processes, but it is not code.

## Open questions

- Does OpenCode's `Tool.Info` accept a raw JSON Schema, and does OpenCode
  have per-session tool selection?
- ThinkHarness needs `afterToolCall` to return a replacement for
  `execute.after`.
- Should pi-durable grow a parked task state, so an `ask` lets the object
  sleep?

## The decision

Pending.
