# @cloudflare/think

An opinionated chat agent base class for Cloudflare Workers. Handles the full chat lifecycle — agentic loop, streaming, persistence, client tools, stream resumption — all backed by Durable Object SQLite.

Works as both a **top-level agent** (WebSocket chat protocol for browser clients) and a **sub-agent** (RPC streaming from a parent agent).

> **Experimental** — the API surface is stable but may evolve before graduating out of experimental.

## Quick start

```ts
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";

export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.7-code"
    );
  }

  getSystemPrompt() {
    return "You are a helpful coding assistant.";
  }
}
```

That's it. Think handles the WebSocket chat protocol, message persistence, the agentic loop, message sanitization, stream resumption, client tool support, and workspace file tools. Connect from the browser with `useAgentChat` from `@cloudflare/think/react`.

## Think framework

The Think Vite plugin can generate the Worker entry, stable Durable Object
exports, friendly route helpers, and inferred Worker config from an `agents/`
directory:

```ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { think } from "@cloudflare/think/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [think(), cloudflare()]
});
```

Use `main: "virtual:think/entry"` in framework projects. Top-level agents under
`agents/` get generated Durable Object bindings and migrations; nested
`agents/*/agents/*` entries are facet exports for `ctx.exports` and do not need
production Wrangler bindings or migrations. Apps with auth or custom routing can
add `src/server.ts`; the generated entry still wraps it and injects
`think.router` for manifest-aware routing.

The framework supports one sub-agent layer today. If you need nested sub-agents,
please reach out with your use case so we can design that model deliberately.

The published package includes the full Think documentation at
`docs/index.md`.

## Messengers

Think can own messenger ingress directly. Declare providers with
`getMessengers()` and import provider implementations from subpaths so unused
Chat SDK adapters are not bundled.

```ts
import { Think } from "@cloudflare/think";
import { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
import telegramMessenger from "@cloudflare/think/messengers/telegram";

export { ThinkMessengerStateAgent };

export class SupportAgent extends Think<Env> {
  getMessengers() {
    return {
      telegram: telegramMessenger({
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: "support_bot",
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
      })
    };
  }
}
```

The root Think agent handles the webhook route with this precedence: framework
sub-agent routing, Think internal routes, messenger routes, then user
`onRequest`. By default, `telegram` maps to
`/messengers/telegram/webhook`, direct messages and mentions are routed to the
agent, and new mentions subscribe the thread so later mentions in the same
thread are still observed. Ordinary subscribed-thread messages and button
actions are opt-in with `respondTo: ["subscribed-thread", "action"]`. Each Chat
SDK thread runs in its own Think sub-agent to avoid accidental context sharing.
Each root agent owns one Chat SDK runtime for all configured messengers, so
multi-provider agents do not fight over Chat SDK singleton state.

Use `conversation: "self"` when all messenger traffic should share the root
agent's memory. Use a custom `conversation(event)` resolver to route by thread,
channel, tenant, or user.

Messenger state uses `agents/chat-sdk` under the hood. Export
`ThinkMessengerStateAgent` from the Worker module so sub-agent routing can
resolve it; production apps do not need to add a separate durable object binding
or migration for this facet-only class. Test harnesses may still need explicit
bindings.

Inbound messenger replies use the streamed `chat()` path by default: the root
agent starts an idempotent fiber, resolves the conversation target, calls
`target.chat(message, callback)`, and lets the provider delivery policy post or
edit messages. Recovery snapshots store only serializable event/thread data, so
interrupted replies can either resume before streaming starts or post the
configured interruption message after streaming has begun. `submitMessages()`
remains the right primitive for non-streaming programmatic sends, scheduled
digests, or background work.

During a messenger turn, `getMessengerContext()` returns the initiating
messenger context even after assistant messages are persisted. Telegram webhook
verification is explicit: provide `secretToken`, a custom `verifyWebhook`, or
`verifyWebhook: false` when intentionally running without verification. Custom
messengers built with `chatSdkMessenger()` must make the same choice explicitly.
Delivery failures use a generic user-facing error by default so internal
exception details are not posted into external chats.

Provider-neutral events include thread, author, message, action, capabilities,
and attachment metadata. Attachment bytes are only fetched when a provider
supplies a safe fetch function. Telegram is the first provider implementation;
future Slack, Discord, or Teams entrypoints implement the same messenger
contract from their own subpaths.

Common messenger options:

| Option                | Default                              | Description                                                                                                                              |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `path`                | `/messengers/{id}/webhook`           | Webhook path handled before user `onRequest`                                                                                             |
| `respondTo`           | `["direct-message", "mention"]`      | Event kinds that should start a Think reply                                                                                              |
| `subscribeOnMention`  | `true`                               | Subscribe Chat SDK threads after a new mention                                                                                           |
| `conversation`        | `"thread"`                           | Use one Think sub-agent per Chat SDK thread; set `"self"` to use the root agent                                                          |
| `channelSpeakerLabel` | `fullName \|\| userName \|\| userId` | Channel (non-DM) messages are rendered as `SpeakerName: text`. Pass a formatter to customize or suppress labels. DMs never get a prefix. |
| `verifyWebhook`       | required                             | Verification function, or `false` to opt out explicitly                                                                                  |
| `delivery`            | provider defaults                    | Streaming limits, text splitting, and safe user-facing failure messages                                                                  |

## Agent tools

Think subclasses can be dispatched as agent tools from another Agent. The parent
uses `runAgentTool()` or `agentTool()` from `agents/agent-tools`; the child Think
instance owns its own messages, resumable stream, tools, and storage.

```ts
import { Think } from "@cloudflare/think";
import { agentTool } from "agents/agent-tools";
import { z } from "zod";

export class Researcher extends Think<Env> {
  getSystemPrompt() {
    return "Research the requested topic and end with a concise summary.";
  }
}

export class Assistant extends Think<Env> {
  getTools() {
    return {
      research: agentTool(Researcher, {
        description: "Research one topic in depth.",
        inputSchema: z.object({ query: z.string().min(3) }),
        displayName: "Researcher"
      })
    };
  }
}
```

