# Think (Experimental)

`@cloudflare/think` is an opinionated chat agent base class for Cloudflare Workers. It handles the full chat lifecycle — agentic loop, message persistence, streaming, tool execution, client tools, stream resumption, and extensions — all backed by Durable Object SQLite.

Think works as both a **top-level agent** (WebSocket chat to browser clients via `useAgentChat`) and a **sub-agent** (RPC streaming from a parent agent via `chat()`).

> **Experimental.** The API surface is stable but may evolve before graduating out of experimental.

## Quick Start

### Install

```sh
npm install @cloudflare/think agents ai @cloudflare/shell zod workers-ai-provider
```

### Server

```typescript
import { Think } from "@cloudflare/think";
import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";

export class MyAgent extends Think<Env> {
  getModel() {
    return createWorkersAI({ binding: this.env.AI })(
      "@cf/moonshotai/kimi-k2.7-code"
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
```

That is it. Think handles the WebSocket chat protocol, message persistence, the agentic loop, message sanitization, stream resumption, client tool support, and workspace file tools. The built-in `read` tool reads text with line numbers and passes images/PDFs through to multimodal-capable models.

## Think Framework

The Think Vite plugin can wire agents from an `agents/` directory into a
generated Worker entry. This removes the hand-written routing boilerplate while
keeping stable Durable Object class names for production deployments.

```typescript
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { think } from "@cloudflare/think/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [think(), cloudflare()]
});
```

### Agent Conventions

Put top-level agents under the root `agents/` directory:

```text
agents/support.ts
agents/assistant/agent.ts
```

Put sub-agents under a nested `agents/` directory owned by the parent:

```text
agents/assistant/agent.ts
agents/assistant/agents/researcher.ts
agents/assistant/agents/code-reviewer/agent.ts
```

Each convention file should export one Agent-compatible class, or a default
declarative `agent({...})` definition. If a module exports multiple
Agent-compatible classes, Think fails with a focused diagnostic so the generated
Durable Object export stays unambiguous.

The framework derives stable generated class names from this topology:

| Convention path                                  | Generated class                        |
| ------------------------------------------------ | -------------------------------------- |
| `agents/support.ts`                              | `ThinkAgent_Support`                   |
| `agents/assistant/agent.ts`                      | `ThinkAgent_Assistant`                 |
| `agents/assistant/agents/researcher.ts`          | `ThinkSubAgent_Assistant_Researcher`   |
| `agents/assistant/agents/code-reviewer/agent.ts` | `ThinkSubAgent_Assistant_CodeReviewer` |

Top-level agents need Durable Object bindings and migrations. The binding
`class_name` must be the generated class, but the binding `name` can stay
app-owned, such as `AssistantDirectory`. Sub-agents are facets: the generated
Worker entry exports their classes so parent agents can use `ctx.exports`, but
production `wrangler.jsonc` does not need facet-only Durable Object bindings,
migrations, or public routes.

Think currently supports top-level agents and one layer of sub-agents. Nested
sub-agent conventions, such as
`agents/assistant/agents/researcher/agents/coder.ts`, are intentionally not
supported yet. If your app needs deeper nesting, please reach out with the use
case so we can design the routing and lifecycle model deliberately.

### Friendly Routes

Generated class names are stable, but URLs stay friendly. A request can use:

```text
/agents/assistant/alice/sub/researcher/chat-1
```

Internally, the Think router resolves `assistant` and `researcher` through the
manifest and adapts the request to the lower-level Agents facet router, which
still expects generated class segments. Repeated child names under different
parents are safe because sub-agent aliases are scoped by parent. Treat this as a
routing helper contract rather than a URL-rewriting API.

Use a custom route prefix when you want agents under another path:

```typescript
think({ routePrefix: "/api/agents" });
```

The generated config and routing diagnostics use that prefix, so direct routes
become:

```text
/api/agents/assistant/alice
```

### Custom App Server

If `src/server.ts` exists, the generated entry calls it first. If it returns
`null` or `undefined`, Think handles the request. Any `Response` stops
fallthrough, including an intentional `404`; auth-gated apps can use that to
prevent direct `/agents/*` access.

```typescript
export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/health") {
      return new Response("ok");
    }

    return null;
  }
};
```

For auth-gated or app-owned routes, use the injected Think router. The generated
entry passes it as the fourth argument to your `fetch()` handler:

```typescript
import { getAgentByName } from "agents";

type ThinkContext = {
  router: {
    routeSubAgent(
      request: Request,
      parent: { fetch(request: Request): Promise<Response> },
      options: { parent: string }
    ): Promise<Response>;
  };
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    think?: ThinkContext
  ) {
    const url = new URL(request.url);

    if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
      const user = await requireUser(request);
      const directory = await getAgentByName(
        env.AssistantDirectory,
        user.login
      );

      if (!think?.router) {
        return new Response(
          'Assistant chat routing requires "main": "virtual:think/entry".',
          { status: 500 }
        );
      }

      return think.router.routeSubAgent(request, directory, {
        parent: "assistant"
      });
    }

    return null;
  }
};
```

