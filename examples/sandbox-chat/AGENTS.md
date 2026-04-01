# sandbox-chat

AI chat assistant backed by an isolated Linux container via the Cloudflare Sandbox SDK. Users interact through a three-panel UI: file browser, chat, and shared terminal.

## Architecture

```
Browser (React)
├── File browser sidebar       ← @callable RPCs (listFiles, readFileContent, …)
├── Chat panel                 ← WebSocket via useAgent / useAgentChat
└── Terminal + Preview panel   ← SandboxAddon WebSocket (?mode=terminal)
        │
SandboxChatAgent (Durable Object, AIChatAgent)
├── AI tools (readFile, writeFile, exec, git*, coder, exposePort, …)
├── Shared PTY fan-out (1 upstream → N browser clients)
├── OpenCode delegation (coder tool)
├── File watcher (inotify → broadcast)
└── R2 backup / restore
        │
Sandbox Container (Durable Object + Container)
├── docker.io/cloudflare/sandbox:0.8.0-opencode
├── Node.js, Bun, Python, git, standard Unix tools
├── OpenCode server on port 4096
└── Web service ports 8000-8005
```

## Files

| File | Purpose |
|------|---------|
| `src/server.ts` | `SandboxChatAgent` DO — all AI tools, PTY multiplexing, OpenCode integration, file watcher, backup/restore, preview proxy |
| `src/client.tsx` | React app — chat UI, file browser sidebar, xterm.js terminal, web preview iframe, resize handles |
| `src/sandbox-workspace.ts` | `SandboxWorkspace` adapter — wraps `@cloudflare/sandbox` with an interface matching `@cloudflare/shell`'s Workspace |
| `src/opencode-stream.ts` | `OpenCodeStreamAccumulator` — translates OpenCode SSE events into AI SDK `UIMessage[]` for the coder subagent |
| `src/index.tsx` | React entry point |
| `src/styles.css` | Tailwind v4 + Kumo design system imports |
| `wrangler.jsonc` | Worker config — containers, DOs, R2, AI binding, assets |
| `Dockerfile` | Extends `sandbox:0.8.0-opencode`, exposes ports 4096, 8000-8005 |

## Key patterns

### Shared PTY terminal

A single upstream PTY WebSocket connects to the sandbox container via `sandbox.terminal()`. All browser terminal clients (`?mode=terminal` connections) are identified by the `"terminal"` connection tag (hibernation-safe via `getConnectionTags`). Output fans out from the upstream PTY to all tagged clients; keystrokes are forwarded back.

The `exec` tool sends commands through this same PTY via `ptyExec()`, so the user sees agent commands execute in real-time. A deterministic PS1 prompt marker (derived from `this.name`) detects command completion.

**Important**: The PTY is never torn down on client disconnect — the container's bash session persists and reconnecting clients reattach. The prompt marker must be deterministic to survive DO hibernation.

### Coder tool (OpenCode subagent)

The `coder` tool delegates complex coding tasks to an autonomous OpenCode agent inside the container. It uses an **async generator** that yields `CoderToolOutput` objects as preliminary tool results, each containing a growing `UIMessage[]` sub-conversation.

The `OpenCodeStreamAccumulator` (in `src/opencode-stream.ts`) translates OpenCode SSE events into AI SDK-native `UIMessage` parts (`TextUIPart`, `DynamicToolUIPart`). Each SSE event updates the accumulator's state, and the generator yields throttled snapshots (~200ms) as preliminary tool results. The client renders these as a full nested conversation using the `CoderSubConversation` component — showing the agent's text responses and tool calls in real-time with the same rendering components as the main chat.

The SSE event stream is consumed via direct `containerFetch` + `parseSSEStream` (not the SDK's `client.event.subscribe()` which buffers through the container fetch adapter). An abort signal and 2-minute inactivity timeout prevent indefinite hangs.

### Web preview

The `exposePort` tool exposes container ports (8000-8005) and broadcasts preview URLs to clients via a `preview-url` ServerMessage. The client renders an iframe with the preview URL. Port 3000 is reserved (sandbox control plane) and must never be used.

The hostname for preview URLs is captured from the first incoming request's `url.host` (includes port for local dev, e.g. `localhost:5173`). Preview subdomain requests are handled by `proxyToSandbox` in the fetch handler.

### File watcher

Uses `sandbox.watch()` with inotify to stream filesystem changes, broadcast as `file-change` ServerMessages. The file browser debounces these into refreshes. The watcher starts on first non-terminal client connect and stops when all disconnect.

### Backup / restore

Workspace persistence across container eviction uses `sandbox.createBackup()` / `sandbox.restoreBackup()` with handles stored in DO SQLite storage. Runs in both local dev (miniflare-simulated R2) and production.

## Ports

| Port | Use |
|------|-----|
| 3000 | **Reserved** — sandbox control plane, never use |
| 4096 | OpenCode server (internal) |
| 8000-8005 | Available for web services started by the coder/user |

## Environment variables

Set in `.env` for local development (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `CLOUDFLARE_ACCOUNT_ID` | Required for OpenCode's Workers AI provider |
| `CLOUDFLARE_API_KEY` | Required for OpenCode's Workers AI provider |
| `R2_ACCESS_KEY_ID` | Optional — R2 backup persistence |
| `R2_SECRET_ACCESS_KEY` | Optional — R2 backup persistence |

## Run locally

```bash
npm install
npm start     # requires Docker running
```

First run builds the container image (2-3 minutes).