The parent broadcasts `agent-tool-event` frames for live UI rendering and keeps
the child facet until `clearAgentToolRuns()` deletes retained runs.

See the full [Agent Tools guide](../../docs/agents/agent-tools.md) for rendering,
drill-in, and cleanup patterns.

## Built-in workspace

Every Think agent gets `this.workspace` — a virtual filesystem backed by the DO's SQLite storage. Workspace tools (`read`, `write`, `edit`, `list`, `find`, `grep`, `delete`, `bash`) are automatically available to the model.

The `read` tool returns line-numbered text for text files. For images and PDFs, it keeps the persisted tool result compact and passes file bytes to multimodal-capable models using AI SDK content parts.
The `bash` tool runs sandboxed shell workflows through `just-bash`, with network
access disabled by default, and syncs changed files and empty directories back
into the workspace. It snapshots up to 1,000 files by default, skips files larger
than 1 MB, and treats skipped paths as protected during write-back. Set
`workspaceBash = false` on your Think subclass to opt out, or pass an options
object to tune limits, timeout, and network access.

```ts
export class MyAgent extends Think<Env> {
  getModel() { ... }
  // this.workspace is ready to use — no setup needed
  // workspace tools are auto-merged into every chat turn
}
```

Override to add R2 spillover for large files:

```ts
export class MyAgent extends Think<Env> {
  override workspace = new Workspace({
    sql: this.ctx.storage.sql,
    r2: this.env.R2,
    name: () => this.name
  });
}
```

## Agent Skills

