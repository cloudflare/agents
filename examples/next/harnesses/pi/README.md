# Pi harness

An experimental example that runs pi's durable `AgentHarness` inside a plain
Durable Object, composed from the SDK's Lifecycle capabilities. Nothing here is
exported from the `agents` package yet; `PiHarness` and the Workers AI provider
live in this example's `src/` and pin an unreleased pi build.

The example composes:

- `PiHarness extends LifecycleCapability` for the durable agent loop;
- `Tasks` to drive each conversation lane to settlement and replay after
  eviction;
- `Streams` to durably record every operation's live output;
- `WebSockets` to serve that output to the browser;
- `agents/skills` for a bundled `trip-planning` skill;
- pi's own extension runtime, vendored verbatim, so extensions written against
  pi's `ExtensionAPI` run unchanged in the Durable Object;
- a `Workspace` from `@cloudflare/shell` as pi's `ExecutionEnv`, so pi's own
  `read`, `write`, `edit` and `bash` tools run over durable SQLite (+R2) files;
- extension UI — dialogs, notifications, status and widgets — carried to the
  browser over the same WebSocket protocol;
- pi-ai's Workers AI provider, transported over the `AI` binding.

Pi owns the transcript, tool intents and results, retries, and recovery. The
SDK supplies durable wakes, the output log, and the client transport.

## Extensions

An extension is a plain function over pi's own `ExtensionAPI`. The same shape
that a local pi install loads from a file is what the harness config takes:

```ts
import type { PiExtensionApi } from "./harness/types";

export function notes(pi: PiExtensionApi): void {
  pi.registerFlag("confirm_destructive", { type: "boolean", default: false });

  pi.registerCommand("note", {
    description: "Append a note without asking the model.",
    handler: async (args, ctx) => {
      pi.appendEntry("note", { text: args.trim(), at: Date.now() });
      ctx.ui.notify(`Noted: ${args.trim()}`);
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    if (pi.getFlag("confirm_destructive") !== true) return undefined;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || !isDestructiveCommand(command)) return;
    return (await ctx.ui.confirm("Run a destructive command?", command))
      ? undefined
      : { block: true, reason: "The user declined the command." };
  });
}
```

```ts
new PiHarness({
  extensions: [
    { name: "memory-guard", factory: memoryGuard },
    { name: "notes", factory: notes }
  ],
  flags: { confirm_destructive: false },
  promptTemplates: [
    {
      name: "summarize",
      content: "Summarize the conversation so far in $1 bullet points."
    }
  ]
});
```

Extensions are process-local: they are loaded again on every isolate wake,
before the harness attaches, so their tools, commands and flags exist for the
first replayed step after an eviction. `src/extensions/` holds this example's
two: `memory-guard` blocks `remember` calls whose key starts with `_`, and
`notes` adds the `/note` command, the `confirm_destructive` flag and the bash
confirmation above.

`isDestructiveCommand` splits the command on the shell's operators and asks
whether any word in command position names something destructive, so
`ls; rm -rf x` and `find . | xargs rm` open the dialog while `echo rm` does
not. **It is a demo gate for the confirmation dialog, not a security
boundary** — a shell has endless ways past a word list. The safety property
that does hold is structural: the bash tool runs in an in-isolate interpreter
over the Durable Object's own sandboxed `Workspace`, so a command reaches the
session's virtual filesystem and nothing else.

### Events and hooks

Extension events are driven from pi's `AgentHarness` hooks and from the
harness's own event stream:

| Extension event                                                                                                                                                                           | Source                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `tool_call`, `tool_result`                                                                                                                                                                | `before_tool`, `after_tool` hooks                          |
| `context`, `before_agent_start`                                                                                                                                                           | `transform_context`, `before_run` hooks                    |
| `before_provider_request`, `before_provider_headers`, `after_provider_response`, `message_end`                                                                                            | `before_payload`, `before_request`, `after_response` hooks |
| `session_before_compact`, `session_before_tree`                                                                                                                                           | `before_compaction`, `before_navigation` hooks             |
| `input`                                                                                                                                                                                   | `submit()`, before the durable operation                   |
| `agent_start`/`agent_end`/`agent_settled`, `turn_*`, `message_*`, `tool_execution_*`, `model_select`, `thinking_level_select`, `session_compact*`, `session_tree`, `session_info_changed` | harness events                                             |
| `session_start`, `session_shutdown`, `resources_discover`                                                                                                                                 | synthesized at attach and close                            |

Documented as unsupported in this example: `project_trust` (no project trust
model in a Durable Object), `user_bash` (no interactive `!` shell), and
`session_before_switch` / `session_before_fork`. The command-context actions
`newSession`, `fork`, `switchSession` and `reload` are declined — sessions are
Durable Object identities here, so a host swaps objects rather than files.

### The shell

`bash` runs `just-bash` in the isolate over a snapshot of the whole workspace,
writing changed files back when the command exits. That means built-in shell
commands only — no arbitrary binaries, no network tools — and one snapshot per
invocation. The port is `ExecutionEnv`, so a container-backed shell can replace
it later without touching pi or the extensions.

### Commands, templates and flags

