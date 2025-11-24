# Getting Started

This walks through wiring the runtime into a Cloudflare Worker, defining an agent, and talking to it.

I’ll assume you already know your way around Workers and Wrangler.

---

## 1. Add the runtime to your Worker

In your Worker entrypoint (e.g. `src/index.ts`):

```ts
import { AgentSystem } from "agents/sys";
// (Optional) import custom tools / middleware and add them later

// Build an AgentSystem with a default LLM model
const system = new AgentSystem({
  defaultModel: "openai:gpt-4.1-mini"
})
  .defaults() // planning + filesystem + subagents
  .addAgent({
    name: "manager-agent",
    description: "Main agent.",
    prompt: "You are a helpful assistant.",
    tags: ["default"] // selects which tools/middleware apply
  });

// Export configured DO classes and HTTP handler
const { SystemAgent, Agency, handler } = system.export();

export { SystemAgent, Agency };
export default handler;
```

What `.defaults()` does:

- Registers `planning` middleware (todo list + `write_todos` tool)
- Registers `filesystem` middleware (`ls`, `read_file`, `write_file`, `edit_file`)
- Registers `subagents` middleware (`task` tool for child agents)

All of those middlewares are tagged with `"default"`, so any agent blueprint that includes `"default"` in its `tags` will use them.

---

## 2. Bind Durable Objects and KV (wrangler.jsonc)

Wire the `SystemAgent` and `Agency` DOs and the KV registry that stores agencies:

```jsonc
// wrangler.jsonc
{
  "name": "my-agent-worker",
  "main": "src/index.ts",
  "compatibility_date": "2025-03-14",
  "compatibility_flags": ["nodejs_compat"],

  "durable_objects": {
    "bindings": [
      {
        "name": "SYSTEM_AGENT",
        "class_name": "SystemAgent"
      },
      {
        "name": "AGENCY",
        "class_name": "Agency"
      }
    ]
  },

  "kv_namespaces": [
    {
      "binding": "AGENCY_REGISTRY",
      "id": "my-agency-registry-kv-namespace-id"
    }
  ],

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["SystemAgent", "Agency"]
    }
  ]
}
```

Run the migration once:

```bash
wrangler deploy --migrations
```

---

## 3. Configure an LLM provider

By default, `AgentSystem` will use OpenAI’s Chat Completions API via `makeOpenAI` if you don’t pass a provider explicitly.

You just need:

- `LLM_API_KEY` – secret (OpenAI API key or gateway key)
- Optional: `LLM_API_BASE` – custom base URL (proxy/gateway)

Set them as Worker secrets:

```bash
wrangler secret put LLM_API_KEY
wrangler secret put LLM_API_BASE   # optional
```

Then `SystemAgent.provider` will:

- Build an OpenAI provider using `makeOpenAI(apiKey, apiBase)`
- Wrap it to automatically emit `MODEL_STARTED` / `MODEL_COMPLETED` events

If you want to use a custom provider, you can pass a `Provider` into `new AgentSystem({ provider })`. That provider is a simple interface:

```ts
interface Provider {
  invoke(
    req: ModelRequest,
    opts: { signal?: AbortSignal }
  ): Promise<ModelResult>;
  stream(
    req: ModelRequest,
    onDelta: (chunk: string) => void
  ): Promise<ModelResult>;
}
```

(Advanced: wiring a provider that depends on `env` requires patching `SystemAgent.provider`, so for now sticking to the OpenAI path is easiest.)

---

## 4. Run locally

Start dev mode:

```bash
wrangler dev
```

Then open the Worker URL (default `http://127.0.0.1:8787/`) in a browser.

You should see the built-in **Agent Dashboard** (`client.html`), which is being served by the exported `handler`.

---

## 5. Create an Agency and an Agent (via dashboard)

In the dashboard:

1. Use the **New Agency** button to create an agency.

   Under the hood this calls:
   - `POST /agencies` → creates a new `Agency` DO instance
   - The metadata (ID, name, createdAt) is stored in `AGENCY_REGISTRY` KV

2. Select that agency from the **Agencies** dropdown.

3. Click **New Thread** to create an agent thread, and pick your agent type
   (e.g. `"manager-agent"` from the example).

   Under the hood this calls:
   - `POST /agency/:agencyId/agents` with `{ agentType }`
   - The `Agency` DO:
     - assigns a new `id` for the agent thread
     - stores metadata in its local SQLite
     - spawns a `SystemAgent` DO, calling `/register` with `ThreadMetadata`

4. Select the thread in the sidebar and start sending messages from the chat panel.

---

## 6. Talking to an agent programmatically

If you don’t care about the dashboard, you can hit the REST-ish endpoints directly.

### 6.1 Create an agency

```ts
const res = await fetch("https://your-worker.example.com/agencies", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Production" })
});

const agency = await res.json(); // { id, name, createdAt }
```

### 6.2 List blueprints available in that agency

Static blueprints from `AgentSystem.addAgent` plus any overrides stored inside the `Agency` DO:

```ts
const res = await fetch(
  `https://your-worker.example.com/agency/${agency.id}/blueprints`
);
const { blueprints } = await res.json();
```

### 6.3 Create a new agent thread

```ts
const res = await fetch(
  `https://your-worker.example.com/agency/${agency.id}/agents`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentType: "manager-agent" })
  }
);

const thread: {
  id: string;
  agentType: string;
  createdAt: string;
  request: any;
  agencyId: string;
} = await res.json();
```

### 6.4 Send a message

```ts
await fetch(
  `https://your-worker.example.com/agency/${agency.id}/agent/${thread.id}/invoke`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "Hello, what can you do?" }]
    })
  }
);
// HTTP 202, run happens asynchronously inside the DO
```

### 6.5 Poll state

```ts
const res = await fetch(
  `https://your-worker.example.com/agency/${agency.id}/agent/${thread.id}/state`
);
const { state, run } = await res.json();

/*
state: AgentState (messages, tools, thread, todos, files, subagents, ...)
run:   RunState (runId, status, step, reason, nextAlarmAt)
*/
```

### 6.6 Listen to events live (WebSocket)

`client.html` uses a WebSocket at:

```text
/ws  → /agency/:agencyId/agent/:agentId/ws
```

`Agent` base class calls `broadcast()` on the DO whenever an `AgentEvent` is emitted in `SystemAgent.emit`, so you can just reuse that endpoint if you want a custom UI.

---

## 7. Security: lock down the handler

`createHandler` supports a simple shared-secret auth mechanism:

```ts
const system = new AgentSystem({
  defaultModel: "openai:gpt-4.1-mini",
  handlerOptions: {
    secret: "some-long-random-string" // clients must send X-SECRET header
  }
});
```

When `secret` is set:

- All non-`GET /` requests must include `X-SECRET: <value>` or you get `401`
- This gates both the dashboard and the raw REST API

Use this if your Worker is directly exposed to the public internet and you don’t have another auth layer in front.

---

## 8. Looking at the example

The `examples/deep/` folder wires up a real setup:

- `AgentSystem` with:
  - a **security analytics subagent** blueprint (`security-agent`)
  - a **manager** blueprint (`manager-agent`) that orchestrates subagents

- Custom tools that talk to the Cloudflare Analytics GraphQL API
- A prompt that explains how the manager agent should:
  - plan with todos
  - spawn analytics subagents via `task`
  - read/write `report.md` in the virtual filesystem

It’s a good reference for more complex multi-agent patterns.