Think supports the [Agent Skills](https://agentskills.io/) directory format as
a first-class API. Return one or more `SkillSource` objects from `getSkills()`;
Think adds the skill catalog to the prompt and exposes `activate_skill` and
`read_skill_resource` tools when skills are available.

```ts
import { Think, skills } from "@cloudflare/think";
import bundledSkills from "agents:skills"; // resolves to ./skills next to this file

export class MyAgent extends Think<Env> {
  getSkills() {
    return [
      bundledSkills,
      skills.r2(this.env.SKILLS_BUCKET, { prefix: "skills/" })
    ];
  }

  getSkillScriptRunner() {
    return skills.runner({
      loader: this.env.LOADER,
      workspaceInstance: this.workspace
    });
  }
}
```

Bundled skills use the Agents Vite plugin. The `agents:skills` specifier
resolves to a `./skills` directory next to the importing file; use
`agents:skills/<dir>` for a differently named sibling directory:

```ts
import bundledSkills from "agents:skills";
```

The import is typed by ambient declarations shipped with `agents` (importing
`Think`, which pulls in `agents`, is enough; otherwise add
`/// <reference types="agents/skills-module" />`). Without the Vite plugin,
construct a source with `skills.fromManifest(...)`. Sources are applied in
order: the first to register a skill name wins, and duplicate or failing
sources are skipped with a warning instead of failing the agent.

The skills engine itself lives in `agents/skills` (so any agent, including a
plain `@cloudflare/ai-chat` `onChatMessage`, can build a `SkillRegistry`);
`@cloudflare/think` re-exports it as `skills` and wires `getSkills()` into the
turn automatically.

The imported directory should contain one child directory per skill:

```text
src/skills/release-notes/SKILL.md
src/skills/release-notes/scripts/format-release-notes.ts
src/skills/release-notes/references/style-guide.md
```

Bundled resources are packaged with explicit `encoding` metadata. Text resources
are returned directly; binary assets are returned as base64. `read_skill_resource`
can read `{ name, path }` or a qualified path such as
`release-notes/references/style-guide.md`, which helps skills reference resources
from other skills.

Skills are on-demand instructions, not always-on system prompt text. The model
sees the catalog first, then calls `activate_skill` when a user task matches a
skill description. Use `getSystemPrompt()` or a Session context block for
behavior that should apply to every turn.

Script execution is opt-in and **experimental**. `getSkillScriptRunner()`
enables `run_skill_script`, which can run JavaScript, TypeScript, Python, and
Bash scripts under `scripts/`.

JavaScript and TypeScript scripts are function-style:

```ts
import type { SkillRunContext } from "@cloudflare/think";

export default async function run(input: unknown, ctx: SkillRunContext) {
  const guide = ctx.files["references/style-guide.md"]; // bundled text resources
  const summary = await ctx.tools.call("summarize", { input }); // explicit tools
  await ctx.output.writeFile("notes.md", summary); // scratch artifact
  return { ok: true };
}
```

`ctx` is `{ skill, files, workspace, tools, output }`: `ctx.files` holds bundled
text resources by relative path, `ctx.workspace` is gated by the workspace
permission, `ctx.tools` exposes only the tools the runner was given, and
`ctx.output.writeFile(name, content)` returns scratch artifacts without mutating
the workspace. Python and Bash scripts instead use the path-based contract:
`/input.json`, `/context.json`, bundled resources under `/skill`, and `/output`
for artifacts (Python supports both `def run(input, ctx)` and CLI-style scripts).

If `workspaceInstance` is provided, scripts get read-only workspace access by
default. Workspace writes, tools, and network access are opt-in. Scripts default
to a 30 second timeout, which can be overridden with `timeout`. TypeScript
scripts are compiled with `@cloudflare/worker-bundler`; Python scripts run as
Python Dynamic Workers; Bash scripts run through `just-bash`.

Script execution requires a Worker Loader binding:

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

## Exports

| Export                                  | Description                                                   |
| --------------------------------------- | ------------------------------------------------------------- |
| `@cloudflare/think`                     | `Think`, `Session`, `Workspace` — main class + re-exports     |
| `@cloudflare/think/framework`           | Framework manifest discovery and Worker config helpers        |
| `@cloudflare/think/server-entry`        | Framework Worker entry helpers for custom server handlers     |
| `@cloudflare/think/messengers`          | Messenger contracts, Chat SDK bridge, state agent, delivery   |
| `@cloudflare/think/messengers/telegram` | Telegram messenger provider and delivery helpers              |
| `@cloudflare/think/tools/workspace`     | `createWorkspaceTools()` — for custom storage backends        |
| `@cloudflare/think/tools/fetch`         | `createFetchTools()` — opt-in allowlisted HTTP reads          |
| `@cloudflare/think/tools/execute`       | `createExecuteTool()` — sandboxed code execution via codemode |
| `@cloudflare/think/tools/extensions`    | `createExtensionTools()` — LLM-driven extension loading       |
| `@cloudflare/think/extensions`          | `ExtensionManager`, `HostBridgeLoopback` — extension runtime  |
| `@cloudflare/think/vite`                | Think Vite plugin and generated Worker config helpers         |

## Think

### Configuration

| Method / Property          | Default                            | Description                                                                                                                                                                                                                  |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getModel()`               | throws                             | Return the `LanguageModel` to use                                                                                                                                                                                            |
| `getSystemPrompt()`        | careful assistant operating prompt | System prompt (fallback when no context blocks)                                                                                                                                                                              |
| `getTools()`               | `{}`                               | AI SDK `ToolSet` for the agentic loop                                                                                                                                                                                        |
| `getMessengers()`          | `{}`                               | Messenger ingress and delivery declarations                                                                                                                                                                                  |
| `getScheduledTasks()`      | `{}`                               | Code-declared recurring prompts                                                                                                                                                                                              |
| `getDefaultTimezone()`     | `undefined`                        | Default timezone for wall-clock schedules                                                                                                                                                                                    |
| `maxSteps`                 | `10`                               | Max tool-call rounds per turn (property)                                                                                                                                                                                     |
| `sendReasoning`            | `true`                             | Send reasoning chunks to chat clients                                                                                                                                                                                        |
| `configureSession()`       | identity                           | Add context blocks, compaction, search, skills                                                                                                                                                                               |
| `getSkills()`              | `[]`                               | First-class Agent Skills sources                                                                                                                                                                                             |
| `getSkillScriptRunner()`   | `null`                             | Optional runner for `run_skill_script`                                                                                                                                                                                       |
| `getExtensions()`          | `[]`                               | Sandboxed extension declarations (load order)                                                                                                                                                                                |
| `extensionLoader`          | `undefined`                        | `WorkerLoader` binding — enables extensions                                                                                                                                                                                  |
| `workspaceBash`            | `true`                             | Include the default workspace `bash` tool                                                                                                                                                                                    |
| `fetchTools`               | `false`                            | Opt-in allowlisted HTTP read tools (`fetch_url` + per-binding `fetch_<name>`). Set to a config object; see [Fetch tool](#fetch-tool)                                                                                         |
| `chatRecovery`             | `true`                             | Wrap turns in `runFiber` for durable execution. Set `{ maxAttempts, terminalMessage, onExhausted }` to tune bounded recovery                                                                                                 |
| `chatStreamStallTimeoutMs` | `0` (off)                          | Inactivity watchdog: abort a turn whose model stream produces no chunk for this long, surfacing a terminal stream error instead of an infinite spinner                                                                       |
| `contextOverflow`          | `undefined`                        | Opt-in mid-turn context-overflow handling: `{ reactive?, maxRetries?, proactive? }`. Requires `classifyChatError` + a session compaction function. See [Context-window overflow recovery](#context-window-overflow-recovery) |

On each turn, Think appends a small capability block to the assembled system prompt. The block is based on the tools available for that turn, so models learn about workspace tools, context-loading tools, extension tools, sandboxed execution, MCP/client tools, and delegated-agent tools only when they are actually exposed.

Think enables Durable Object eviction recovery by default. This is separate from client resumable streaming: resumable streaming handles browser disconnect/reconnect while the object keeps running, while `chatRecovery` recovers turns interrupted by process restarts, deploys, or object eviction.

`chatStreamStallTimeoutMs` is a separate, opt-in safety net for a different failure: a model stream that **parks without ever throwing** (no chunk, no error, no `done`), which otherwise leaves the client spinning forever. When set, if no UI-message-stream chunk arrives within the window the watchdog aborts the turn and a `chat:stream:stalled` observability event fires. With `chatRecovery` on (the default), the stall is then routed into the **same bounded recovery path** as a deploy/eviction interruption: the settled partial is preserved and a continuation is scheduled, so a transient hang recovers automatically. A persistently hanging provider still terminalizes once the recovery budget is exhausted — and it exhausts through the **same path as deploy recovery**, so your configured `terminalMessage` is shown, `onExhausted` fires, and the `chat:recovery:exhausted` event is emitted (you do **not** get the raw `"Chat stream stalled…"` error). (With `chatRecovery` disabled, the watchdog exits with a terminal stream error via `onChatError` `stage: "stream"`.) When the stalled turn is a sub-agent dispatched via `runAgentTool()`, a recovering stall closes the RPC stream without firing `onError`/`onDone` — the scheduled continuation owns the real terminal outcome, so the parent observes a (slightly delayed) completion rather than an error, exactly as it would for a deploy-interrupted child. It is **off by default** because it measures the gap _between_ stream chunks, which includes server-side tool execution time (no chunks flow while a tool runs) — set it comfortably above your slowest model time-to-first-token and slowest tool, e.g. `120_000`, or you will abort healthy long turns. For a turn you _know_ will invoke a slow tool, return `{ chatStreamStallTimeoutMs }` from `beforeTurn` (a `TurnConfig` field) to raise or disable (`0`) the watchdog for that one turn instead of permanently widening the global window; it auto-resets afterward.

Override `onChatRecovery(ctx)` when you need provider-specific recovery. The default behavior persists partial assistant output and continues or retries when safe:

```ts
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions
} from "@cloudflare/think";

