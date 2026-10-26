# Cloudflare Agents

[![npm version](https://img.shields.io/npm/v/agents)](https://www.npmjs.com/package/agents)
[![npm downloads](https://img.shields.io/npm/dw/agents)](https://www.npmjs.com/package/agents)

![npm install agents](https://raw.githubusercontent.com/cloudflare/agents/main/assets/npm-install-agents.svg)

**Build AI agents on Cloudflare.** Each agent is a [Durable Object](https://developers.cloudflare.com/durable-objects/) with its own SQLite database. It runs a model loop with tools that survives restarts, and it hibernates when idle. You can run millions of them, one per user, task or conversation, and an idle agent costs nothing.

[Read the docs](https://developers.cloudflare.com/agents/) · [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi)

## Quick start

This agent runs [Pi](https://github.com/earendil-works/pi/tree/main/packages/durable) on a Workers AI model, with one tool: it can read web pages. Install the Agents SDK and Pi:

```sh
npm install agents @earendil-works/pi-durable@~1.4.0 @earendil-works/pi-ai@~1.4.0 @earendil-works/chord@~1.4.0
```

Create `src/server.ts`:

```ts
import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { webFetchTool } from "agents/webfetch/pi";

export class Assistant extends DurableObject<Env> {
  readonly ai = createAI({ binding: this.env.AI });
  readonly registry = createRegistry();

  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      this.registry.install({
        name: "assistant",
        tools: [webFetchTool({ binding: this.env.AI })]
      });
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        { models, registry: this.registry, onWake },
        context
      );
    },
    defaults: { model: this.ai("@cf/zai-org/glm-5.3-flash") }
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async ask(prompt: string) {
    return (await this.harness.prompt(prompt)).text;
  }
}

export default {
  // Anyone with this URL can use your AI quota. Add auth before you deploy.
  async fetch(request: Request, env: Env) {
    const assistant = env.Assistant.getByName("default");
    return new Response(await assistant.ask(await request.text()));
  }
} satisfies ExportedHandler<Env>;
```

Create `wrangler.jsonc`:

```jsonc
{
  "name": "assistant",
  "main": "src/server.ts",
  "compatibility_date": "2026-06-11",
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI" },
  "durable_objects": {
    "bindings": [{ "name": "Assistant", "class_name": "Assistant" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Assistant"] }]
}
```

Generate the `Env` type, start the agent and ask it something:

```sh
npx wrangler types
npx wrangler dev
curl -d "Summarize https://developers.cloudflare.com/agents/" http://localhost:8787
```

Workers AI runs on your Cloudflare account, so `wrangler dev` asks you to log in. Run `npx wrangler deploy` to deploy it.

To start from a complete app instead, deploy the Pi harness example. It adds a chat UI over WebSockets, a filesystem and code execution:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi)

## How an agent is built

An agent is a Durable Object. A Lifecycle runs the object, and capabilities plug into the Lifecycle: a harness that runs the model loop, a scheduler, WebSockets and others. You add only the ones your agent needs, and each one keeps its data in the object's SQLite database.

The sections below take the quick start apart and then extend it, one capability at a time. Each snippet shows only what it adds to `Assistant`.

### 1. An agent is a Durable Object

A Durable Object is a class with a name. `env.Assistant.getByName("alice")` always reaches the same instance, wherever the request comes from, and there is only ever one of it. Each instance has its own SQLite database at `this.ctx.storage.sql`. When nothing is happening, it leaves memory and costs nothing; the next request starts it again with its data intact.

`Lifecycle.install(this)` turns the object into an agent host:

```ts
export class Assistant extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  onStart() {
    // Runs each time the object starts, before it handles anything.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sent_emails (id TEXT, recipient TEXT, subject TEXT)"
    );
  }
}
```

The Lifecycle takes over the object's `fetch`, `alarm` and WebSocket handlers. It runs `onStart`, routes requests, messages and alarms to the capabilities you add with `.use()`, and shares the object's one alarm between them.

### 2. Give it a model loop

A harness is the capability that runs the model loop: it sends the conversation to the model, runs the tools the model calls, and repeats until the model answers. `PiHarness` runs [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable). Pi saves every step, from your input to each model response and tool call, before acting on it. If the object leaves memory mid-turn, the Lifecycle starts it again with an alarm, and Pi carries on where it stopped.

In the quick start, `PiHarness` calls the factory you give it to open Pi over the object's storage. Pi passes `onWake` back so the Lifecycle knows when to set the alarm. Once it is installed, you can talk to the agent in a few ways:

```ts
// Wait for the answer.
const { text } = await this.harness.prompt("What is 47 × 19?");

// Or hand over the input and return. Pi has saved it once this resolves.
await this.harness.submit("Summarize today's notes.");

// Each session has its own transcript, inbox and model.
const session = await this.harness.sessions.create();
await session.setModel(this.ai("anthropic/claude-opus-5.5"));
```

`createAI` from `agents/models/pi-ai` turns the `AI` binding into a Pi model provider. Ids that start with `@cf/` are [Workers AI models](https://developers.cloudflare.com/workers-ai/models/). Other ids, such as `anthropic/claude-opus-5.5`, go through [AI Gateway](https://developers.cloudflare.com/ai-gateway/), which holds the provider credentials, so your Worker needs no API keys.

Learn more in the [Pi harness docs](https://developers.cloudflare.com/agents/harnesses/pi/) and [Pi AI models](https://developers.cloudflare.com/agents/models/pi-ai/).

Also available:

- [OpenCode](https://developers.cloudflare.com/agents/harnesses/opencode/) (`agents/harness/opencode`): OpenCode running in a Durable Object.
- [Container](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/container) (`agents/harness/container`): Claude Code or Codex in a Cloudflare Container, driven from a Durable Object.
- [Codex](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/codex): a Codex-derived model loop compiled to WebAssembly, running in the Worker.

### 3. Give it tools

Tools are part of Pi extensions, which you install in the registry. An extension has a name, tools, and sections of the system prompt:

```ts
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";

export class Assistant extends DurableObject<Env> {
  readonly sendEmail = defineTool({
    name: "send_email",
    description: "Send an email.",
    replay: "unsafe",
    parameters: Type.Object({
      to: Type.String(),
      subject: Type.String(),
      text: Type.String()
    }),
    execute: async ({ to, subject, text }) => {
      const email = { from: "assistant@example.com", to, subject, text };
      const { messageId } = await this.env.EMAIL.send(email);
      this.ctx.storage.sql.exec(
        "INSERT INTO sent_emails VALUES (?, ?, ?)",
        messageId,
        to,
        subject
      );
      return { output: [{ type: "text", text: `Sent to ${to}.` }] };
    }
  });

  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      this.registry.install({
        name: "assistant",
        sections: [
          {
            key: "preamble",
            render: () => "You are a concise assistant.",
            tag: false
          }
        ],
        tools: [this.sendEmail, webFetchTool({ binding: this.env.AI })]
      });
      // ...then open Pi as in the quick start.
    }
  });
}
```

The tool sends with [Email Service](https://developers.cloudflare.com/email-service/), through a `send_email` binding, `"send_email": [{ "name": "EMAIL" }]`, in `wrangler.jsonc`. The sender must be an address on a domain you have set up for Email Service. Each email it sends goes in the `sent_emails` table from step 1.

Pi validates the arguments against `parameters` before it calls `execute`. Each call runs as its own durable task. If the object leaves memory during a call, Pi runs it again only if the tool sets `replay: "safe"`. `send_email` sets `replay: "unsafe"`, which is also the default, so after a restart the model gets an interrupted result instead, and an email is never sent twice.

Tools that come with `agents`:

- `webFetchTool` from `agents/webfetch/pi` reads a web page as Markdown. See [Web fetch](https://developers.cloudflare.com/agents/tools/web-fetch/).
- `webSearchTool` from `agents/websearch/pi` searches the web. See [Web search](https://developers.cloudflare.com/agents/tools/web-search/).
- `browserTool` from `agents/browser/pi` drives a browser that keeps its tabs, cookies and logins. See [Browser](https://developers.cloudflare.com/agents/tools/browser/).
- `skills()` from `agents/harness/pi` turns [Agent Skills](https://developers.cloudflare.com/agents/runtime/execution/agent-skills/) from `agents/skills` into an extension, so the model loads instructions only when a task needs them.

To use tools from other services, `MCPClientManager` from `agents/mcp/client` [connects the agent to MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/). To offer your own tools to other agents, `agents/mcp/server` [serves them over MCP](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/).

More in [Extensions](https://developers.cloudflare.com/agents/harnesses/pi/extensions/).

### 4. Give it a workspace

An agent that writes code or works with documents needs files, and somewhere to run things. [Cloudflare Computer](https://github.com/cloudflare/computer) gives the object a workspace: a filesystem kept in the same SQLite database, and backends that run code against it. `WorkerJavaScriptBackend` runs JavaScript in an isolated sandbox (Code Mode): each call gets a fresh [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) with no network access of its own.

```sh
npm install @cloudflare/computer
```

```ts
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";

export class Assistant extends DurableObject<Env> {
  readonly workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [new WorkerJavaScriptBackend({ loader: this.env.LOADER })]
  });

  readonly saveNote = defineTool({
    name: "save_note",
    description: "Add a line to the notes file.",
    executionMode: "sequential",
    parameters: Type.Object({ text: Type.String() }),
    execute: async ({ text }) => {
      const notes = await this.notes();
      await this.workspace.fs.writeFile("/notes.md", `${notes}- ${text}\n`);
      return { output: [{ type: "text", text: "Saved." }] };
    }
  });

  // The notes, for a page or an API to show. Call it from your Worker with
  // await env.Assistant.getByName("default").notes()
  async notes() {
    return this.workspace.fs.readFile("/notes.md", "utf8").catch(() => "");
  }
}
```

Install `this.saveNote` in the registry. The model writes to `/notes.md`, and your code reads the same file: the model and your app share one filesystem. Pi runs a round's tool calls at once unless a tool asks to run alone; each save rewrites the whole file, so `executionMode: "sequential"` stops two saves in one round from overwriting each other. The backend needs a Worker Loader binding, `"worker_loaders": [{ "binding": "LOADER" }]`, in `wrangler.jsonc`.

To give the model the whole workspace, `createPiTools()` from `@cloudflare/computer/tools/pi-ai` describes it as `read`, `write`, `edit`, `delete`, `ls`, `find`, `grep` and `exec` tools, where `exec` runs JavaScript on the backend. The [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi) installs them in the registry.

### 5. Let it act on its own

An agent does not have to wait for a request. `Scheduler` from `agents/schedules` keeps schedules in SQLite and wakes the object with the Lifecycle's alarm, so this agent summarizes its notes every weekday morning:

```ts
import { Scheduler } from "agents/schedules";

export class Assistant extends DurableObject<Env> {
  readonly scheduler = new Scheduler({
    callbacks: {
      morningDigest: async () => {
        const notes = await this.notes();
        if (notes)
          await this.harness.submit(`Summarize these notes:\n${notes}`);
      }
    }
  });

  readonly lifecycle = Lifecycle.install(this)
    .use(this.scheduler)
    .use(this.harness);

  async onStart() {
    // 9:00 UTC, Monday to Friday. A cron schedule is only created once.
    await this.scheduler.set("0 9 * * 1-5", "morningDigest");
  }
}
```

A schedule can also be a delay in seconds or a `Date`. For work that is not tied to a time, `Queue` from `agents/queue` runs jobs one at a time in order, with retries, and `Tasks` from `agents/tasks` runs multi-step work that resumes from its last finished step.

## Examples

Each example is a complete app you can run locally or deploy. Most are built like the agent above, on a plain Durable Object with a Lifecycle.

- [Pi harness](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi): a Pi agent with a chat UI over WebSockets, a workspace and code execution
- [Schedules](https://github.com/cloudflare/agents/tree/main/examples/next/schedules): reminders with `Scheduler` on a plain Durable Object
- [Sessions](https://github.com/cloudflare/agents/tree/main/examples/next/sessions): conversation history with branches and compaction
- [MCP client](https://github.com/cloudflare/agents/tree/main/examples/next/mcp-client): connect to any MCP server, sign in with OAuth, and call its tools
- [Routing](https://github.com/cloudflare/agents/tree/main/examples/next/routing): one Durable Object per chat, owned by one hub per user
- [Dynamic agents](https://github.com/cloudflare/agents/tree/main/examples/next/dynamic-agents): run user-supplied Durable Object code under a supervisor
- [OpenCode harness](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/opencode): OpenCode running in a Durable Object
- [Container harness](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/container): Claude Code or Codex in a Cloudflare Container
- [OpenAI Agents SDK](https://github.com/cloudflare/agents/tree/main/openai-sdk): agents built with `@openai/agents`, running on Durable Objects

## Features

| Feature                  | Description                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| **Durable agents**       | A Durable Object per agent, with its own SQLite database. Survives restarts, hibernates when idle |
| **Pi harness**           | A model loop that saves every step and resumes a turn where it stopped                            |
| **Other harnesses**      | OpenCode, Claude Code or Codex in a Container, and a Codex loop in WebAssembly                    |
| **Models**               | Workers AI, and other providers through AI Gateway, with no API keys in your Worker               |
| **Web tools**            | Fetch a page as Markdown, search the web, and drive a browser that keeps its logins               |
| **Agent Skills**         | Instructions the model loads only when a task needs them                                          |
| **MCP**                  | Connect to MCP servers with OAuth, or serve your own tools over MCP                               |
| **Workspace**            | Files and sandboxed code execution with Cloudflare Computer                                       |
| **Scheduling**           | One-time, recurring and cron schedules                                                            |
| **Background work**      | Queues with retries, and multi-step tasks that resume from their last finished step               |
| **Sessions and streams** | Conversation storage and durable event streams, for building your own model loop                  |
| **WebSockets**           | Real-time connections that survive hibernation                                                    |
| **State sync**           | State that syncs to every connected client                                                        |
| **Routing**              | Requests routed by URL to the right agent, or one agent that owns many others                     |
| **Clients**              | `useAgent` for React, and `AgentClient` for other environments                                    |
| **Email**                | Receive, send and reply to email                                                                  |
| **Observability**        | Events for logging and tracing                                                                    |

## The Agent class

`Agent` from `agents` is a Durable Object with a preset of capabilities already installed, including state that syncs to connected clients, `@callable` methods that clients call over WebSocket, scheduling, queues, MCP connections and email. It runs on the same Lifecycle, so you can add a harness to it with `this.lifecycle.use(this.harness)`. See the [Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/).

## Packages

| Package                                                          | What it is                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| [`agents`](https://www.npmjs.com/package/agents)                 | The Agents SDK                                                 |
| [`@cloudflare/computer`](https://github.com/cloudflare/computer) | A workspace for agents: files, and code execution against them |

## Documentation

- [Agents documentation](https://developers.cloudflare.com/agents/) on developers.cloudflare.com
- [`docs/`](https://github.com/cloudflare/agents/tree/main/docs) in this repository, the source for those pages
- [`design/`](https://github.com/cloudflare/agents/tree/main/design), the design records behind the SDK

## Contributing

We are not accepting external pull requests at the moment. [Open an issue](https://github.com/cloudflare/agents/issues) to report a bug or request a feature, or [start a discussion](https://github.com/cloudflare/agents/discussions) to ask a question. To work on the repository, see [CONTRIBUTING.md](https://github.com/cloudflare/agents/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/cloudflare/agents/blob/main/LICENSE)
