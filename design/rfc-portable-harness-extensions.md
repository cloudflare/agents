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
`browser/tanstack-ai.ts`, and `browser/pi.ts` in #2484), and every new tool
would need one per harness.

We want one top-level extension format, so switching harness does not mean
rewriting extensions. Native extensions stay. The portable format covers
what every harness can honour, and says loudly when a harness cannot.

An earlier attempt (#2229, closed) vendored pi coding-agent's
`ExtensionAPI` into the old `AgentHarness` example. It ran real pi
extensions, but it was pi's API on pi's old harness, 17k lines with a
vendored runtime, and `PiHarness` on main now runs on pi-durable, where
none of it applies.

## The proposal

`agents/harness/extensions` (experimental). Extensions are code. The shape
is a subset of OpenCode 2's plugin API, with the same names, because
OpenCode solved the part that is hard: [hot reload without stacked
state](https://anoma.ly/notes/opencode-reloaded/).

```ts
import { defineExtension, defineTool } from "agents/harness/extensions";
import { z } from "zod";

export const guard = defineExtension({
  id: "guard",
  async setup(ctx) {
    await ctx.tool.transform((tools) =>
      tools.add(
        defineTool({
          id: "add",
          description: "Add two numbers.",
          input: z.object({ a: z.number(), b: z.number() }),
          replay: "safe",
          execute: ({ a, b }) => ({ content: String(a + b) })
        })
      )
    );
    await ctx.instructions.transform((sections) =>
      sections.set("guard", "Never run destructive commands.")
    );
    await ctx.tool.hook("execute.before", (event) => {
      if (/\brm\s+-rf\b/.test(String(event.input.command))) {
        event.block = "destructive command";
      }
    });
  }
});
```

On pi:

```ts
harness: async ({ storage, context }) => {
  const registry = createRegistry();
  const { failures } = await piExtensions({ registry, extensions: [guard] });
  if (failures.length > 0) throw new AggregateError(failures);
  return Harness.open(storage, { models, registry }, context);
};
```

### Two kinds of registration

**Transforms** edit a domain's draft. v1 has three domains:

| Domain         | Draft                                 | Becomes                          |
| -------------- | ------------------------------------- | -------------------------------- |
| `tool`         | `list/get/add/update/remove` of tools | the tools the model is offered   |
| `instructions` | `list/get/set/remove` of keyed text   | system prompt sections, in order |
| `skill`        | `list/add/remove` of `SkillSource`s   | `activate_skill` and a catalog   |

A rebuild starts from an empty draft and runs every transform once: by
extension order, then registration order. A refresh cannot undo a policy,
an edit cannot apply twice, and a removed source's tools disappear. Those
are the three bugs in the OpenCode post, and `host.test.ts` reproduces each
one. Rebuilds of a domain are serialized and coalesced. A setup's
registrations rebuild once, after it. A transform cannot register anything
while it replays.

**Hooks** edit a running operation's event in place. Later hooks see
earlier edits. Hooks never replay. v1 has two:

- `tool.hook("execute.before")`: edit `event.input`, or set `event.block`.
  The first block stops the chain. A hook that throws blocks the call
  (fail closed).
- `tool.hook("execute.after")`: replace `event.result`. A hook that throws
  is reported and skipped.

Hooks see every tool call, native tools included. That is what a policy
extension needs.

Every registration returns `{ dispose }`. `host.remove(id)` disposes all of
an extension's registrations, runs the cleanup `setup` returned, and
rebuilds once.

### Tool schemas

`input` is any Standard Schema that also implements Standard JSON Schema
(Zod 4, Valibot, ArkType). The harness shows the model the JSON Schema and
the tool parses the model's input with the schema itself, so `execute` gets
typed, parsed input. `jsonSchema(raw)` wraps a schema only known at runtime,
such as an MCP server's tool list.

### Rules for a Durable Object

- `setup` runs on every cold start. On a Durable Object that means after
  every eviction. State that must survive goes in storage the extension
  owns.
- Tool ids must be stable across restarts. pi resumes an interrupted tool
  call by its tool's name.
- `replay: "safe"` lets a harness rerun an interrupted call. The default,
  `unsafe`, reports it interrupted.
- Keep network calls outside transforms. A domain's rebuild replays every
  extension's transforms, so a transform that fetched would fetch whenever
  any extension reloads. Fetch, store the result in a closure, then call
  `reload()`.

### Features and failure

A harness declares which features it honours (`tool`,
`tool.execute.before`, `tool.execute.after`, `instructions`, `skill`).
Registering one it lacks throws `ExtensionFeatureUnsupported` inside setup.
`host.add()` returns it as the cause of an `ExtensionSetupFailed` value and
rolls the setup back. An extension that wants to degrade checks
`ctx.supports(feature)` first. Nothing is silently dropped.

## How it maps onto each harness

| Portable              | Pi (built)                                              | OpenCode                                                          | Think                                                | Container (Claude Code)                                                          |
| --------------------- | ------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `tool` transform      | one pi `Extension` reinstalled per rebuild              | `ctx.tool.transform` `add` (schema conversion, see below)         | `tools(turn)` returns the snapshot as AI SDK tools   | host tools on the daemon's MCP server; the DO runs `execute`                     |
| `tool.execute.before` | `hook(ToolTask, { beforeTool })`: `block` / `arguments` | `ctx.tool.hook("execute.before")`; block by throwing (to confirm) | `hooks.beforeToolCall`: `block` / `allow` with input | `PreToolUse`, answered by the DO: deny or `updatedInput`                         |
| `tool.execute.after`  | `afterTool` returns the replaced result                 | `ctx.tool.hook("execute.after")`, `result` on `completed`         | not yet: `afterToolCall` returns void                | not for built-in tools; `PostToolUse` can add context, not replace output        |
| `instructions`        | one `PromptSection` per key                             | `ctx.session.hook("context")` pushes `system` parts               | `system(turn)` joins the sections                    | `appendSystemPrompt` when a query starts                                         |
| `skill`               | `resolveSkillSources` tools and catalog section         | `ctx.skill.transform` `add`                                       | the same `activate_skill` tools                      | `SKILL.md` files in the container, or host tools                                 |
| reload takes effect   | next request and next tool call, mid-run included       | at once, every session (OpenCode's own reload)                    | next turn (`tools()` runs per turn)                  | next query, or sooner if Claude Code honours MCP `tools/list_changed` (untested) |

Notes per harness:

- **Pi.** The match is close. pi resolves the agent's tools at every tool
  call and every request, so a reload applies mid-run. The test
  "lets the agent make a tool and call it in the same run" does what the
  OpenCode post demos. pi validates the call against the JSON Schema
  before the hooks and again after them; the tool's schema then parses it a
  third time, which is how refinements JSON Schema cannot express still
  hold.
- **OpenCode.** The adapter is thin because the names are OpenCode's. One
  open point: OpenCode's `Tool.Info` takes an Effect `ValueSchema`, so a
  portable tool's JSON Schema needs converting or wrapping. The
  OpenCode harness agent should confirm whether `Tool.Info` accepts raw
  JSON Schema.
- **Think.** ThinkHarness has no native extension system, so this format
  would be its only one. `execute.after` needs `afterToolCall` to return a
  replacement (a small change in #2396), or the adapter wraps `execute` for
  portable tools only, which misses native ones. The same mapping fits
  `AiSdkHarness`.
- **Container.** Extension code stays in the DO, and the agent loop runs in
  the container. Anything per-call goes over the daemon's park-and-reply
  path from #2285, which costs a round trip per tool call. Anything
  per-request, such as rewriting the messages sent to the model, cannot be
  ported, because Claude Code does not expose its request to a hook.

## What cannot be ported

| Native capability                                                  | Where                                                                           | Why not                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Message/context rewriting before a request                         | pi `beforeRequest`, OpenCode `session.hook("context")`, Think `beforeStep`      | Message types differ per harness, and Claude Code has no request hook. Candidate for v2 (see below).              |
| Provider request, header and HTTP hooks                            | OpenCode `aisdk`, `session.hook("http.*")`, pi-coding-agent `before_provider_*` | Provider layers stay native ([rfc-harness-model-provider-boundary.md](./rfc-harness-model-provider-boundary.md)). |
| Custom durable tasks, memos, `ToolControl` (`addTools`, `handoff`) | pi-durable                                                                      | pi's task engine has no counterpart elsewhere.                                                                    |
| Section and tool wraps that see native config                      | pi `wraps`                                                                      | The draft only holds portable tools (see findings).                                                               |
| Agents, models, providers, MCP, permissions as domains             | OpenCode                                                                        | Out of v1. MCP is expressible as tools (see the port below).                                                      |
| Streaming chunks (`onChunk`, `onModelChunk`)                       | Think                                                                           | Chunk types differ per harness. Observability belongs on the harness's event stream.                              |
| Terminal UI: widgets, footers, shortcuts, custom renderers         | pi coding-agent                                                                 | No terminal. A browser client is the harness's concern.                                                           |

## Trying it: the five most downloaded pi packages

I took the five most downloaded pi packages by weekly npm downloads (week
ending 2026-10-05, from the `pi-package` keyword) and counted, with grep
over each published tarball, which pi `ExtensionAPI` calls each makes:

| Package                              | Weekly | `registerTool` sites | Hooks used                                                  | Also needs                                                                   | Ported?    |
| ------------------------------------ | ------ | -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------- |
| `pi-mcp-adapter`                     | 534k   | 6                    | `tool_result`, `before_agent_start`, `input`                | `setActiveTools` (9), `ui.*` (50+), commands, flags, `exec`, stdio servers   | tools, yes |
| `billion-context`                    | 388k   | 2                    | `before_provider_request/headers`, `session_before_compact` | a local proxy process, `registerProvider`, patched `globalThis.fetch`        | no         |
| `pi-web-access`                      | 230k   | 10                   | `tool_call`, `before_agent_start`                           | `setActiveTools` (8), model registry API keys, `appendEntry`, `ui.*`         | tools, yes |
| `pi-subagents`                       | 190k   | 14                   | `tool_result`, `agent_end`, `before_agent_start`            | child `pi` processes, 18 `registerCommand` sites, renderers, skills, prompts | core, yes  |
| `@juicesharp/rpiv-ask-user-question` | 96k    | 1                    | `before_agent_start`                                        | `ui.custom` blocking dialog, `setActiveTools`                                | no         |

None of them runs on `PiHarness` as published. They target pi
coding-agent's `ExtensionAPI`, and `PiHarness` runs pi-durable, which has a
different extension model. They also import Node APIs (`child_process`,
`fs`, the OS keyring) that a Worker does not have.

So I ported each package's model-facing core to the portable format
(`packages/agents/src/harness/pi/tests/ported-extensions.ts`) and ran the
ports on `PiHarness` with pi's faux model (`extensions.test.ts`):

- **pi-mcp-adapter** became `mcpAdapter`: one transform over a fetched
  catalog, adding `mcp__<server>__<tool>`. The original needs an
  undocumented `unregisterTool` to drop tools when a server changes; with
  transforms that bug cannot happen. The test changes the server's tool
  list and the next request sees exactly the new list.
- **pi-web-access** became two tools and an instructions section. The
  search backend and `fetch` are injected, which also covers the API keys
  it reads from pi's model registry.
- **pi-subagents** became a `subagent` tool and its skills. The host
  injects `run`, which creates a `PiHarness` session and prompts it. That
  worked from inside a tool call with no deadlock.
- **billion-context** has nothing portable. It is a fetch-patching proxy.
  Its manifest-fed tools would be the same transform as `mcpAdapter`.
- **rpiv-ask-user-question** has nothing portable. Its tool holds a call
  open on a terminal dialog.
- A `guard` extension, in the shape of the permission packages, blocks
  `rm -rf` on a native pi tool and redacts secrets from its result.

## Findings: what broke or was not expressive enough

1. **Per-session tool selection is the biggest gap.** Three of the five
   call `setActiveTools` to load tools lazily for one session
   (`web_enable`, the MCP proxy, ask-user's reconcile). Portable transforms
   are global. pi-durable has `ToolControl.addTools` and OpenCode has
   per-agent tool lists, so a v2 could add `ToolResult.activate` plus a
   `deferred` flag on a tool.
2. **Commands, UI and injected messages are missing, and four of five use
   them.** Slash commands, `ctx.ui.notify/select/confirm`, and
   `sendMessage`/`sendUserMessage`. On a durable harness a dialog has to
   be a persisted request with a `reply()` (the shape in #2285), not a
   promise. Adding `request` and `command` domains should wait for
   `PiHarness` and OpenCode to share a request model.
3. **Every package subscribes to lifecycle events.** `session_start`,
   `agent_end` and `session_tree` reset in-memory state. The portable
   format has no event subscription. A read-only `ctx.event.subscribe`
   mapped onto each harness's event stream would cover it.
4. **The tool draft cannot see native tools.** Hooks see every call, but
   `draft.remove("shell")` on a native pi tool does nothing. On pi the fix
   is pi `wraps` and the conversation's `tools.remove`. On OpenCode the
   draft already holds native tools. The semantics have to be the same
   everywhere, so v1 states "portable tools only" and the gap stays open.
5. **One pi extension holds everything.** Transforms run across
   extensions over one draft (B may edit A's tools), so the result cannot
   be split per extension. A conversation can select the whole portable
   set or none of it, not one portable extension.
6. **Dynamic state does not survive an eviction by itself.** The
   tool-maker test makes a tool and calls it in the same run. After an
   eviction that tool is gone, because setup reran with empty closures. A
   portable `ctx.storage` would make the right pattern obvious.
7. **Tool results have no structured details.** pi-mcp-adapter flips
   `isError` from `details` in a `tool_result` hook. Portable results carry
   content and `isError` only. A JSON `metadata` field maps to pi
   `details` and OpenCode `metadata`.
8. **JSON types differ.** pi-ai's JSON arrays are readonly and chord's are
   mutable, so neither assigns to the other. The portable `JsonValue` is
   mutable, and the pi adapter copies arguments with one documented cast.
9. **Subagents are not durable.** The ported `subagent` tool is
   `replay: "unsafe"`. If the object is evicted mid-call, the parent gets
   "interrupted" while the child session keeps running. pi-durable's own
   child-conversation tasks avoid this, but no other harness has them.

What worked without trouble: rebuild-from-empty, tools appearing mid-run,
hooks over native tools, extension removal, skills, and setup rerunning
after an eviction.

## The alternatives

- **Adopt `@opencode/plugin`'s types as the portable format.** OpenCode
  plugins would run on pi unchanged. But the types pull in Effect schemas
  and branded ids, and they expose 20 domains no other harness can honour.
  Mirroring the names gets most of the benefit without the dependency.
- **Port pi's `ExtensionAPI` to every harness (#2229's direction).** It
  has the largest ecosystem, but it is imperative (`registerTool`,
  `setActiveTools`, `unregisterTool`) and terminal-shaped. The stacking
  bugs OpenCode fixed come back, and half its API is `ctx.ui`.
- **A declarative manifest, like Think's sandboxed extensions.** Portable
  across processes, but tools and hooks become RPC stubs, and it is not
  code. Extensions are code.
- **Keep per-tool adapters (`browser/pi.ts` and siblings).** Fine for one
  tool, but it grows as tools times harnesses, and it does not cover hooks.

## Open questions

- Does OpenCode's `Tool.Info` accept a raw JSON Schema, or does the adapter
  build an Effect schema?
- Should `execute.after` be mandatory? Think and the container cannot fully
  honour it today.
- Is `instructions` static text enough? pi and OpenCode can render per
  request; Think per turn; Claude Code only per query. Static text with
  `reload()` is the one shape all four honour.
- Where should v2 start: per-session tool selection (finding 1) or
  requests and commands (finding 2)?

## The decision

Pending.