This keeps authentication and tenancy in your app code while still letting Think
resolve friendly sub-agent URLs such as `/chat/sub/researcher/chat-1`. If a
request has a `/sub/...` segment that cannot be resolved for the declared parent,
`routeSubAgent()` returns `404`; paths without a `/sub/...` segment continue to
the parent agent.

### React Router Hosts

React Router framework apps can use Think as an additive Vite plugin while
React Router owns the app routes, loaders, and SSR.

See `examples/think-react-router` for a complete runnable example.

```typescript
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { think } from "@cloudflare/think/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    reactRouter(),
    think({ routePrefix: "/api/agents", allowNonVirtualMain: true })
  ]
});
```

```typescript
// react-router.config.ts
import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "app",
  ssr: true,
  future: {
    v8_viteEnvironmentApi: true
  }
} satisfies Config;
```

Point `wrangler.jsonc.main` at a normal Worker entry file and make that file a
tiny Think shim:

```typescript
// src/worker.ts
export { default } from "virtual:think/entry";
export * from "virtual:think/entry";
```

Then delegate ordinary app requests to React Router from `src/server.ts` and
return `null` for Think-owned paths:

```typescript
// src/server.ts
import { createRequestHandler } from "react-router";
import type { ThinkAppContext } from "@cloudflare/think/server-entry";
import type { ServerBuild } from "react-router";

const reactRouterHandler = createRequestHandler(
  () =>
    import("virtual:react-router/server-build").then(
      (mod) => (mod.default ?? mod) as ServerBuild
    ),
  import.meta.env.MODE
);

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    _think?: ThinkAppContext
  ) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/agents/")) {
      return null;
    }

    return reactRouterHandler(request, {
      cloudflare: {
        env,
        ctx
      }
    });
  }
};
```

This is still a normal React Router app: `app/routes.ts`, `app/root.tsx`, and
route modules stay under React Router's conventions. The Worker shim exists so
Think can keep exporting generated Durable Object classes while the host
framework owns app rendering.

### TanStack Start Hosts

TanStack Start apps use the same host-framework shape: the Cloudflare Vite plugin
creates the `ssr` workerd environment, TanStack owns document routing, and Think
handles its route prefix after the app server returns `null`.

See `examples/think-tanstack-start` for a complete runnable example.

```typescript
// vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { think } from "@cloudflare/think/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart(),
    react(),
    think({ routePrefix: "/api/agents", allowNonVirtualMain: true })
  ]
});
```

Use the same Worker shim:

```typescript
// src/worker.ts
export { default } from "virtual:think/entry";
export * from "virtual:think/entry";
```

Then delegate ordinary app requests to TanStack Start:

```typescript
// src/server.ts
import handler from "@tanstack/react-start/server-entry";
import type { ThinkAppContext } from "@cloudflare/think/server-entry";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    _think?: ThinkAppContext
  ) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/agents/")) {
      return null;
    }

    return handler.fetch(request);
  }
};
```

TanStack route modules are also part of the client build. If a route needs
Cloudflare bindings, access them through a TanStack server function instead of
importing `cloudflare:workers` into client-executed code.

### Diagnostics

During Vite build/startup, Think reads `wrangler.jsonc` or `wrangler.json`,
watches Wrangler config files (`wrangler.jsonc`, `wrangler.json`, and
`wrangler.toml`) plus the `agents/` tree, discovers convention agents, and
reports framework-specific diagnostics for:

- `wrangler.jsonc.main` values that bypass `virtual:think/entry`,
- missing Durable Object bindings or migrations for top-level generated classes,
- missing Worker Loader bindings when colocated skills require one,
- custom `assets.run_worker_first` values that omit the configured route prefix,
- duplicate generated class names, agent ids, route ids, or orphan sub-agents.

Platform bindings such as AI, KV, R2, D1, and secrets remain user-owned. Think
does not infer or silently add those bindings.

`wrangler.toml` is watched so dev servers notice config churn, but Think's
framework diagnostics currently parse JSON/JSONC Wrangler config. Prefer
`wrangler.jsonc` for framework apps.

Advanced embedders that intentionally do not use `virtual:think/entry` can opt
out of the `main` diagnostic with:

```typescript
think({ allowNonVirtualMain: true });
```

Use that only when another wrapper still re-exports Think's generated Durable
Object classes.

### CLI Type Generation

Use `think types` to keep Think-specific TypeScript declarations in sync with the
discovered manifest:

```bash
npx @cloudflare/think types
```

