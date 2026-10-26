# Cloudflare Agents

[![npm version](https://img.shields.io/npm/v/agents)](https://www.npmjs.com/package/agents)
[![npm downloads](https://img.shields.io/npm/dw/agents)](https://www.npmjs.com/package/agents)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cloudflare/agents/main/assets/npm-install-agents-dark.svg">
  <img alt="npm install agents" src="https://raw.githubusercontent.com/cloudflare/agents/main/assets/npm-install-agents.svg">
</picture>

**Run AI agents on Cloudflare that pick up where they left off.**

An agent is a model in a loop: it reads the conversation, calls tools, and repeats until the job is done. That loop is called a harness. Claude Code and Codex are harnesses, and [Pi](https://github.com/earendil-works/pi/tree/main/packages/durable) is an open-source one that saves every step as it goes.

This package gives a harness a home. Each agent gets its own [Durable Object](https://developers.cloudflare.com/durable-objects/), a small named server with its own database and files. It sleeps when idle, wakes on a request or a timer, and if it is stopped mid-task it resumes from the last saved step. Run one per user, task or conversation.

[Read the docs](https://developers.cloudflare.com/agents/) · [Quick start](#quick-start) · [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi)

## Why run an agent on Cloudflare

| An agent needs to…                   | In a stateless function, it…             | With Agents, it…                                                |
| ------------------------------------ | ---------------------------------------- | --------------------------------------------------------------- |
| Work for minutes or hours            | Stops when the request ends              | Runs in its own object, and an alarm wakes it to carry on       |
| Survive a crash or a deploy mid-task | Starts over, and may send an email twice | Resumes from Pi's last saved step. Unsafe tools never run twice |
| Remember each user                   | Needs a database bolted on               | Has its own SQLite database and files                           |
| Wait days for the next message       | Keeps a server running, or forgets       | Sleeps without using compute, and wakes with its data intact    |
| Act without being asked              | Needs a separate cron service            | Wakes itself on a schedule                                      |
| Call Claude, GPT or open models      | Needs API keys in your Worker            | Uses Workers AI, or AI Gateway, which holds the provider keys   |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cloudflare/agents/main/assets/how-an-agent-runs-dark.svg">
  <img alt="A request goes from a client to your Worker, which finds Alice's agent by name, one of many. The agent is a Durable Object. Requests and its alarm both arrive at its Lifecycle, which starts a harness such as Pi, OpenCode, Claude Code or Codex, the tools the harness runs, a scheduler and WebSockets. They keep their data in the object's SQLite database. The alarm wakes the object after it sleeps or crashes. The harness calls models, and the tools reach outside services and run code the model writes in a sandbox." src="https://raw.githubusercontent.com/cloudflare/agents/main/assets/how-an-agent-runs.svg">
</picture>

**Pi brings the loop. Agents gives it a home.** Pi owns everything about a run: the transcript, the inbox of steers and follow-ups, model calls, tool calls, retries and crash recovery. This package gives Pi its storage, in the object's SQLite database, and the alarm that wakes it. It also adds what an agent needs around the loop: tools that work on Workers, a workspace, schedules, and connections to browsers.

### Three words you will see

- **Harness:** the loop around a model. It sends the conversation to the model, runs the tools the model asks for, and repeats until the model answers. Pi, OpenCode, Claude Code and Codex are harnesses.
- **Durable Object:** think of it as a small server with a name and its own database. `getByName("alice")` always reaches Alice's, from anywhere. It sleeps when nothing is happening and wakes with its data intact. You pay for compute only while it works.
- **Capability:** a piece you plug into an agent, such as a harness, a scheduler or WebSockets. You add only the ones you need.

### What you get

- **A durable model loop:** Pi, on Workers AI or any provider through AI Gateway, with no API keys in your Worker
- **Tools:** read web pages, search the web, drive a browser, load Agent Skills and connect to MCP servers
- **A workspace:** files in the agent's database, and code that runs in a sandbox
- **Work on its own:** schedules, queues and multi-step tasks
- **Live clients:** WebSockets that survive the agent sleeping, and React hooks

The full list is in [Features](#features). The harness APIs are in beta. Pi can change its API in a minor release, so `agents` supports one Pi minor at a time, and the quick start pins it.

Already using the `Agent` class, `AIChatAgent` or Think? They still work. See [The Agent class](#the-agent-class).

## Quick start

This agent runs Pi on a Workers AI model, with one tool: it can read web pages. Install the Agents SDK and Pi:

```sh
npm install agents @earendil-works/pi-durable@~1.4.0 @earendil-works/pi-ai@~1.4.0 @earendil-works/chord@~1.4.0
```

| Package                      | What it does                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `agents`                     | Hosts the harness in a Durable Object: storage, wake-ups, tools and models            |
| `@earendil-works/pi-durable` | Pi, the harness: the model loop, its transcript and its recovery                      |
| `@earendil-works/pi-ai`      | Pi's model layer. `createAI` plugs Workers AI and AI Gateway into it                  |
| `@earendil-works/chord`      | The runtime Pi is built on. `agents/harness/pi` imports it too, so install it as well |

Create `src/index.ts`:

<!-- readme-sync: examples/next/quick-start/src/index.ts -->

```ts
import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { webFetchTool } from "agents/webfetch/pi";

export class Assistant extends DurableObject<Env> {
  // Workers AI, and other providers through AI Gateway, as a Pi provider.
  readonly ai = createAI({ binding: this.env.AI });
  // Pi's tools and system prompt live in a registry.
  readonly registry = createRegistry();

  readonly harness = new PiHarness({
    // Opens Pi when the object starts. Pi keeps every step of every
    // conversation in this object's SQLite database.
    harness: ({ storage, context, onWake }) => {
      this.registry.install({
        name: "assistant",
        tools: [webFetchTool({ binding: this.env.AI })]
      });
      const models = createModels();
      models.setProvider(this.ai.provider);
      // Pi calls onWake when it next needs to run, and the harness sets the
      // object's alarm for then, so Pi carries on after the object sleeps.
      return Harness.open(
        storage,
        { models, registry: this.registry, onWake },
        context
      );
    },
    defaults: { model: this.ai("@cf/zai-org/glm-5.3-flash") }
  });

  // Class fields run top to bottom, so the Lifecycle comes after the
  // capabilities it uses.
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async ask(prompt: string) {
    return (await this.harness.prompt(prompt)).text;
  }
}

export default {
  // Anyone with this URL can use your AI quota. Add auth before you deploy.
  async fetch(request: Request, env: Env) {
    // One agent per name. Use a user id to give each user their own agent.
    const assistant = env.Assistant.getByName("default");
    return new Response(await assistant.ask(await request.text()));
  }
} satisfies ExportedHandler<Env>;
```

Create `wrangler.jsonc`:

```jsonc
{
  "name": "assistant",
  "main": "src/index.ts",
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

Workers AI runs on your Cloudflare account, so `wrangler dev` asks you to log in. The agent reads the page with its tool and answers with a short summary, as plain text. Run `npx wrangler deploy` to deploy it.

**See it resume.** Ask for something that takes a while, and press Ctrl+C in the `wrangler dev` terminal while the agent works. Start `wrangler dev` again and ask:

```sh
curl -d "What did I last ask you, and what did you answer?" http://localhost:8787
```

Pi saved the interrupted turn and finished it when the agent started again, so the answer is in its transcript.

This code is also a complete project in [`examples/next/quick-start`](https://github.com/cloudflare/agents/tree/main/examples/next/quick-start).

To start from a complete app instead, use the Pi harness example. It adds a chat UI over WebSockets, a filesystem and code execution. Create a local copy:

```sh
npm create cloudflare@latest -- --template=cloudflare/agents/examples/next/harnesses/pi
```

Or deploy it to your account:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi)

## How an agent is built

An agent is a Durable Object. A Lifecycle runs the object, and capabilities plug into the Lifecycle: a harness that runs the model loop, a scheduler, WebSockets and others. You add only the ones your agent needs, and each one keeps its data in the object's SQLite database.

The sections below take the quick start apart and then extend it, one capability at a time. By the end, the assistant reads the web, keeps notes in a workspace, and emails you a summary of them every weekday morning. Each snippet shows only what it adds to `Assistant`.

### 1. An agent is a Durable Object

A Durable Object is a class with a name. `env.Assistant.getByName("alice")` always reaches the same instance, wherever the request comes from, and there is only ever one of it. Each instance has its own SQLite database at `this.ctx.storage.sql`. When nothing is happening, it leaves memory and uses no compute; the next request starts it again with its data intact.

`Lifecycle.install(this)` turns the object into an agent host:

```ts
export class Assistant extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);

  onStart() {
    // Runs once each time the object starts. The email tool in step 3
    // logs to this table.
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sent_emails (id TEXT, recipient TEXT, subject TEXT)"
    );
  }
}
```

The Lifecycle takes over the object's `fetch`, `alarm` and WebSocket handlers, unless your class defines its own. It routes requests, messages and alarms to the capabilities you add with `.use()`, and shares the object's one alarm between them.

The object starts on its first request, alarm, WebSocket message or capability call, and `onStart` runs before any of them is handled. An RPC method that uses no capability, such as `notes()` in step 4, does not start it. Call `await this.lifecycle.start()` at the top of such a method if it needs `onStart` to have run.

### 2. Give it a model loop

A harness is the capability that runs the model loop: it sends the conversation to the model, runs the tools the model calls, and repeats until the model answers. Claude Code and Codex are harnesses you run on your own machine. `PiHarness` runs [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) inside the object. Pi saves every step, from your input to each model response and tool call, before acting on it. If the object leaves memory mid-turn, the Lifecycle starts it again with an alarm, and Pi carries on where it stopped.

In the quick start, `PiHarness` calls the factory you give it to open Pi over the object's storage. Pi passes `onWake` back so the Lifecycle knows when to set the alarm. Once it is installed, you can talk to the agent in a few ways:

```ts
// Wait for the answer.
const { text } = await this.harness.prompt("What is 47 × 19?");

// Or hand over the input and return. Pi has saved it once this resolves.
await this.harness.submit("Summarize today's notes.");

// Each session has its own transcript, inbox and model.
const session = await this.harness.sessions.create();
await session.setModel(this.ai("anthropic/claude-opus-5.5"));

// Change course while it works. Pi reads this after its current tool round.
await session.steer("Use metric units.");
```

To show a session as it happens, `session.events()` gives you the session so far, then each change as Pi saves it. Step 6 sends them to a browser.

`createAI` from `agents/models/pi-ai` turns the `AI` binding into a Pi model provider. Ids that start with `@cf/` are [Workers AI models](https://developers.cloudflare.com/workers-ai/models/). Other ids, such as `anthropic/claude-opus-5.5`, go through [AI Gateway](https://developers.cloudflare.com/ai-gateway/). The gateway holds the provider credentials, through unified billing or a key you store on it, so your Worker needs no API keys.

Learn more in the [Pi harness docs](https://developers.cloudflare.com/agents/harnesses/pi/) and [Pi AI models](https://developers.cloudflare.com/agents/models/pi-ai/).

Other harnesses run on the same Lifecycle:

- [OpenCode](https://developers.cloudflare.com/agents/harnesses/opencode/) (`agents/harness/opencode`): OpenCode running in a Durable Object.
- [Container](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/container) (`agents/harness/container`): Claude Code or Codex in a Cloudflare Container, driven from a Durable Object.
- [AI SDK](https://github.com/cloudflare/agents/tree/main/examples/next/channels) (`agents/harness/ai-sdk`): a loop built on the AI SDK's `streamText`, for code that already uses the AI SDK.
- [Codex](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/codex) (an example, not an import): a Codex-derived model loop compiled to WebAssembly, running in the Worker.

To write your own loop, [Sessions](https://github.com/cloudflare/agents/blob/main/docs/agents/sessions.md) stores the conversation, [Streams](https://github.com/cloudflare/agents/blob/main/docs/agents/streams.md) holds the output as it is written, and [Tasks](https://github.com/cloudflare/agents/blob/main/docs/agents/tasks.md) runs steps that resume after a restart.

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
            // Without this, Pi wraps the text in <preamble> tags.
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

Pi validates the arguments against `parameters` before it calls `execute`. Each call runs as its own durable task. Say the object restarts just after the email goes out: a loop that simply tried again would send it twice. Pi runs a call again only if the tool sets `replay: "safe"`. `send_email` sets `replay: "unsafe"`, which is also the default, so after a restart the model gets an interrupted result instead, and the email is never sent twice.

Tools that come with `agents`:

- `webFetchTool` from `agents/webfetch/pi` reads a web page as Markdown. See [Web fetch](https://developers.cloudflare.com/agents/tools/web-fetch/).
- `webSearchTool` from `agents/websearch/pi` searches the web. See [Web search](https://developers.cloudflare.com/agents/tools/web-search/).
- `browserTool` from `agents/browser/pi` drives a browser that keeps its tabs, cookies and logins. See [Browser](https://developers.cloudflare.com/agents/tools/browser/).
- `skills()` from `agents/harness/pi` turns [Agent Skills](https://developers.cloudflare.com/agents/runtime/execution/agent-skills/) from `agents/skills` into an extension, so the model loads instructions only when a task needs them.

To use tools from other services, `MCPClientManager` from `agents/mcp/client` [connects the agent to MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/). To offer your own tools to other agents, `agents/mcp/server` [serves them over MCP](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/).

More in [Extensions](https://developers.cloudflare.com/agents/harnesses/pi/extensions/).

### 4. Give it a workspace

An agent that writes code or works with documents needs files, and somewhere to run things. [Cloudflare Computer](https://github.com/cloudflare/computer) gives the object a workspace: a filesystem kept in the same SQLite database, and backends that run code against it. `WorkerJavaScriptBackend` runs JavaScript in a sandbox: each call gets a fresh [Dynamic Worker](https://developers.cloudflare.com/dynamic-workers/) with no network access of its own.

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
    // Each save rewrites the whole file, so Pi runs saves one at a time.
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

Install `this.saveNote` in the registry. The model writes to `/notes.md`, and your code reads the same file: the model and your app share one filesystem. The backend needs a Worker Loader binding, `"worker_loaders": [{ "binding": "LOADER" }]`, in `wrangler.jsonc`.

To give the model the whole workspace, `createPiTools()` from `@cloudflare/computer/tools/pi-ai` describes it as `read`, `write`, `edit`, `delete`, `ls`, `find`, `grep` and `exec` tools, where `exec` runs JavaScript on the backend. The [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi) installs them in the registry.

### 5. Let it act on its own

An agent does not have to wait for a request. `Scheduler` from `agents/schedules` keeps schedules in SQLite and wakes the object with the Lifecycle's alarm. This agent emails you a summary of its notes every weekday morning:

```ts
import { Scheduler } from "agents/schedules";

export class Assistant extends DurableObject<Env> {
  readonly scheduler = new Scheduler({
    callbacks: {
      morningDigest: async () => {
        const notes = await this.notes();
        if (notes)
          await this.harness.submit(
            `Email you@example.com a summary of these notes:\n${notes}`
          );
      }
    }
  });

  // After every capability it uses: class fields run top to bottom.
  readonly lifecycle = Lifecycle.install(this)
    .use(this.scheduler)
    .use(this.harness);

  async onStart() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS sent_emails (id TEXT, recipient TEXT, subject TEXT)"
    );
    // 9:00 UTC, Monday to Friday. A cron schedule is only created once.
    await this.scheduler.set("0 9 * * 1-5", "morningDigest");
  }
}
```

Pi writes the summary and sends it with the `send_email` tool from step 3, so it lands in your inbox. Nobody had to ask.

A schedule can also be a delay in seconds or a `Date`. For work that is not tied to a time, `Queue` from `agents/queue` runs jobs one at a time in order, with retries, and `Tasks` from `agents/tasks` runs multi-step work that resumes from its last finished step.

### 6. Talk to it from a browser

The quick start answers over HTTP and waits for the whole reply. A chat UI wants to show the answer as it is written, and to keep its connection while the agent sleeps. `WebSockets` from `agents/websockets` holds connections that survive the object leaving memory, and `session.events()` streams what Pi does:

```ts
// When a WebSocket connects:
const stream = await this.harness.session().events();
socket.send(JSON.stringify([stream.snapshot])); // the session so far
stream.start(async (events) => {
  socket.send(JSON.stringify(events)); // each change, as Pi saves it
});

// When it closes:
await stream.stop();
```

The [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi) wires this up: `src/sockets.ts` gives each WebSocket its own session, and the React client connects with `useAgent` from `agents/react`. Outside React, `AgentClient` from `agents/client` connects the same way. See [WebSockets on a plain Durable Object](https://github.com/cloudflare/agents/blob/main/docs/agents/lifecycle.md#websockets-are-an-opt-in-capability).

## Examples

Each example is a complete app you can run locally or deploy. Most are built like the agent above, on a plain Durable Object with a Lifecycle.

- [Quick start](https://github.com/cloudflare/agents/tree/main/examples/next/quick-start): the agent from the quick start, as a project
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

### Run

| Feature                  | Description                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| **Durable agents**       | A Durable Object per agent, with its own SQLite database. Survives restarts, and sleeps when idle |
| **Pi harness**           | A model loop that saves every step and resumes a turn where it stopped                            |
| **Other harnesses**      | OpenCode, Claude Code or Codex in a Container, the AI SDK, and a Codex loop in WebAssembly        |
| **Models**               | Workers AI, and other providers through AI Gateway, with no API keys in your Worker               |
| **Sessions and streams** | Conversation storage and durable event streams, for building your own model loop                  |
| **Observability**        | Events for logging and tracing                                                                    |

### Act

| Feature             | Description                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| **Web tools**       | Read a page as Markdown, search the web, and drive a browser that keeps its logins  |
| **Agent Skills**    | Instructions the model loads only when a task needs them                            |
| **MCP**             | Connect to MCP servers with OAuth, or serve your own tools over MCP                 |
| **Workspace**       | Files and sandboxed code execution with Cloudflare Computer                         |
| **Scheduling**      | One-time, recurring and cron schedules                                              |
| **Background work** | Queues with retries, and multi-step tasks that resume from their last finished step |

### Connect

| Feature        | Description                                                                   |
| -------------- | ----------------------------------------------------------------------------- |
| **WebSockets** | Real-time connections that survive the agent sleeping                         |
| **State sync** | State that syncs to every connected client                                    |
| **Clients**    | `useAgent` for React, and `AgentClient` for other environments                |
| **Routing**    | Requests routed by URL to the right agent, or one agent that owns many others |
| **Email**      | Receive, send and reply to email                                              |

## The Agent class

`Agent` from `agents` is a Durable Object with a preset of capabilities already installed, including state that syncs to connected clients, `@callable` methods that clients call over WebSocket, scheduling, queues, MCP connections and email. It runs on the same Lifecycle, so you can add a harness to it with `this.lifecycle.use(this.harness)`. See the [Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/).

`AIChatAgent` from `@cloudflare/ai-chat` and `Think` from `@cloudflare/think` build on `Agent`, and they still work. See [Chat agents](https://developers.cloudflare.com/agents/api-reference/chat-agents/) and [Think](https://developers.cloudflare.com/agents/think/).

## Packages

| Package                                                                                         | What it is                                                            |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`agents`](https://www.npmjs.com/package/agents)                                                | The Agents SDK                                                        |
| [`@cloudflare/computer`](https://github.com/cloudflare/computer)                                | A workspace for agents: files, and code execution against them        |
| [`@earendil-works/pi-durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) | Pi, the harness `PiHarness` runs. From the Pi project, not Cloudflare |
| [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)                  | Pi's model layer, which `agents/models/pi-ai` plugs into              |

## Documentation

- [Agents documentation](https://developers.cloudflare.com/agents/) on developers.cloudflare.com
- [`docs/`](https://github.com/cloudflare/agents/tree/main/docs) in this repository, the source for those pages
- [`design/`](https://github.com/cloudflare/agents/tree/main/design), the design records behind the SDK

## Contributing

We are not accepting external pull requests at the moment. [Open an issue](https://github.com/cloudflare/agents/issues) to report a bug or request a feature, or [start a discussion](https://github.com/cloudflare/agents/discussions) to ask a question. To work on the repository, see [CONTRIBUTING.md](https://github.com/cloudflare/agents/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/cloudflare/agents/blob/main/LICENSE)