export class MyAgent extends Think<Env> {
  override chatRecovery = {
    maxAttempts: 6,
    terminalMessage: "The assistant was interrupted. Please try again."
  };

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    console.log("Recovering", ctx.incidentId, ctx.attempt, ctx.recoveryKind);
    return {};
  }
}
```

When a turn is interrupted mid-flight, an unsettled tool call left in the
transcript is repaired before the next provider call so the model does not
re-run it (and the provider does not 400 with `AI_MissingToolResultsError`). The
default flips it to an errored tool result; override `repairInterruptedToolPart`
to customize the repaired shape — for example, convert an interrupted
client-resolved `ask_user` (a question with no server `execute`) into a plain
text part carrying the prompt so the model treats it as ordinary conversation:

```ts
protected override repairInterruptedToolPart(
  part: UIMessage["parts"][number]
): UIMessage["parts"][number] {
  const record = part as Record<string, unknown>;
  if (record.type === "tool-ask_user") {
    const input = record.input as { prompt?: string } | undefined;
    if (input?.prompt) return { type: "text", text: input.prompt };
  }
  return super.repairInterruptedToolPart(part);
}
```

While a turn is being recovered, Think broadcasts a `cf_agent_chat_recovering`
status (and replays it on connect) so clients can show a "recovering…" indicator
instead of looking frozen — surface it on the client with `useAgentChat`'s
`isRecovering` flag. It is set when a recovery continuation is scheduled and
cleared on every terminal outcome, so the indicator never spins forever. To
record recovery counts or reasons in your own analytics, subscribe to the
`chat:recovery:*` observability events and route them to your sink.

### Context-window overflow recovery

Compaction (`compactAfter()`) is checked _between_ turns. A single long,
tool-heavy turn can grow the prompt past the model's context window _mid-turn_,
before the next check — the provider then rejects the request
(`"prompt is too long"` / `context_length_exceeded`). Two opt-in,
provider-agnostic layers recover from this (both off by default; both reuse your
session's compaction function):

```ts
import { Think, defaultContextOverflowClassifier } from "@cloudflare/think";

export class MyAgent extends Think<Env> {
  override contextOverflow = {
    // Reactive: compact + re-run a turn that overflows (bounded by maxRetries;
    // terminalizes via onChatError if it cannot help).
    reactive: true,
    // Proactive: compact mid-turn before a step crosses 90% of the window.
    proactive: { maxInputTokens: 200_000 }
  };

  // Teach Think which errors are overflows. The bundled classifier covers the
  // common providers; assign it directly or wrap it to add your own categories.
  override classifyChatError = defaultContextOverflowClassifier;
}
```

Use either layer alone or both together. The proactive guard keys off
model-reported `usage.inputTokens` (no provider strings); the reactive backstop
catches anything that still overflows. The two caps are independent: `maxRetries`
(default `1`) bounds reactive compact-and-retries, while `proactive.maxCompactions`
(default `1`) bounds in-place compactions per turn. Both emit a
`chat:context:compacted` observability event. Recovery is only as effective as
your compaction configuration — a no-op compaction cannot rescue an over-budget
turn. See the
[Think docs](../../docs/think/index.md#context-window-overflow-recovery) for details.

### Scheduled tasks

Use `getScheduledTasks()` for code-declared recurring prompts or deterministic
scheduled handlers. Think reconciles these declarations on startup, stores
durable one-shot schedules for the next occurrence, and re-arms the next
occurrence after each run.

```ts
import { Think } from "@cloudflare/think";
import type { ThinkScheduledTasks } from "@cloudflare/think";

export class Assistant extends Think<Env> {
  getDefaultTimezone() {
    return "Europe/London";
  }

