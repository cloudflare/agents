# OpenCode

An AI chat agent that delegates JavaScript/TypeScript coding tasks to an autonomous [OpenCode](https://opencode.ai) agent running inside an isolated Linux container via the [Sandbox SDK](https://developers.cloudflare.com/sandbox/). The sandbox comes pre-loaded with Node.js, npm, and Bun. Describe what you want built and the agent handles all file operations, shell commands, and tooling — streaming progress back in real time.

## What this demonstrates

- **OpenCode delegation** — hand off any coding task to an autonomous agent inside the container
- **Streaming observation** — watch the agent work in real-time via `UIMessage[]` snapshots
- **Multi-provider support** — detects all available provider credentials and merges them so every model is accessible in the sandbox
- **File watching** — inotify-based filesystem watcher broadcasts changes to the UI
- **Persistent workspace** — files and session state survive container eviction via R2 backup/restore

## File layout

```
src/
  server.ts                    # SandboxChatAgent — JS specialist agent with single `opencode` tool
  client.tsx                   # React client entry + chat-only UI
  client/
    chat-messages.tsx          # Message list + OpenCode sub-conversation renderer
    connection-indicator.tsx   # Connection status dot
    error-boundary.tsx         # React error boundary wrapper
    mode-toggle.tsx            # Dark/light theme toggle
  styles.css                   # Tailwind v4 + Kumo imports
```

## Prerequisites

- [Docker](https://docs.docker.com/desktop/) running locally (required for the sandbox container)
- [Node.js](https://nodejs.org/) 24+
- A Cloudflare account (Workers Paid plan for Containers)

## Run locally

```bash
npm install
npm start
```

> First run builds the Docker container image (2–3 minutes). Subsequent runs are faster.

## Environment variables

Set **one or more** of the following provider credential sets in `.env` (see `.env.example`). All detected providers will be available in the sandbox:

```bash
# Anthropic (Claude)
ANTHROPIC_API_KEY=your-anthropic-api-key

# OpenAI (GPT-4)
OPENAI_API_KEY=your-openai-api-key

# Cloudflare Workers AI
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_KEY=your-api-key
```

For workspace persistence across evictions:

```bash
CLOUDFLARE_ACCOUNT_ID=your-account-id  # also required for backup
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
```

Without R2 credentials, the chat still works — files just won't survive container eviction.

## Deploy

```bash
npm run deploy
```

Then set secrets for production:

```bash
npx wrangler secret put ANTHROPIC_API_KEY  # or OPENAI_API_KEY, or both CF vars
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

## Key patterns

### Using the OpenCode library

The easiest way is with the high-level `opencodeTask()` tool:

```typescript
import { opencodeTask } from "@cloudflare/agents-opencode";

// In your agent's onChatMessage:
const result = streamText({
  model: workersai("@cf/moonshotai/kimi-k2.5"),
  tools: {
    opencode: opencodeTask({
      sandbox: env.Sandbox,
      name: this.name,
      env,
      storage: this.ctx.storage
    })
  }
});
```

For more control, use the low-level `OpenCodeSession` directly:

```typescript
import { OpenCodeSession } from "@cloudflare/agents-opencode";

const session = new OpenCodeSession(env.Sandbox, agentName);
await session.start(env, this.ctx.storage);

for await (const snapshot of session.run("Build a todo app with React")) {
  // snapshot.status: "working" | "complete" | "error"
  // snapshot.messages: UIMessage[] — the sub-conversation
}

await session.backup(this.ctx.storage);
```

### Combinatory provider detection

The library detects all available provider credentials and merges them into a single config. You can also pass explicit credentials and a user config override:

```typescript
await session.start(env, storage, {
  credentials: [
    { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY },
    { provider: "openai", apiKey: env.OPENAI_API_KEY }
  ],
  userConfig: { model: "anthropic/claude-sonnet-4-20250514" } // takes precedence
});
```

### Backup/restore with session state

```typescript
// Persists: sandbox FS + OpenCode session ID + provider + in-flight run status
await session.backup(this.ctx.storage);

// On restore: reconnects OpenCode client, provides context about process restart
const result = await session.start(env, storage);
if (result.sessionState?.runInFlight) {
  const context = session.getRestoreContext();
  // Include in next agent message
}
```