By default, the command only writes Think-owned declarations to `think.d.ts`:
`virtual:think/entry`, `virtual:think/router`, generated Durable Object exports,
skill stubs, and the generated Durable Object bindings on `Cloudflare.Env`.

When you also want Wrangler platform declarations, use `--all`. Wrangler flags
can be passed through after `--`:

```bash
npx @cloudflare/think types --all -- --env production
```

With `--all`, Think runs `wrangler types env.d.ts --include-runtime false` before
generating `think.d.ts`. Pass `--wrangler-env-file` to change Wrangler's output
path, or pass `-- --include-runtime true` when you intentionally want Wrangler's
runtime declarations included.

`think types` does not generate an importable Env module. App code can use the
augmented `Cloudflare.Env` directly, or define its own local alias if it prefers
imported types.

Use `think types --check` in CI to verify Think-generated files are current
without modifying the working tree.

## Messengers

Think agents can receive and reply to messenger webhooks directly. Messenger
helpers are exported from `@cloudflare/think/messengers`, while provider
implementations use provider subpaths so unused Chat SDK adapters are not
bundled.

For Telegram messengers, also install the Telegram adapter:

```bash
npm install @chat-adapter/telegram
```

```typescript
import { Think } from "@cloudflare/think";
import {
  defineMessengers,
  ThinkMessengerStateAgent
} from "@cloudflare/think/messengers";
import telegramMessenger from "@cloudflare/think/messengers/telegram";

export { ThinkMessengerStateAgent };

export class SupportAgent extends Think<Env> {
  getMessengers() {
    return defineMessengers({
      telegram: telegramMessenger({
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: "support_bot",
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
      })
    });
  }
}
```

The root Think agent handles messenger webhook routes before user-defined
`onRequest` fallback. By default, the `telegram` key maps to
`/messengers/telegram/webhook`. Direct messages and mentions route to the model
by default. New mentions subscribe the thread so later mentions are still
observed; ordinary subscribed-thread messages and button actions are opt-in with
`respondTo: ["subscribed-thread", "action"]`. Each Chat SDK thread gets its own
Think sub-agent for memory isolation. A root agent owns one Chat SDK runtime for
all configured messengers, so multiple providers share state and webhook
handling without competing over Chat SDK singleton registration.

Use `conversation: "self"` to run messenger turns on the root Think agent:

```typescript
telegramMessenger({
  token: this.env.TELEGRAM_BOT_TOKEN,
  userName: "support_bot",
  secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
  conversation: "self"
});
```

Messenger state is backed by `agents/chat-sdk`. Export
`ThinkMessengerStateAgent` from the Worker module so sub-agent routing can
resolve it. Production applications do not need a separate Durable Object
binding or migration for the state agent when it is mounted as a sub-agent
facet.

Inbound messenger replies use `chat()` with a streaming callback inside an
idempotent root-agent fiber. Use `submitMessages()` for non-streaming
programmatic sends, scheduled digests, or background work. Normalized messenger
events include thread, author, message, capabilities, actions, and attachment
metadata. Attachment bytes are fetched only when the provider supplies a safe
fetch function.

Messenger reply recovery stores serializable event and thread snapshots. If a
Durable Object restarts before streaming starts, Think can resume the answer; if
it restarts after streaming has begun, the delivery policy posts the configured
interruption message. `getMessengerContext()` returns the initiating messenger
context during the turn. Telegram webhook verification must be explicit: set
`secretToken`, provide `verifyWebhook`, or use `verifyWebhook: false` to opt out
intentionally. Custom `chatSdkMessenger()` definitions must also choose a
verification posture explicitly. Delivery failures use a generic user-facing
error by default so internal exception details are not posted into external
chats.

### Client

```tsx
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";

function Chat() {
  const agent = useAgent({ agent: "MyAgent" });
  const { messages, sendMessage, status } = useAgentChat({ agent });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          <strong>{msg.role}:</strong>
          {msg.parts.map((part, i) =>
            part.type === "text" ? <span key={i}>{part.text}</span> : null
          )}
        </div>
      ))}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const input = e.currentTarget.elements.namedItem(
            "input"
          ) as HTMLInputElement;
          sendMessage({ text: input.value });
          input.value = "";
        }}
      >
        <input name="input" placeholder="Send a message..." />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}
```

### Manual wrangler.jsonc

This manual configuration is for using `Think` directly without the Think Vite
framework conventions. If you are using `think()` from `@cloudflare/think/vite`,
keep `main` set to `virtual:think/entry` and use the generated class names shown
in the framework section above.

```jsonc
{
  "compatibility_date": "2026-01-28",
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI" },
  "durable_objects": {
    "bindings": [{ "class_name": "MyAgent", "name": "MyAgent" }]
  },
  "migrations": [{ "new_sqlite_classes": ["MyAgent"], "tag": "v1" }],
  "main": "src/server.ts"
}
```

## Think vs AIChatAgent