  getScheduledTasks(): ThinkScheduledTasks {
    return {
      weeklyCommitReport: {
        schedule: "every week on monday at 09:00",
        prompt:
          "Compile all my GitHub commits for the last week and write a concise summary."
      },
      workout: {
        schedule: "every day at 08:00 in Europe/London",
        prompt: "Start my workout."
      },
      customerDigest: {
        schedule: "every day at 09:00",
        timezone: "America/New_York",
        metadata: { workflowName: "customer-digest" },
        retry: { maxAttempts: 3 },
        handler: async ({
          idempotencyKey,
          scheduledFor,
          scheduleKind,
          timezone
        }) => {
          await this.env.DIGEST_WORKFLOW.create({
            id: idempotencyKey,
            params: { scheduledFor, scheduleKind, timezone }
          });
        }
      }
    };
  }
}
```

The DSL is intentionally small: `every <n> minutes`, `every <n> hours`,
`every day at HH:mm`, `every weekday at HH:mm`, and
`every week on monday,wednesday at HH:mm`. Wall-clock schedules require either
an inline timezone, a task `timezone`, or `getDefaultTimezone()`. If an alarm is
late, Think runs the intended occurrence once and schedules the next future
occurrence; it does not backfill missed runs.

The return type annotation gives TypeScript literal checks for schedule strings. Think also validates scheduled tasks at runtime during startup reconciliation, so dynamically built objects still fail before schedules are persisted.

Each task must define exactly one of `prompt` or `handler`. Prompt tasks create a
durable submission with `submitMessages()`. Handler tasks receive
`{ taskId, scheduledFor, scheduledForDate, occurrenceKey, idempotencyKey,
schedule, scheduleKind, timezone, metadata }` and are intended for app-owned
work such as creating a Workflow run or writing a run ledger. Delivery is
at-least-once; use `idempotencyKey` or `occurrenceKey` for your own durable
idempotency.

Static declarations reconcile on startup. If `getScheduledTasks()` reads
product-owned data that can change while the Durable Object is live, call
`internal_reconcileScheduledTasks()` after updating that data. During
reconciliation Think records the task row before creating the underlying Agent
schedule, so a `schedule_id` may be temporarily empty if the object is
interrupted mid-reconcile; the next reconcile repairs that pending row. The
task `retry` option retries the prompt or handler action before the failure is
logged. The next occurrence is still scheduled after the action succeeds or
exhausts its retries, so failed occurrences do not block future runs.

### Lifecycle hooks

Think owns the `streamText` call. Hooks fire on every turn regardless of entry path (WebSocket, `chat()`, `saveMessages()`, durable `submitMessages()` execution, `continueLastTurn()`, auto-continuation).

| Hook                            | When it fires                                          | Return                            |
| ------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `beforeTurn(ctx)`               | Before `streamText` — see assembled context            | `TurnConfig` overrides or void    |
| `beforeStep(ctx)`               | Before each model step                                 | `StepConfig` overrides or void    |
| `beforeToolCall(ctx)`           | Before tool's `execute` runs                           | `ToolCallDecision` or void        |
| `afterToolCall(ctx)`            | After tool execution (success or failure)              | void                              |
| `onStepFinish(ctx)`             | After each step completes                              | void                              |
| `onChunk(ctx)`                  | Per streaming chunk (high-frequency)                   | void                              |
| `onChatResponse(result)`        | After turn completes + message persisted               | void                              |
| `onChatError(error, ctx)`       | On error during a turn                                 | error to propagate                |
| `classifyChatError(error, ctx)` | On a turn error, when `contextOverflow.reactive` is on | `ChatErrorClassification` or void |

`onChatError` receives `ctx.stage`, `ctx.requestId`, and `ctx.messagesPersisted`
so apps can distinguish pre-persist request failures from stream failures. The
same failures emit `chat:request:failed` observability events. `ctx.classification`
is set to `"context_overflow"` on the terminal `onChatError` when a context
overflow could not be recovered, and `undefined` otherwise.

`classifyChatError` maps a raw provider error to a provider-agnostic category
(`"context_overflow" | "rate_limit" | "transient" | "fatal" | "unknown"`).
Think ships no provider-specific matching in core — the app owns it, the same
split as the `tokenCounter` passed to `compactAfter()`. Today it drives only
context-overflow recovery: it is consulted when a turn errors and
`contextOverflow.reactive` is enabled, and only `"context_overflow"` is acted on
(other categories are reserved for future use). For the common case, assign the
exported `defaultContextOverflowClassifier` (it matches the context-overflow
errors of Anthropic, OpenAI, Google, Bedrock, and others).

The AI SDK-derived contexts spread the SDK's own types at the top level — no information is dropped:

| Context                        | Backed by                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PrepareStepContext<TOOLS>`    | `Parameters<PrepareStepFunction<TOOLS>>[0]` (`steps`, `stepNumber`, `model`, `messages`, `experimental_context`)                      |
| `ToolCallContext<TOOLS>`       | `TypedToolCall<TOOLS>` + per-call extras from `OnToolCallStartEvent` (`stepNumber`, `messages`, `abortSignal`)                        |
| `ToolCallResultContext<TOOLS>` | `TypedToolCall<TOOLS>` + per-call extras (`durationMs`, `messages`, `stepNumber`) + discriminated `success`/`output`/`error` outcome  |
| `StepContext<TOOLS>`           | `StepResult<TOOLS>` (full step incl. `reasoning`, `sources`, `files`, `usage`, `providerMetadata`, `request`, `response`, `warnings`) |
| `ChunkContext<TOOLS>`          | `Parameters<StreamTextOnChunkCallback<TOOLS>>[0]` (discriminated `TextStreamPart`)                                                    |

`beforeStep` is wired to the AI SDK's `prepareStep` callback. Return a `StepConfig` to override `model`, `toolChoice`, `activeTools`, `system`, `messages`, `experimental_context`, or `providerOptions` for the current step. The AI SDK does not expose `output` or `maxSteps` per step — set those at the turn level via `TurnConfig` (returned from `beforeTurn`). `beforeStep` is subclass-only; it is not dispatched to extensions because the prepareStep event surface includes a live `LanguageModel` instance which is not JSON-safe to snapshot.

`TurnConfig` also accepts `sendReasoning` to override whether reasoning chunks are emitted for the current UI message stream. The instance-level `sendReasoning` property defaults to `true`; return `{ sendReasoning: false }` from `beforeTurn` to hide reasoning for a single turn, for example on internal continuation turns.

`TurnConfig` also accepts stable AI SDK `streamText` call settings such as `maxOutputTokens`, `temperature`, `stopSequences`, `seed`, `maxRetries`, `timeout`, and `headers`. Use them to tune model behavior per turn, for example disabling retries or adding a chunk timeout during recovery flows.

`TurnConfig.stopWhen` accepts AI SDK stop conditions such as `hasToolCall("finalAnswer")` for ending a turn early. Think composes these with its own `maxSteps` bound, so a custom condition can stop before the cap without removing the safety limit. Because stop conditions are functions, return `stopWhen` from a Think subclass's `beforeTurn`; sandboxed extension hooks cannot provide it over RPC.

`TurnConfig` also accepts an `output` field that is forwarded to `streamText` as the AI SDK's structured-output spec. Combine with `activeTools: []` for providers (e.g. `workers-ai-provider`) that strip tools when `responseFormat: "json"` is active. Use `experimental_telemetry` to pass the AI SDK's per-call telemetry settings through to `streamText`; consider disabling `recordInputs` or `recordOutputs` if prompts or outputs may contain sensitive data.

