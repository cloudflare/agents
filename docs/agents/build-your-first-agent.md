---
title: Build your first agent
pcx_content_type: tutorial
description: Extend the quick start agent one capability at a time. Give it tools, a workspace and a schedule, and stream it to a browser.
---

The [quick start](https://github.com/cloudflare/agents#quick-start) builds one agent: Pi on a Workers AI model, with one tool that reads web pages. This tutorial takes that agent apart and then extends it, one capability at a time. By the end, the assistant reads the web, keeps notes in a workspace, and emails you a summary of them every weekday morning.

**Before you start:** create the quick start agent, or copy [`examples/next/quick-start`](https://github.com/cloudflare/agents/tree/main/examples/next/quick-start), and run it with `npx wrangler dev`. Each step below shows only what it adds to its `Assistant` class.

## How an agent is built

An agent is a Durable Object. A [Lifecycle](./lifecycle.md) runs the object, and capabilities plug into the Lifecycle: a harness that runs the model loop, a scheduler, WebSockets and others. You add only the ones your agent needs, and each one keeps its data in the object's SQLite database.

## 1. An agent is a Durable Object

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

## 2. Give it a model loop

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

Learn more in the [Pi harness docs](./harnesses/pi.md) and [Pi AI models](./models-pi-ai.md).

Other harnesses run on the same Lifecycle:

- [OpenCode](https://developers.cloudflare.com/agents/harnesses/opencode/) (`agents/harness/opencode`): OpenCode running in a Durable Object.
- [Container](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/container) (`agents/harness/container`): Claude Code or Codex in a Cloudflare Container, driven from a Durable Object.
- [AI SDK](https://github.com/cloudflare/agents/tree/main/examples/next/channels) (`agents/harness/ai-sdk`): a loop built on the AI SDK's `streamText`, for code that already uses the AI SDK.
- [Codex](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/codex) (an example, not an import): a Codex-derived model loop compiled to WebAssembly, running in the Worker.

To write your own loop, [Sessions](./sessions.md) stores the conversation, [Streams](./streams.md) holds the output as it is written, and [Tasks](./tasks.md) runs steps that resume after a restart.

## 3. Give it tools

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

- `webFetchTool` from `agents/webfetch/pi` reads a web page as Markdown. See [Web fetch](./fetch-the-web.md).
- `webSearchTool` from `agents/websearch/pi` searches the web. See [Web search](./search-the-web.md).
- `browserTool` from `agents/browser/pi` drives a browser that keeps its tabs, cookies and logins. See [Browser](./browse-the-web.md).
- `skills()` from `agents/harness/pi` turns [Agent Skills](../think/index.md#agent-skills) from `agents/skills` into an extension, so the model loads instructions only when a task needs them.

To use tools from other services, `MCPClientManager` from `agents/mcp/client` [connects the agent to MCP servers](./mcp-client.md). To offer your own tools to other agents, `agents/mcp/server` [serves them over MCP](./mcp-servers.md).

More in [Extensions](./harnesses/pi.md#add-tools-and-prompt-sections).

## 4. Give it a workspace

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

## 5. Let it act on its own

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

## 6. Talk to it from a browser

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

The [Pi harness example](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi) wires this up: `src/sockets.ts` gives each WebSocket its own session, and the React client connects with `useAgent` from `agents/react`. Outside React, `AgentClient` from `agents/client` connects the same way. See [WebSockets on a plain Durable Object](./lifecycle.md#websockets-are-an-opt-in-capability).

## Next steps

- [Pi harness](./harnesses/pi.md): sessions, recovery, skills and the browser tool in depth
- [Models for pi-ai](./models-pi-ai.md): every model `createAI` can reach, and gateway options
- [Durable Object lifecycle](./lifecycle.md): write your own capability, and use the job queue
- [Examples](https://github.com/cloudflare/agents/tree/main/examples/next): complete apps built the same way
