# Assistant

A showcase of all Project Think features, built with `@cloudflare/think` and
the sub-agent routing primitive from `agents`.

## What this demonstrates

- **Multi-session via sub-agent routing** — each user gets an `AssistantDirectory`
  parent DO that owns the sidebar. Each chat is its own `MyAssistant` facet
  (full Think DO — own workspace, extensions, MCP, memory). Addressed
  transparently via `useAgent({ sub: [{ agent: "MyAssistant", name: chatId }] })`
- **Think base class** — `getModel()`, `configureSession()`, `getTools()`, `maxSteps` for a batteries-included agent
- **Built-in workspace** — file tools (read, write, edit, find, grep, delete) auto-wired on every turn
- **Sandboxed code execution** — `createExecuteTool` lets the LLM write and run JavaScript in a Dynamic Worker via `@cloudflare/codemode`
- **Self-authored extensions** — `extensionLoader` + `createExtensionTools` let the agent create new tools at runtime
- **Persistent memory** — context blocks (`soul`, `memory`) the model can read and write across sessions
- **Non-destructive compaction** — older messages summarized when context overflows, originals preserved
- **Searchable knowledge base** — FTS5-backed `AgentSearchProvider` with `search_context` and `set_context` tools
- **Dynamic configuration** — typed `AgentConfig` with model tier and persona, persisted in SQLite
- **Server-side tools** — `getWeather`, `calculate` execute on the server
- **Client-side tools** — `getUserTimezone` runs in the browser via `onToolCall`
- **Tool approval** — `calculate` requires user approval for large numbers
- **MCP integration** — connect external tool servers, tools appear in the chat (per-chat)
- **Lifecycle hooks** — `beforeTurn`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChatResponse`
- **Durable chat recovery** — `chatRecovery` wraps turns in fibers for crash recovery
- **Parent-owned scheduled work** — daily summary scheduled from the directory (facets can't own schedules), fans out to the most recently active chat
- **Regeneration with branch navigation** — v1/v2/v3 response versions via `getBranches`
- **Stream resumption** — page refresh replays the active stream (built into Think)
- **useAgentChat** — Think speaks the same CF_AGENT protocol as AIChatAgent
- **GitHub OAuth** — users sign in with GitHub; the Worker owns all DO naming, so each user gets their own directory + isolated chats

## How to run

### 1. Create a GitHub OAuth App

Go to [GitHub OAuth Apps](https://github.com/settings/developers), create a new
OAuth App, and set:

- **Homepage URL:** `http://localhost:5173`
- **Authorization callback URL:** `http://localhost:5173/auth/callback`

### 2. Add your env vars

```sh
cp .env.example .env
```

Then fill in:

```sh
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
```

### 3. Start the example

```sh
npm install
npm start
```

Open the app, click **Sign in with GitHub**, approve the OAuth flow, and you
will land in the Think assistant scoped to your GitHub login.

## Architecture

```
AssistantDirectory ("alice")            ◄── one DO per authenticated GitHub user
  ├─ MyAssistant[chat-abc]   [facet]    ◄── each chat is its own Think DO
  ├─ MyAssistant[chat-def]   [facet]
  └─ MyAssistant[chat-ghi]   [facet]
```

`AssistantDirectory` owns the chat list, the sidebar state, and any
cross-chat concerns (e.g. the daily-summary schedule — facets can't
`schedule()` so the parent does it and fans out). `MyAssistant` is a
Think DO per conversation, with its own SQLite storage, workspace,
extensions, MCP servers, and message history.

The browser never chooses a DO name. It connects to `/chat` (the
directory) and `/chat/sub/my-assistant/<chatId>` (a specific chat), and
the Worker resolves the `AssistantDirectory` instance from the
authenticated GitHub cookie:

```ts
if (url.pathname === "/chat" || url.pathname.startsWith("/chat/")) {
  const user = await getGitHubUserFromRequest(request);
  if (!user) return createUnauthorizedResponse(request);
  const directory = await getAgentByName(env.AssistantDirectory, user.login);
  return directory.fetch(request);
}
```

The directory's built-in sub-agent router picks up the
`/sub/my-assistant/<chatId>` tail — no per-chat plumbing lives in the
Worker. Access control lives on the parent via `onBeforeSubAgent` as a
strict registry gate:

```ts
override async onBeforeSubAgent(_req, { className, name }) {
  if (!this.hasSubAgent(className, name)) {
    return new Response("Not found", { status: 404 });
  }
}
```

On the client, `useChats()` (a local hook in `src/use-chats.ts`) wraps
the sidebar connection and RPCs. Each chat pane uses
`useAgent({ agent: "AssistantDirectory", basePath: "chat", sub: [{ agent: "MyAssistant", name: chatId }] })`.
See `examples/multi-ai-chat` for the minimal AIChatAgent version of the
same pattern.

## Deploying

Create or update your GitHub OAuth App so it also has your production
callback URL:

```text
https://your-domain.example/auth/callback
```

Set the secrets:

```sh
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
```

Deploy:

```sh
npm run deploy
```

## Key code

**Server** (`src/server.ts`):

```typescript
export class AssistantDirectory extends Agent<Env, DirectoryState> {
  // Strict registry gate — clients can only reach chats this
  // directory spawned via `createChat`.
  override async onBeforeSubAgent(_req, { className, name }) {
    if (!this.hasSubAgent(className, name)) {
      return new Response("Not found", { status: 404 });
    }
  }

  @callable()
  async createChat() {
    const id = nanoid(10);
    await this.subAgent(MyAssistant, id); // spawn the facet
    /* ... persist meta, refresh sidebar ... */
  }
}

export class MyAssistant extends Think<Env> {
  chatRecovery = true;
  extensionLoader = this.env.LOADER;

  getModel() {
    /* model tier from config */
  }
  configureSession(session) {
    /* persona, memory, compaction, knowledge */
  }
  getTools() {
    /* execute, extensions, getWeather, calculate, ... */
  }

  // Each turn updates the parent's sidebar preview via the
  // typed `parentAgent(AssistantDirectory)` stub.
  async onChatResponse(result) {
    const directory = await this.parentAgent(AssistantDirectory);
    await directory.recordChatTurn(this.name, extractPreview(result));
  }
}
```

**Client** (`src/client.tsx`) — `useChats()` (a local prototype in
`src/use-chats.ts`) drives the sidebar; each chat pane uses
`useAgentChat` from `@cloudflare/ai-chat/react` over a sub-routed
`useAgent` connection.

## Related

- [Think docs](../../docs/think/index.md)
- [Think tools](../../docs/think/tools.md)
- [Think lifecycle hooks](../../docs/think/lifecycle-hooks.md)