Per-tool hooks are wired so `beforeToolCall` fires _before_ `execute` (Think wraps every tool's `execute`) and `afterToolCall` fires _after_ (via the AI SDK's `experimental_onToolCallFinish`) with `durationMs` and a discriminated outcome. `beforeToolCall` can return a `ToolCallDecision` to:

- `{ action: "allow", input? }` — run the original `execute`, optionally with a substituted `input`.
- `{ action: "block", reason? }` — skip `execute`; the model sees `reason` as the tool's output.
- `{ action: "substitute", output }` — skip `execute`; the model sees `output` as the tool's output.

Pass an explicit `TOOLS` generic when you want full input typing:

```ts
import type {
  PrepareStepContext,
  StepContext,
  ToolCallContext,
  ToolCallResultContext
} from "@cloudflare/think";

const tools = { search: tool({ inputSchema: z.object({ query: z.string() }), ... }) };

beforeStep(ctx: PrepareStepContext<typeof tools>) {
  if (ctx.stepNumber === 0) {
    return {
      activeTools: ["search"],
      toolChoice: { type: "tool", toolName: "search" }
    };
  }
}

beforeToolCall(ctx: ToolCallContext<typeof tools>) {
  if (ctx.toolName === "search") {
    ctx.input.query; // typed as string
    // Clamp the model's `limit` before the tool runs.
    return {
      action: "allow",
      input: { ...ctx.input, limit: Math.min(ctx.input.limit ?? 10, 50) }
    };
  }
}

afterToolCall(ctx: ToolCallResultContext<typeof tools>) {
  if (ctx.success) {
    console.log(`${ctx.toolName} ok in ${ctx.durationMs}ms`, ctx.output);
  } else {
    console.error(`${ctx.toolName} failed:`, ctx.error);
  }
}

onStepFinish(ctx: StepContext<typeof tools>) {
  // Provider-specific cache accounting (Anthropic example)
  const anthropic = ctx.providerMetadata?.anthropic as
    | { cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
    | undefined;
  console.log("cache read:", anthropic?.cacheReadInputTokens ?? 0);
}
```

> Field rename note: the per-tool contexts use the AI SDK's `input`/`output` (formerly `args`/`result` in earlier Think versions). Migrate by renaming references in your hooks. `afterToolCall` is now a discriminated union — read `output` only when `ctx.success === true`.

### Extension hook subscriptions

Extensions can subscribe to `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, and `onChunk` via their manifest's `hooks` array. Think dispatches to extension-side handlers in load order with a JSON-safe snapshot of the event. `beforeStep` is available to subclasses only and is not dispatched to extensions.

```js
// extension source (loaded via getExtensions())
({
  tools: {
    /* ... */
  },
  hooks: {
    beforeToolCall: async (snapshot, host) => {
      /* observation */
    },
    afterToolCall: async (snapshot, host) => {
      await host?.writeFile(
        `logs/${snapshot.toolName}.json`,
        JSON.stringify(snapshot)
      );
    },
    onStepFinish: async (snapshot, host) => {
      /* observation */
    }
    // onChunk is also supported but fires per token — use sparingly.
  }
});
```

The handler signature is `(snapshot, host) => void`, symmetric with tool `execute`. Errors from extension hooks are caught and logged; they do not abort the turn. Only `beforeTurn` honors return values — the other extension hooks are observation-only. See [docs/think/lifecycle-hooks.md](https://github.com/cloudflare/agents/blob/main/docs/think/lifecycle-hooks.md#extension-hook-subscriptions) for the full snapshot shapes.

#### beforeTurn example

```ts
export class MyAgent extends Think<Env> {
  getModel() { ... }

  // Switch to a cheaper model for continuation turns
  beforeTurn(ctx: TurnContext) {
    if (ctx.continuation) {
      return { model: this.cheapModel };
    }
  }
}
```

#### TurnConfig — what you can override per-turn

```ts
interface TurnConfig {
  model?: LanguageModel; // override model
  system?: string; // override system prompt
  messages?: ModelMessage[]; // override assembled messages
  tools?: ToolSet; // extra tools to merge (additive)
  activeTools?: string[]; // limit which tools the model can call
  toolChoice?: ToolChoice; // force a specific tool
  maxSteps?: number; // override maxSteps for this turn
  stopWhen?: StopCondition | StopCondition[]; // additional early-exit conditions
  sendReasoning?: boolean; // send reasoning chunks for this turn
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
  maxRetries?: number;
  timeout?: TimeoutConfiguration;
  headers?: Record<string, string | undefined>;
  providerOptions?: Record<string, unknown>;
  experimental_telemetry?: TelemetrySettings;
}
```

### Client tools

Think supports client-defined tools that execute in the browser. The client sends tool schemas in the chat request body, and Think merges them with server tools automatically.

When the LLM calls a client tool, the tool call chunk is sent to the client. The client executes it and sends back `CF_AGENT_TOOL_RESULT`. Think applies the result, persists the updated message, broadcasts `CF_AGENT_MESSAGE_UPDATED`, and optionally auto-continues the conversation.

Tool approval flows are also supported via `CF_AGENT_TOOL_APPROVAL`.

### Session and context blocks

Think uses Session for conversation storage. Override `configureSession` to add persistent memory, skills, compaction, and search:

```ts
export class MyAgent extends Think<Env> {
  getModel() { ... }

  configureSession(session: Session) {
    return session
      .withContext("memory", { description: "Learned facts", maxTokens: 2000 })
      .withCachedPrompt();
  }
}
```

#### Dynamic context blocks

Context blocks can also be added at runtime (e.g., by extensions):

```ts
await session.addContext("notes", { description: "User notes" });
await session.refreshSystemPrompt(); // rebuild the prompt

session.removeContext("notes");
await session.refreshSystemPrompt();
```

#### Legacy Session Skills

Session still supports lower-level loadable context providers. Prefer the
first-class Think skills API (`getSkills()`, `activate_skill`, and
`read_skill_resource`) for new Agent Skills directories. Use Session skill
providers only when you need generic `load_context` / `unload_context`
management instead of Think's skills workflow.

```ts
import { R2SkillProvider } from "agents/experimental/memory/session";