Both Think and [`AIChatAgent`](../chat-agents.md) extend `Agent` and speak the same `cf_agent_chat_*` WebSocket protocol. They serve different goals.

**AIChatAgent** is a protocol adapter. You override `onChatMessage` and are responsible for calling `streamText`, wiring tools, converting messages, and returning a `Response`. AIChatAgent handles the plumbing — message persistence, streaming, abort, resume — but the LLM call is entirely your concern.

**Think** is an opinionated framework. It makes decisions for you: `getModel()` returns the model, `getSystemPrompt()` or `configureSession()` sets the prompt, `getTools()` returns tools. The default `onChatMessage` runs the complete agentic loop. You override individual pieces, not the whole pipeline.

| Concern                | AIChatAgent                                                      | Think                                                               |
| ---------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Minimal subclass**   | ~15 lines (wire `streamText` + tools + system prompt + response) | 3 lines (`getModel()` only)                                         |
| **Storage**            | Flat SQL table                                                   | Session: tree-structured messages, context blocks, compaction, FTS5 |
| **Regeneration**       | Destructive (old response deleted)                               | Non-destructive branching (old responses preserved)                 |
| **Context management** | Manual                                                           | Context blocks with LLM-writable persistent memory                  |
| **Sub-agent RPC**      | Not built in                                                     | `chat()` with `StreamCallback`                                      |
| **Programmatic turns** | `saveMessages()`                                                 | `saveMessages()`, `submitMessages()`, `continueLastTurn()`          |
| **Compaction**         | `maxPersistedMessages` (deletes oldest)                          | Non-destructive summaries via overlays                              |
| **Search**             | Not available                                                    | FTS5 full-text search per-session and cross-session                 |

### When to use AIChatAgent

- You need full control over the LLM call (RAG, multi-model, custom streaming)
- You are migrating from AI SDK v4 (`autoTransformMessages` provides the bridge)
- You want the `Response` return type for HTTP middleware or testing
- You are building a simple chatbot with no memory requirements

### When to use Think

- You want to ship fast (3-line subclass with everything wired)
- You need persistent memory (context blocks the model can read and write)
- You need long conversations (non-destructive compaction)
- You need conversation search (FTS5)
- You are building a sub-agent system (parent-child RPC with streaming)
- You need proactive agents (programmatic turns from scheduled tasks or webhooks)
- You need durable async submission for webhook/RPC callers — see [Programmatic submissions](./programmatic-submissions.md)

## Choosing a Turn API

Think has several ways to start or continue a turn. Choose based on who is
driving the work and what the caller needs back.

| Use case                                                       | API                                             |
| -------------------------------------------------------------- | ----------------------------------------------- |
| A browser user sends chat messages                             | `useAgentChat` over the WebSocket chat protocol |
| Server code can wait for the model response                    | `saveMessages()`                                |
| Server code needs fast durable acceptance and later status     | `submitMessages()`                              |
| Code should create recurring prompt-driven turns or handlers   | `getScheduledTasks()`                           |
| Parent code needs direct streaming RPC to a specific child     | `subAgent(...).chat()`                          |
| A parent agent delegates work to a retained child agent        | `agentTool()` or `runAgentTool()`               |
| Surround a turn with idempotent app-owned side effects         | `startFiber()`                                  |
| Coordinate multi-step durable orchestration                    | Workflows                                       |
| Add context or messages without starting a model turn          | `persistMessages()`                             |
| Advanced subclass or recovery code continues an assistant turn | `continueLastTurn()`                            |

