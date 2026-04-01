# Sandbox Chat

An AI chat assistant backed by an isolated Linux container via the [Sandbox SDK](https://developers.cloudflare.com/sandbox/). The agent can read, write, and manage files, run shell commands, use git, delegate to a coding agent, and expose web server previews — all in a persistent, sandboxed environment.

## What this demonstrates

- **Container-backed file operations** — read, write, list, delete, mkdir, glob via `@cloudflare/sandbox`
- **Shell command execution** — run any command (bash, node, python, git) via a private agent PTY
- **Git integration** — init, status, add, commit, log, diff using real git CLI with porcelain output
- **Coding agent delegation** — hand off complex tasks to OpenCode running inside the container
- **Web preview** — expose container ports (8000–8005) and display them in an iframe
- **File watching** — inotify-based filesystem watcher broadcasts changes to the UI in real-time
- **Persistent workspace** — files survive container eviction via R2 backup/restore
- **Dual terminals** — agent has its own private PTY; the user gets an independent terminal via SandboxAddon

## File layout

```
src/
  server.ts                  # SandboxChatAgent — orchestrator, tool definitions, chat handler
  server/
    sandbox-workspace.ts     # SandboxWorkspace adapter (wraps ISandbox)
    pty.ts                   # AgentPty — private PTY for agent exec
    coder.ts                 # CoderManager — OpenCode delegation + progress summarization
    file-watcher.ts          # FileWatcher — inotify → broadcast
    git-parsers.ts           # Git output parsers (status, log, diff)
    preview.ts               # PreviewManager — port exposure + URL state
    backup.ts                # Backup/restore helpers
    types.ts                 # ServerMessage, CoderOutput
    multi-pty.ts             # Archived: shared-PTY fan-out approach (reference only)
  client.tsx                 # App shell — layout, session, wiring
  client/
    file-browser.tsx         # File browser sidebar
    chat-messages.tsx        # Message list + tool card renderers
    terminal-panel.tsx       # User-interactive terminal (SandboxAddon)
    preview-panel.tsx        # Web preview iframe
    connection-indicator.tsx # Connection status dot
    mode-toggle.tsx          # Dark/light theme toggle
    resize-handle.tsx        # Draggable panel divider
  index.tsx                  # React entry point
  styles.css                 # Tailwind v4 + Kumo imports
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

For the coding agent (OpenCode) and workspace persistence, set credentials in `.env` (see `.env.example`):

```
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_KEY=your-api-key
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
```

Without R2 credentials, the chat still works — files just won't survive container eviction.
Without `CLOUDFLARE_API_KEY`, the `coder` tool will report an error but all other tools work.

## Deploy

```bash
npm run deploy
```

Then set secrets for production:

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_KEY
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

## Key patterns

### SandboxWorkspace adapter

The `SandboxWorkspace` class wraps `@cloudflare/sandbox` with the same method signatures as `@cloudflare/shell`'s `Workspace`:

```typescript
const sandbox = getSandbox(env.Sandbox, agentName);
const sw = new SandboxWorkspace(sandbox);

// Same API as Workspace
const content = await sw.readFile("/workspace/index.ts"); // string | null
const entries = await sw.readDir("/workspace/src"); // FileInfo[]
await sw.writeFile("/workspace/hello.txt", "Hello!");
```

### Agent PTY

The agent has a private terminal session for running commands. No fan-out to browser clients — the user gets their own independent terminal via `SandboxAddon`:

```typescript
// Server: agent uses AgentPty for exec
const pty = new AgentPty(env.Sandbox, agentName);
await pty.ensureReady();
const { output, timedOut } = await pty.exec("npm install");

// Client: user connects directly to sandbox
const sandbox = new SandboxAddon({
  getWebSocketUrl: ({ origin }) =>
    `${origin}/agents/sandbox-chat-agent/${name}?mode=terminal`
});
```

### Backup/restore persistence

```typescript
// After mutations
const backup = await sw.createBackup();
await this.ctx.storage.put("backup", JSON.stringify(backup));

// On container restart
const raw = await this.ctx.storage.get("backup");
if (raw) await sw.restoreBackup(JSON.parse(raw));
```

## Related examples

- [`workspace-chat`](../workspace-chat/) — same concept using `@cloudflare/shell` (virtual filesystem, no container)
- [`playground`](../playground/) — kitchen-sink showcase of all SDK features