configureSession(session: Session) {
  return session
    .withContext("skills", {
      provider: new R2SkillProvider(this.env.SKILLS_BUCKET, { prefix: "skills/" })
    })
    .withCachedPrompt();
}
```

### MCP integration

Think inherits MCP client support from the Agent base class. MCP tools are automatically merged into every turn. Set `waitForMcpConnections` to ensure MCP servers are connected before the inference loop runs:

```ts
export class MyAgent extends Think<Env> {
  waitForMcpConnections = true; // or { timeout: 10_000 }
}
```

### Choosing a turn API

Use browser chat through `useAgentChat` when a user drives the conversation. Use
`saveMessages()` when server code controls the trigger and can wait for the
model response. Use `submitMessages()` when a caller needs fast durable
acceptance, idempotent retries, cancellation, and later status inspection.
Use `getScheduledTasks()` when code should create recurring prompt submissions
or deterministic scheduled handlers.

Use `subAgent(...).chat()` for direct streaming RPC to a specific child when
your code owns forwarding and replay policy. Use `agentTool()` or
`runAgentTool()` when a parent agent delegates work to a retained child and you
want event replay, abort bridging, and UI drill-in.

Use `startFiber()` from `agents` outside Think when the durable unit is an
application-owned job around a turn, such as accepting a webhook once, restoring
provider state, and posting a visible reply. `submitMessages()` owns Think's
conversation admission; managed fibers own external side effects and recovery
policy around that turn.

See [Choosing a turn API](../../docs/think/index.md#choosing-a-turn-api) and
[Programmatic Submissions](../../docs/think/programmatic-submissions.md) for the
full API comparison.

### Sub-agent streaming via RPC

When used as a sub-agent (via `this.subAgent()`), the `chat()` method runs a full turn and streams events via a callback:

```ts
interface StreamCallback {
  onStart(event: { requestId: string }): void | Promise<void>;
  onEvent(json: string): void | Promise<void>;
  onDone(): void | Promise<void>;
  onError(error: string): void | Promise<void>;
  // Optional. The attempt was interrupted (a stream-stall watchdog abort routed
  // into bounded recovery) and a scheduled continuation — in a later isolate,
  // without this callback — owns the final outcome. NOT done, NOT a terminal
  // error. Defaults to a no-op, so existing implementers are unaffected.
  onInterrupted?(): void | Promise<void>;
}

const agent = await this.subAgent(MyAgent, "thread-1");
await agent.chat("Summarize the project", relay);
```

`onStart` exposes the request id for RPC-safe cancellation. Call
`agent.cancelChat(requestId, reason)` if the parent needs to stop the child turn
after it has started.

`onInterrupted` matters for a `chat()`-driven turn that is interrupted and
recovers: the RPC promise resolves **cleanly** (the isolate is still alive), so a
consumer that keys off the clean resolve would mis-read it as success and
finalize whatever partial it had streamed. Treat `onInterrupted` as "not done,
not failed — a continuation owns the answer": keep the channel open, show a
recovering state, or re-attach, rather than finalizing the partial. (The built-in
messenger delivery already does this — it surfaces an "interrupted, please retry"
reply instead of posting the truncated partial.) Note: a deploy/eviction
interruption kills the isolate before this can fire — the caller sees a transport
break instead; `onInterrupted` covers the in-isolate stall→recovery path.

Tools belong to the child agent; define them with `getTools()` or use
`agentTool()` / `runAgentTool()` for parent-child orchestration.

### Dynamic configuration

`configure()` and `getConfig()` persist a JSON-serializable config blob in SQLite — useful for private server-side settings that should survive hibernation and restarts. Pass the config shape as a method generic for typed call sites:

```ts
type MyConfig = { modelTier: "fast" | "capable"; systemPrompt: string };

export class MyAgent extends Think<Env> {
  getModel() {
    const tier = this.getConfig<MyConfig>()?.modelTier ?? "fast";
    return createWorkersAI({ binding: this.env.AI })(MODEL_IDS[tier]);
  }
}
```

For values you want broadcast to connected clients, use `state` / `setState` from `Agent` instead.

### Production features

- **WebSocket protocol** — wire-compatible with `useAgentChat` from `@cloudflare/think/react`
- **Built-in workspace** — every agent gets `this.workspace` with file tools auto-wired
- **Lifecycle hooks** — `beforeTurn`, `beforeStep`, `onStepFinish`, `onChunk`, `onChatResponse` fire on every turn
- **Stream resumption** — page refresh replays buffered chunks via `ResumableStream`
- **Client tools** — accept tool schemas from clients, handle results and approvals
- **Durable submissions** — accept webhook/RPC-triggered turns with idempotent retry and status inspection
- **Messengers** — receive Chat SDK webhooks and deliver streamed replies with provider-safe recovery
- **Auto-continuation** — debounce-based continuation after tool results
- **MCP integration** — MCP tools auto-merged, wait for connections before inference
- **Abort/cancel** — pass an `AbortSignal` or send a cancel message
- **Multi-tab broadcast** — all connected clients see the stream (resume-aware exclusions)
- **Partial persistence** — on error, the partial assistant message is saved
- **Message sanitization** — strips ephemeral provider metadata before storage
- **Row size enforcement** — compacts tool outputs exceeding 1.8MB

## Workspace tools

File operation tools are built into Think and available to the model on every turn. For custom storage backends, the individual tool factories are also exported:

```ts
import { createWorkspaceTools } from "@cloudflare/think/tools/workspace";