Use [`saveMessages()`](./sub-agents.md#programmatic-turns-with-savemessages)
when the caller owns the trigger and can wait for the turn to finish. Use
[`submitMessages()`](./programmatic-submissions.md) when timeout ambiguity would
make retries unsafe.

Use [`chat()`](./sub-agents.md#sub-agent-via-chat) for low-level parent-to-child
streaming when your code owns forwarding, cancellation, and replay policy. Use
[Agent Tools](../agent-tools.md) when a parent model or workflow delegates to a
child agent and you want retained child runs, event replay, abort bridging, and
UI drill-in.

Use [`startFiber()`](../durable-execution.md#startfiber) outside Think when the
durable unit is an application job around a turn: accepting a webhook once,
restoring a serialized channel/thread target, posting a visible reply, or
recording app-level recovery policy. Think submissions own conversation
admission and turn serialization; managed fibers own external job acceptance,
idempotent side effects, and application recovery. Think and AIChat internals
continue to use raw `runFiber()` for stream recovery because those fibers are
internal recovery records, not externally inspectable application jobs.

Use [Workflows](../workflows.md) when the durable unit is a multi-step process
with retries per step, long waits, external events, or approvals.

## Configuration Overrides

| Method / Property          | Default                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getModel()`               | throws                           | Return the `LanguageModel` to use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `getSystemPrompt()`        | `"You are a helpful assistant."` | System prompt (fallback when no context blocks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `getTools()`               | `{}`                             | AI SDK `ToolSet` for the agentic loop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `getScheduledTasks()`      | `{}`                             | Code-declared recurring prompts or handlers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `getDefaultTimezone()`     | `undefined`                      | Default timezone for wall-clock scheduled tasks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `getMessengers()`          | `{}`                             | Messenger ingress and delivery declarations — see [Messengers](./messengers.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `maxSteps`                 | `10`                             | Max tool-call rounds per turn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sendReasoning`            | `true`                           | Send reasoning chunks to chat clients                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `configureSession()`       | identity                         | Add context blocks, compaction, search, skills — see [Sessions](../sessions.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `getSkills()`              | `[]`                             | Return Agent Skills sources for on-demand skill activation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `getSkillScriptRunner()`   | `null`                           | Enable the optional `run_skill_script` tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `workspaceBash`            | `true`                           | Include or configure the default workspace `bash` tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `messageConcurrency`       | `"queue"`                        | How overlapping submits behave — see [Client Tools](./client-tools.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `waitForMcpConnections`    | `false`                          | Wait for MCP servers before inference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `chatRecovery`             | `true`                           | Wrap turns in `runFiber` for durable execution, including sub-agent turns. Set to `{ maxAttempts, stableTimeoutMs, terminalMessage, onExhausted }` to tune bounded recovery.                                                                                                                                                                                                                                                                                                                                                                                     |
| `chatStreamStallTimeoutMs` | `0` (off)                        | Opt-in inactivity watchdog: abort a turn whose model stream produces no chunk for this long (measures the gap between chunks, including tool execution — set above your slowest model TTFT + tool, e.g. `120_000`). Emits a `chat:stream:stalled` event; with `chatRecovery` on (the default) the stall routes into bounded recovery (see below) instead of an infinite spinner, and only terminalizes once the budget is exhausted. Override per-turn via `TurnConfig.chatStreamStallTimeoutMs` (returned from `beforeTurn`) for a turn with a known-slow tool. |
| `contextOverflow`          | `undefined`                      | Opt-in mid-turn context-overflow handling: `{ reactive?, maxRetries?, proactive? }`. Requires `classifyChatError` + a session compaction function. See [Context-window overflow recovery](#context-window-overflow-recovery).                                                                                                                                                                                                                                                                                                                                    |

## Agent Skills

Think supports [Agent Skills](https://agentskills.io/) as on-demand
instructions. A skill source provides a catalog of skill names and descriptions;
Think adds that catalog to the system prompt and exposes tools the model can use
when a user task matches a skill.

Bundled skills are usually imported with the Think Vite plugin, which includes
the Agent Skills import support:

```typescript
import { Think, skills } from "@cloudflare/think";
import bundledSkills from "agents:skills"; // resolves to ./skills next to this file

type Env = {
  AI: Ai;
  LOADER: WorkerLoader;
  SKILLS_BUCKET: R2Bucket;
};

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

`agents:skills` resolves to a `./skills` directory next to the importing file;
use `agents:skills/<dir>` to point at a differently named sibling directory.
The `agents:skills` import is typed by ambient declarations that ship with
`agents`, so importing `Think` in the same file brings the type into scope (for
a file that imports only the specifier, add
`/// <reference types="agents/skills-module" />`). If you are not using the
Agents Vite plugin, build a source with `skills.fromManifest(...)` instead.

The skills engine lives in `agents/skills` and is framework-agnostic, so any
agent (including a plain `@cloudflare/ai-chat` `onChatMessage`) can build a
`SkillRegistry`; `@cloudflare/think` re-exports it as `skills` and wires
`getSkills()` into the turn automatically.

Sources are applied in order; the first source to register a skill name wins,
and later duplicates (or a source that fails to load) are skipped with a logged
warning rather than failing the agent.

The imported directory should contain one child directory per skill:

```text
agents/my-agent/skills/release-notes/SKILL.md
agents/my-agent/skills/release-notes/scripts/format-release-notes.ts
agents/my-agent/skills/release-notes/references/style-guide.md
```

When skills are available, Think exposes:

| Tool                  | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `activate_skill`      | Load a matching skill's instructions and bundled resource list      |
| `read_skill_resource` | Read a bundled resource by `{ name, path }` or `skill-name/path`    |
| `run_skill_script`    | Run a bundled script when `getSkillScriptRunner()` returns a runner |

Skills are not always-on system prompt text. Use `getSystemPrompt()` or a
Session context block for behavior that should apply to every turn. Use skills
for task-specific procedures, references, scripts, templates, and assets that
should be loaded only when relevant.

Script execution is opt-in and requires a Worker Loader binding:

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

`skills.runner()` is experimental and runs JavaScript, TypeScript, Python, and
Bash scripts under `scripts/`. TypeScript is compiled with
`@cloudflare/worker-bundler`; Python runs as Python Dynamic Workers; Bash runs
through `just-bash`.

JavaScript and TypeScript scripts are function-style:

```typescript
import type { SkillRunContext } from "@cloudflare/think";

export default async function run(input: unknown, ctx: SkillRunContext) {
  const guide = ctx.files["references/style-guide.md"]; // bundled text resources
  const docs = await ctx.workspace.readFile("README.md"); // gated by permission
  const summary = await ctx.tools.call("summarize", { input }); // explicit tools
  await ctx.output.writeFile("notes.md", summary); // scratch artifact
  return { ok: true };
}
```

`ctx` is `{ skill, files, workspace, tools, output }`. `ctx.files` holds bundled
text resources by relative path, `ctx.workspace` is gated by the workspace
permission, `ctx.tools` only exposes tools the runner was given, and
`ctx.output.writeFile(name, content)` returns scratch artifacts to the model
(it does not mutate the workspace). Python and Bash use the path-based contract
instead: `/input.json`, `/context.json`, bundled resources under `/skill`, and
`/output` for artifacts.

Passing `workspaceInstance` gives scripts read-only workspace access by default.
Network access, tools, and workspace writes are opt-in. The default timeout is
30 seconds.

### Chat Recovery

Think wraps chat turns in recoverable fibers by default. If the Durable Object is evicted mid-stream, Think reconstructs any buffered chunks, persists partial output, and schedules either a continuation of the assistant turn or a retry of the unanswered user turn.

A stream-stall watchdog abort (`chatStreamStallTimeoutMs`, above) is treated as just another interruption: when `chatRecovery` is on, a stall routes into this same bounded path — the settled partial is preserved and a continuation is scheduled — so a transient hang recovers automatically. A persistently hanging provider exhausts the budget and terminalizes through the **same** exhaustion handling as a deploy/eviction interruption: `onExhausted` fires, the `chat:recovery:exhausted` event is emitted, and the configured `terminalMessage` is shown (not a raw stall error).

Override `onChatRecovery` when you need provider-specific recovery, such as retrieving a stored OpenAI Responses result instead of issuing a new model call:

```typescript
import type {
  ChatRecoveryContext,
  ChatRecoveryOptions
} from "@cloudflare/think";

export class MyAgent extends Think<Env> {
  override chatRecovery = {
    maxAttempts: 10,
    terminalMessage: "The assistant was interrupted. Please try again."
  };

  override async onChatRecovery(
    ctx: ChatRecoveryContext
  ): Promise<ChatRecoveryOptions> {
    console.log("Recovering chat turn", ctx.incidentId, ctx.attempt);
    return {}; // persist partial output and continue/retry when possible
  }
}
```

The same recovery events are available through `agents/observability` on the `chat` channel. Transcript repairs are emitted on the `transcript` channel.

#### Repairing interrupted tool calls

When a turn is interrupted mid-flight, the transcript can contain a tool call with no settled result. Before the next provider call, Think repairs each such call so the model does not silently re-run it and the provider does not reject the transcript with `AI_MissingToolResultsError`. The default flips the interrupted call to an errored tool result, so the record survives and conversion still has a tool result for it.

Override `repairInterruptedToolPart` to customize the repaired shape. The common case is a client-resolved tool — for example an `ask_user` question that has no server `execute` and is normally answered by the user's next message. Converting it to a plain text part lets the model treat it as ordinary conversation rather than a tool error, and keeps the question verbatim through compaction:

```typescript
import type { UIMessage } from "ai";

export class MyAgent extends Think<Env> {
  protected override repairInterruptedToolPart(
    part: UIMessage["parts"][number]
  ): UIMessage["parts"][number] {
    const record = part as Record<string, unknown>;
    if (record.type === "tool-ask_user") {
      const input = record.input as { prompt?: string } | undefined;
      if (input?.prompt) {
        return { type: "text", text: input.prompt };
      }
    }
    return super.repairInterruptedToolPart(part);
  }
}
```

This runs during transcript repair — before the repaired transcript is persisted and sent to the model — so the conversion shapes the current turn, not just the next one. The `input` is already normalized to a valid object. A returned tool part must carry a settled result (`output-available`, `output-error`, or `output-denied`); returning a non-tool part such as text is also fine.

### Context-window overflow recovery

[Compaction](../sessions.md#compaction) is checked **between turns** — `compactAfter()` runs after each `appendMessage()`. But a single long, tool-heavy turn grows the prompt step by step inside one `streamText` loop and can exceed the model's context window **mid-turn**, before the next pre-turn check. The provider then rejects the request (`"prompt is too long"`, `context_length_exceeded`), and the turn would otherwise die terminally.

Think recovers from this with two opt-in, provider-agnostic layers, both configured through the `contextOverflow` property. Both are off by default, so existing behavior is unchanged. Both reuse your session's compaction function, so they require a `configureSession()` with `onCompaction()` configured. Both require [`classifyChatError`](./lifecycle-hooks.md#classifychaterror) to tell Think which errors are overflows — Think ships no provider-specific matching in core.

**1. Reactive backstop — `contextOverflow.reactive`.** When a turn fails with an error you classify as `"context_overflow"`, Think discards the truncated partial, runs `session.compact()`, and re-runs the turn from the compacted history. The partial is not persisted: the turn restarts from scratch, so keeping the cut-off assistant message would orphan it beside the recovered answer. It is bounded by `contextOverflow.maxRetries` (default `1`); if compaction cannot shorten history or the budget is spent, the overflow surfaces terminally through `onChatError` with `classification: "context_overflow"` — it never loops or ends silently.

```typescript
import { Think, defaultContextOverflowClassifier } from "@cloudflare/think";

export class MyAgent extends Think<Env> {
  override contextOverflow = { reactive: true };

  // The bundled classifier covers the common providers (Anthropic, OpenAI,
  // Google, Bedrock, …). Assign it directly, or write your own.
  override classifyChatError = defaultContextOverflowClassifier;
}
```

**2. Proactive guard — `contextOverflow.proactive`.** Heads off the provider error before it happens. Before each step, Think reads the previous step's model-reported `usage.inputTokens` (provider-agnostic) and, if it crosses `maxInputTokens * (headroom ?? 0.9)`, compacts in place and feeds the recompacted history into the upcoming step. If a provider omits `inputTokens`, it falls back to `usage.totalTokens` (a safe over-approximation — it compacts slightly early rather than missing the threshold). It compacts at most `proactive.maxCompactions` times per turn (default `1`) — independent of the reactive `maxRetries` budget — so a history that cannot shorten does not compact on every step.

```typescript
import { Think, defaultContextOverflowClassifier } from "@cloudflare/think";

export class MyAgent extends Think<Env> {
  override contextOverflow = {
    reactive: true,
    // Compact mid-turn once a step approaches 90% of a 200K window.
    proactive: { maxInputTokens: 200_000 }
  };

  override classifyChatError = defaultContextOverflowClassifier;
}
```

Use either layer alone, or both together: the proactive guard avoids most overflows, and the reactive backstop catches any that still slip through (for example, a turn that starts already over budget, or a single tool result so large that compaction cannot help — in which case it terminalizes cleanly). Both apply to every turn entry path (WebSocket, sub-agent `chat()`, and programmatic `saveMessages()` / `submitMessages()`), and both emit a `chat:context:compacted` [observability event](../observability.md#chat-context-events).

> A no-op compaction cannot rescue an over-budget turn, so recovery is only as effective as your compaction configuration. For tool-heavy histories, configure a `tokenCounter` on `compactAfter()` (see [Sessions](../sessions.md#auto-compaction)).

For a runnable demo against a real Workers AI model, see [`examples/context-overflow-recovery`](../../examples/context-overflow-recovery).

## Dynamic Configuration

`configure()` and `getConfig()` persist a JSON-serializable config blob in SQLite. It survives hibernation and restarts. Pass the config shape as a method-level generic for typed call sites:

```typescript
type MyConfig = { modelTier: "fast" | "capable"; theme: string };

export class MyAgent extends Think<Env> {
  getModel() {
    const tier = this.getConfig<MyConfig>()?.modelTier ?? "fast";
    const models = {
      fast: "@cf/moonshotai/kimi-k2.7-code",
      capable: "@cf/meta/llama-4-scout-17b-16e-instruct"
    };
    return createWorkersAI({ binding: this.env.AI })(models[tier]);
  }
}
```

| Method                 | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `configure<T>(config)` | Persist a config object (type checked via the method generic) |
| `getConfig<T>()`       | Read the persisted configuration, or null if never configured |

Prefer `state` / `setState` from `Agent` when you want the value broadcast to connected clients. Use `configure` for private, server-side settings.

Expose configuration to the client via `@callable`:

```typescript
import { callable } from "agents";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  @callable()
  updateConfig(config: MyConfig) {
    this.configure<MyConfig>(config);
  }
}
```

## Scheduled Tasks

Use `getScheduledTasks()` when code should create recurring Think turns or
deterministic scheduled handlers. Think reconciles the declarations on startup,
stores a durable one-shot schedule for the next occurrence, and re-arms the next
occurrence after each run.

```typescript
import { Think, defineScheduledTasks } from "@cloudflare/think";

export class DigestAgent extends Think<Env> {
  getDefaultTimezone() {
    return "Europe/London";
  }

  getScheduledTasks() {
    return defineScheduledTasks({
      weeklyCommitReport: {
        schedule: "every week on monday at 09:00",
        prompt:
          "Compile all my GitHub commits for the last week and send a concise summary."
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
    });
  }
}
```

The DSL supports `every <n> minutes`, `every <n> hours`,
`every day at HH:mm`, `every weekday at HH:mm`, and
`every week on monday,wednesday at HH:mm`. Wall-clock schedules require either
an inline timezone, a task `timezone`, or `getDefaultTimezone()`. If an alarm is
late, Think runs the intended occurrence once and schedules the next future
occurrence; it does not backfill missed runs.

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
schedule, so a missing `schedule_id` is only a pending reconcile state and is
repaired on the next reconcile. The task `retry` option retries the prompt or
handler action before the failure is logged. The next occurrence is still
scheduled after the action succeeds or exhausts its retries, so failed
occurrences do not block future runs.

## Session Integration

Think uses [Session](../sessions.md) for conversation storage. Override `configureSession` to add persistent memory, compaction, search, and skills:

```typescript
import { Think, Session } from "@cloudflare/think";

export class MyAgent extends Think<Env> {
  getModel() {
    /* ... */
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: { get: async () => "You are a helpful coding assistant." }
      })
      .withContext("memory", {
        description: "Important facts learned during conversation.",
        maxTokens: 2000
      })
      .withCachedPrompt();
  }
}
```

Think's `this.messages` getter reads directly from Session's tree-structured storage. Context blocks, compaction overlays, and search are all handled by Session. See the [Sessions documentation](../sessions.md) for the full API.

## Package Exports

| Export                                  | Description                                                   |
| --------------------------------------- | ------------------------------------------------------------- |
| `@cloudflare/think`                     | `Think`, `Session`, `Workspace`, `skills` namespace           |
| `@cloudflare/think/framework`           | Framework manifest discovery and declarative `agent()` helper |
| `@cloudflare/think/server-entry`        | Framework Worker entry helpers for custom server handlers     |
| `@cloudflare/think/messengers`          | Messenger contracts, Chat SDK bridge, state agent, delivery   |
| `@cloudflare/think/messengers/telegram` | Telegram messenger provider and delivery helpers              |
| `@cloudflare/think/workflows`           | `ThinkWorkflow`, `step.prompt()` — Workflow prompts           |
| `@cloudflare/think/tools/workspace`     | `createWorkspaceTools()` — for custom storage backends        |
| `@cloudflare/think/tools/execute`       | `createExecuteTool()` — sandboxed code execution via codemode |
| `@cloudflare/think/tools/extensions`    | `createExtensionTools()` — LLM-driven extension loading       |
| `@cloudflare/think/extensions`          | `ExtensionManager`, `HostBridgeLoopback` — extension runtime  |
| `@cloudflare/think/vite`                | Think Vite plugin and generated Worker config helpers         |

## Dependencies

Peer dependencies you provide:

| Package                  | Required | Notes                                        |
| ------------------------ | -------- | -------------------------------------------- |
| `agents`                 | yes      | Cloudflare Agents SDK                        |
| `ai`                     | yes      | Vercel AI SDK v6                             |
| `zod`                    | yes      | Schema validation (v4)                       |
| `@chat-adapter/telegram` | optional | Required for Telegram messengers             |
| `vite`                   | optional | Required for the Think Vite plugin (`/vite`) |

Bundled with `@cloudflare/think`:

| Package                | Notes                                                 |
| ---------------------- | ----------------------------------------------------- |
| `@cloudflare/shell`    | `Workspace` filesystem                                |
| `@cloudflare/codemode` | Code execution for `createExecuteTool()`              |
| `just-bash`            | Sandboxed shell for the default workspace `bash` tool |
| `aywson`               | Wrangler JSON/JSONC parsing for the framework plugin  |

The Agent Skills engine and its script runner live in
[`agents/skills`](../../packages/agents/AGENTS.md) (so skill scripts pull
`@cloudflare/worker-bundler` and `just-bash` through `agents`, not Think).

## Docs

- [Getting Started](./getting-started.md) — Build a Think agent step by step
- [Lifecycle Hooks](./lifecycle-hooks.md) — `beforeTurn`, `beforeStep`, `onStepFinish`, `onChunk`, `onChatResponse`, and more
- [Tools](./tools.md) — Workspace tools, code execution, extensions
- [Messengers](./messengers.md) — Chat SDK messenger ingress and delivery
- [Client Tools](./client-tools.md) — Browser-side tools, approvals, and concurrency
- [Sub-agents and Programmatic Turns](./sub-agents.md) — RPC streaming, `saveMessages`, recovery
- [Programmatic Submissions](./programmatic-submissions.md) — durable acceptance, idempotent retry, cancellation, and status inspection
- [Workflows](./workflows.md) — `ThinkWorkflow`, `step.prompt()`, structured output, and long-running workflow steps
