# Cloudflare Agents

[![npm version](https://img.shields.io/npm/v/agents)](https://www.npmjs.com/package/agents)
[![npm downloads](https://img.shields.io/npm/dw/agents)](https://www.npmjs.com/package/agents)

![npm install agents](https://raw.githubusercontent.com/cloudflare/agents/main/assets/npm-install-agents.svg)

**Run AI agents on Cloudflare that pick up where they left off.**

An agent is a model in a loop: it reads the conversation, calls tools, and repeats until the job is done. That loop is called a harness. Claude Code and Codex are harnesses, and [Pi](https://github.com/earendil-works/pi/tree/main/packages/durable) is an open-source one that saves every step as it goes.

This package gives a harness a home. Each agent gets its own [Durable Object](https://developers.cloudflare.com/durable-objects/), a small named server with its own database and files. It sleeps when idle, wakes on a request or a timer, and if it is stopped mid-task it resumes from the last saved step. Run one per user, task or conversation.

[Read the docs](https://developers.cloudflare.com/agents/) · [Quick start](#quick-start) · [Build your first agent](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md) · [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi)

## Why run an agent on Cloudflare

| An agent needs to…                   | In a stateless function, it…             | With Agents, it…                                                |
| ------------------------------------ | ---------------------------------------- | --------------------------------------------------------------- |
| Work for minutes or hours            | Stops when the request ends              | Runs in its own object, and an alarm wakes it to carry on       |
| Survive a crash or a deploy mid-task | Starts over, and may send an email twice | Resumes from Pi's last saved step. Unsafe tools never run twice |
| Remember each user                   | Needs a database bolted on               | Has its own SQLite database and files                           |
| Wait days for the next message       | Keeps a server running, or forgets       | Sleeps without using compute, and wakes with its data intact    |
| Act without being asked              | Needs a separate cron service            | Wakes itself on a schedule                                      |
| Call Claude, GPT or open models      | Needs API keys in your Worker            | Uses Workers AI, or AI Gateway, which holds the provider keys   |

![A request goes from a client to your Worker, which finds Alice's agent by name. The agent is a Durable Object. Its Lifecycle runs a scheduler, WebSockets, the Pi harness and the tools Pi runs, which keep their data in the object's SQLite database. An alarm wakes the object after it sleeps or crashes. The harness calls models, and the tools reach outside services and run code in a fresh Dynamic Worker.](https://raw.githubusercontent.com/cloudflare/agents/main/assets/how-an-agent-runs.svg)

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

## Build your first agent

The quick start is one agent with one tool. [Build your first agent](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md) takes it apart and then extends it, one capability at a time, until the assistant reads the web, keeps notes, and emails you a summary of them every weekday morning:

1. [**An agent is a Durable Object.**](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md#1-an-agent-is-a-durable-object) What the Lifecycle does, and when the object starts.
2. [**Give it a model loop.**](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md#2-give-it-a-model-loop) Prompt and submit, sessions, steering, models through AI Gateway, and the other harnesses.
3. [**Give it tools.**](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md#3-give-it-tools) An email tool that is never sent twice, and the web, browser, skills and MCP tools that come with `agents`.
4. [**Give it a workspace.**](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md#4-give-it-a-workspace) Files and sandboxed code with Cloudflare Computer, shared by the model and your app.
5. [**Let it act on its own.**](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md#5-let-it-act-on-its-own) A cron schedule that emails a summary, plus queues and multi-step tasks.
6. [**Talk to it from a browser.**](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md#6-talk-to-it-from-a-browser) Stream a session over WebSockets that survive the agent sleeping.

Each step is a short snippet you add to the quick start's `Assistant` class.

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

Each feature links to its docs.

### Run

| Feature                                                                                                                            | Description                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [**Durable agents**](https://developers.cloudflare.com/agents/runtime/lifecycle/)                                                  | A Durable Object per agent, with its own SQLite database. Survives restarts, and sleeps when idle |
| [**Pi harness**](https://developers.cloudflare.com/agents/harnesses/pi/)                                                           | A model loop that saves every step and resumes a turn where it stopped                            |
| [**Other harnesses**](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md#2-give-it-a-model-loop) | OpenCode, Claude Code or Codex in a Container, the AI SDK, and a Codex loop in WebAssembly        |
| [**Models**](https://developers.cloudflare.com/agents/models/pi-ai/)                                                               | Workers AI, and other providers through AI Gateway, with no API keys in your Worker               |
| [**Sessions and streams**](https://github.com/cloudflare/agents/blob/main/docs/agents/sessions.md)                                 | Conversation storage and durable event streams, for building your own model loop                  |
| [**Observability**](https://github.com/cloudflare/agents/blob/main/docs/agents/observability.md)                                   | Events for logging and tracing                                                                    |

### Act

| Feature                                                                                      | Description                                                                         |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [**Web tools**](https://developers.cloudflare.com/agents/tools/web-fetch/)                   | Read a page as Markdown, search the web, and drive a browser that keeps its logins  |
| [**Agent Skills**](https://developers.cloudflare.com/agents/runtime/execution/agent-skills/) | Instructions the model loads only when a task needs them                            |
| [**MCP**](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/)  | Connect to MCP servers with OAuth, or serve your own tools over MCP                 |
| [**Workspace**](https://github.com/cloudflare/computer)                                      | Files and sandboxed code execution with Cloudflare Computer                         |
| [**Scheduling**](https://github.com/cloudflare/agents/blob/main/docs/agents/scheduling.md)   | One-time, recurring and cron schedules                                              |
| [**Background work**](https://github.com/cloudflare/agents/blob/main/docs/agents/queue.md)   | Queues with retries, and multi-step tasks that resume from their last finished step |

### Connect

| Feature                                                                                                                       | Description                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [**WebSockets**](https://github.com/cloudflare/agents/blob/main/docs/agents/lifecycle.md#websockets-are-an-opt-in-capability) | Real-time connections that survive the agent sleeping                         |
| [**State sync**](https://github.com/cloudflare/agents/blob/main/docs/agents/state.md)                                         | State that syncs to every connected client                                    |
| [**Clients**](https://github.com/cloudflare/agents/blob/main/docs/agents/client-sdk.md)                                       | `useAgent` for React, and `AgentClient` for other environments                |
| [**Routing**](https://github.com/cloudflare/agents/blob/main/docs/agents/routing.md)                                          | Requests routed by URL to the right agent, or one agent that owns many others |
| [**Email**](https://github.com/cloudflare/agents/blob/main/docs/agents/email.md)                                              | Receive, send and reply to email                                              |

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
- [Build your first agent](https://github.com/cloudflare/agents/blob/main/docs/agents/build-your-first-agent.md), a tutorial that extends the quick start
- [`docs/`](https://github.com/cloudflare/agents/tree/main/docs) in this repository, the source for those pages
- [`design/`](https://github.com/cloudflare/agents/tree/main/design), the design records behind the SDK

## Contributing

We are not accepting external pull requests at the moment. [Open an issue](https://github.com/cloudflare/agents/issues) to report a bug or request a feature, or [start a discussion](https://github.com/cloudflare/agents/discussions) to ask a question. To work on the repository, see [CONTRIBUTING.md](https://github.com/cloudflare/agents/blob/main/CONTRIBUTING.md).

## License

[MIT](https://github.com/cloudflare/agents/blob/main/LICENSE)