// Use with a custom ReadOperations/WriteOperations implementation
const tools = createWorkspaceTools(myCustomStorage);
const toolsWithoutBash = createWorkspaceTools(myCustomStorage, { bash: false });
```

Each tool is an AI SDK `tool()` with Zod schemas. The underlying operations are abstracted behind interfaces (`ReadOperations`, `WriteOperations`, etc.) so you can create tools backed by any storage.

## Code execution tool

Let the LLM write and run JavaScript in a sandboxed Worker:

```ts
import { createExecuteTool } from "@cloudflare/think/tools/execute";

getTools() {
  return {
    execute: createExecuteTool({ tools: wsTools, loader: this.env.LOADER })
  };
}
```

Requires `@cloudflare/codemode` and a `worker_loaders` binding in `wrangler.jsonc`.

## Fetch tool

Give the model a conservative, read-only way to read HTTP resources. It is **off by default** — set the `fetchTools` property (static config) or call `createFetchTools()` inside `getTools()` (dynamic/per-tenant). It registers a generic `fetch_url` tool when a public `allowlist` is configured, plus one `fetch_<name>` tool per binding target.

```ts
export class DocsAgent extends Think<Env> {
  getModel() { ... }

  fetchTools = {
    allowlist: ["https://developers.cloudflare.com/**"],
    bindings: {
      docsApi: {
        binding: this.env.DOCS_API, // a service binding / Fetcher
        allowlist: ["/v1/docs/**"],
        headers: { "x-agent": "think" }
      }
    }
  };
}
```

For per-tenant allowlists computed at request time, build the tools in `getTools()` (it runs every turn) instead of using the static property:

```ts
import { createFetchTools } from "@cloudflare/think/tools/fetch";

getTools() {
  return {
    ...createFetchTools({ allowlist: this.allowedOriginsForTenant() })
  };
}
```

Behavior and safety:

- **Read-only** — `GET` only. Mutations belong in explicit, approval-gated actions, not here.
- **Allowlisted** — every request must match the configured allowlist; private, loopback, link-local, and `*.internal` targets are blocked even if the allowlist is misconfigured.
- **Bounded** — `maxBytes` caps the download, `maxModelChars` truncates the model-facing text, and `response: "workspace"` (or `spillToWorkspace: true` with auto) writes large or binary bodies to a workspace file instead of bloating the transcript.
- **Header-safe** — only headers in `modelHeaderAllowlist` (default `accept`, `accept-language`, `range`) may be set by the model; fixed binding headers are server-side only and are stripped on cross-origin redirects.
- **Markdown-first** — a weighted default `Accept` header (`text/markdown` → `text/plain` → `application/json` → `text/html` → `*/*`) nudges content-negotiating endpoints to return clean markdown instead of HTML. Override per call (the model can set `accept`) or globally via `defaultAccept` (set to `""` to disable).
- **Redirects** — followed only when the final URL is still allowlisted (`followRedirects`); binding targets never follow cross-origin redirects.

Results are structured `{ ok, ... }` values: success carries `status`, `finalUrl`, `contentType`, `bytes`, `truncated`, and the `body`/`json`/`path`; failures carry a `code` (`disallowed_url`, `disallowed_redirect`, `timeout`, `non_2xx`, `unsupported_content_type`, `invalid_json`, `too_large`, `request_failed`). A `tool:fetch` observability event fires for each call, including blocked attempts.

Allowlist semantics:

- A bare origin (`https://example.com`) matches that origin and every subpath under it.
- Patterns are globs: `**` matches any characters (including `/`), `*` matches any character except `/`. A pattern with an explicit path and no glob matches that path literally (e.g. `https://x.com/v1` matches only `/v1`, not `/v1/a`).
- Matching ignores the query string and fragment (only scheme + host + port + path are compared); the original query/fragment are still sent.
- Binding allowlists should be path-based (`/v1/docs/**`); a model-supplied absolute URL is only allowed if it matches the binding's allowlist.
- `json` responses are bounded by `maxBytes` (not `maxModelChars`, which only truncates `text`). For large JSON APIs, lower `maxBytes` or use `response: "workspace"`.

You do not need new machinery to gate egress: `beforeToolCall` can `block`/`substitute` a fetch, and channel `tools(...)` policy can narrow the available tools.

### When to use what

- **Fetch tool** — read a known, allowlisted URL or service binding. No code generation.
- **Code execution tool** — compose or transform several calls in sandboxed code (set `globalOutbound` to control its network access).
- **Browser Run** (`@cloudflare/think/tools/browser`) — rendered pages, auth flows, screenshots, CDP automation.
- **Typed tools / `agentTool()`** — call a `WorkerEntrypoint`/Durable Object method with a typed schema, or delegate work to a sub-agent. Do not route these through fetch.

## Extensions

Dynamic tool loading at runtime. The LLM can write extension source code, load it as a sandboxed Worker, and use the new tools on the next turn.

```ts
import { ExtensionManager } from "@cloudflare/think/extensions";
import { createExtensionTools } from "@cloudflare/think/tools/extensions";

const extensions = new ExtensionManager({ loader: this.env.LOADER });

getTools() {
  return {
    ...createExtensionTools({ manager: extensions }),
    ...extensions.getTools()
  };
}
```

## Runtime dependencies

| Package                      | Notes                                                     |
| ---------------------------- | --------------------------------------------------------- |
| `agents`                     | Cloudflare Agents SDK peer dependency                     |
| `ai`                         | Vercel AI SDK v6 peer dependency                          |
| `zod`                        | Schema validation peer dependency                         |
| `@cloudflare/shell`          | Workspace filesystem                                      |
| `@cloudflare/codemode`       | Code execution, `createExecuteTool`, and JS skill scripts |
| `@cloudflare/worker-bundler` | TypeScript skill script compilation                       |
| `just-bash`                  | Bash skill script execution                               |
| `@chat-adapter/telegram`     | Required for Telegram messengers                          |

## Acknowledgments

Think's design is inspired by [pi](https://pi.dev).