Three sources answer `/`: extension commands (run out of band, no model turn),
prompt templates from `promptTemplates` (`$1`, `$2`, … substituted from the
arguments), and skills. On connect the client asks for both lists over the
socket — `get_commands` for its autocomplete, `get_flags` for the current flag
values — and the harness pushes a fresh `commands` or `flags` frame whenever
either changes. Boolean flags are toggled from the tools panel, which sends
`set_flag`; `notes`'s `confirm_destructive` is the one to try, since turning it
on makes the next `rm` raise a `confirm` dialog.

## Run locally

```sh
pnpm install
pnpm run start
```

The example uses the remote Workers AI binding and may incur Workers AI usage.
It needs no API key. If your Wrangler login has access to more than one
account, set `CLOUDFLARE_ACCOUNT_ID` when starting.

## What to try

- `Roll four 12-sided dice and total them.`
- `Use the calculator to multiply 47 by 19.`
- `Remember that my favourite launch snack is stroopwafels.`
- `What did I tell you my favourite launch snack was?`
- `I want to plan a trip.` activates the bundled skill.
- `/note remember this` appends a note and shows a notification, with no model
  turn and no durable operation.
- `Write a haiku to /haiku.txt with bash, then read it back.` exercises pi's
  own bash and read tools over the workspace.
- Toggle `confirm_destructive` in the tools panel, then ask for
  `rm /haiku.txt` — the extension opens a confirmation dialog in the browser
  and blocks the tool call if you decline.
- `/summarize 3` expands the prompt template.

Tool calls and results render live as they happen. Reload the page mid-turn
and the transcript and in-flight reply resume from the durable stream. Use the
new-session button to start with a fresh Durable Object.

## Test

```sh
pnpm test
```

The test runs a real Durable Object with pi-ai's faux provider, drives a tool
call to settlement, evicts the object, and checks the transcript and a second
turn survive. Further suites cover the extension surface — a blocked tool call,
a context transform, an extension tool, a UI round-trip and its timeout — and
pi's file and bash tools over the workspace.

## Core pattern

```ts
export class PiAgent extends DurableObject<Env> {
  readonly tasks = new Tasks();
  readonly streams = new Streams();

  readonly workspace = new Workspace({
    sql: this.ctx.storage.sql,
    namespace: "pi",
    r2: this.env.WORKSPACE,
    r2Prefix: this.ctx.id.toString()
  });

  readonly harness = new PiHarness({
    models: createModels({ providers: [workersAI(this.env.AI)] }),
    model: { provider: "cloudflare-workers-ai", modelId: MODEL_ID },
    tasks: this.tasks,
    streams: this.streams,
    tools: () => tools,
    executionEnv: createWorkspaceExecutionEnv({ workspace: this.workspace }),
    builtinTools: ["read", "write", "edit", "bash"],
    extensions: [{ name: "notes", factory: notes }]
  });

  readonly webSockets = new WebSockets(this.harness.webSockets());

  readonly lifecycle = Lifecycle.install(this)
    .use(this.tasks)
    .use(this.streams)
    .use(this.webSockets)
    .use(this.harness);
}
```

Each lane's work runs as one `Tasks` run whose replayable step drives pi to
settlement. Every operation's events land in one `Streams` stream, and
`harness.webSockets()` returns the options for a `WebSockets` capability that
serves a small JSON protocol: a lane snapshot on connect, `subscribe` to
replay-then-tail an operation's stream from a client cursor, and `submit`,
`abort`, and `steer` to drive it. The browser connects with `useAgent` from
`agents/react`; `src/use-pi-session.ts` layers the protocol on that socket.

The extension surface rides the same socket: `extension_ui_request` /
`extension_ui_response` for blocking dialogs, `commands` and `flags` frames for
the slash-command list and flag values, and `handler_error` when an extension
handler throws. Unanswered dialogs resolve to their default after
`uiRequestTimeoutMs` (30 s) rather than holding a hook open, and the harness
announces every dialog it settles that way with `extension_ui_settled` so a
client never leaves a dead modal on screen. A lane whose last subscriber
disconnects has its open dialogs cancelled on the spot, for the same reason.

## Vendored pi sources

Two vendored trees, both MIT and both pinned to the same pi commit:

- `vendor/pi-dev/` — the published-shape tarballs (`pi-agent-core`, `pi-ai`, …)
  the example depends on;
- `vendor/pi-coding-agent-src/` — pi's extension runtime copied verbatim from
  `packages/coding-agent/src`, plus hand-written stubs at the upstream import
  paths and one patch. See
  [`vendor/pi-coding-agent-src/README.md`](./vendor/pi-coding-agent-src/README.md)
  for the file list, the provenance banners and `MANIFEST.json`.

Re-vendor with `pnpm vendor:pi` from the repo root, and verify the tree still
matches upstream with `pnpm vendor:pi:check` (what CI runs).

## Pi source

The build pins `earendil-works/pi` commit `c4b0e35a` as vendored archives under
`vendor/pi-dev`. Pi is MIT licensed; see
[`licenses/mit-earendil-pi.txt`](./licenses/mit-earendil-pi.txt). The design
and the work left before this can become a package export are in
[`design/rfc-pi-harness-example.md`](../../../design/rfc-pi-harness-example.md);
the extension surface itself is described in
[`design/pi-extensions.md`](../../../design/pi-extensions.md).
