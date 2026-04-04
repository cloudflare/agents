# Agents SDK Playground

An interactive demo application showcasing every feature of the Cloudflare Agents SDK. Use it to learn the SDK, test features, and understand how agents work.

## Getting Started

```bash
# Install dependencies
npm install

# Start the development server
npm start
```

Visit http://localhost:5173 to explore the playground.

## Features

The playground is organized into feature categories, each with interactive demos:

### Core

| Demo            | Description                                                              |
| --------------- | ------------------------------------------------------------------------ |
| **State**       | Real-time state synchronization with `setState()` and `onStateChanged()` |
| **Callable**    | RPC methods using the `@callable` decorator                              |
| **Streaming**   | Streaming responses with `StreamingResponse`                             |
| **Schedule**    | One-time, recurring, and cron-based task scheduling                      |
| **Connections** | WebSocket lifecycle, client tracking, and broadcasting                   |
| **SQL**         | Direct SQLite queries using `this.sql` template literal                  |
| **Routing**     | Agent naming strategies (per-user, shared, per-session)                  |
| **Readonly**    | Read-only agent access                                                   |
| **Retry**       | Retry with backoff and shouldRetry                                       |

### Multi-Agent

| Demo           | Description                                                  |
| -------------- | ------------------------------------------------------------ |
| **Supervisor** | Manager-child agent pattern using `getAgentByName()` for RPC |
| **Chat Rooms** | Lobby with room agents for multi-user chat                   |
| **Workers**    | Fan-out parallel processing (documentation)                  |
| **Pipeline**   | Chain of responsibility pattern (documentation)              |

### AI

| Demo         | Description                                          |
| ------------ | ---------------------------------------------------- |
| **Chat**     | `AIChatAgent` with message persistence and streaming |
| **Tools**    | Client-side tool execution with confirmation flows   |
| **Codemode** | AI code generation and editing                       |

### MCP (Model Context Protocol)

| Demo       | Description                                             |
| ---------- | ------------------------------------------------------- |
| **Server** | Creating MCP servers with tools, resources, and prompts |
| **Client** | Connecting to external MCP servers                      |
| **OAuth**  | OAuth authentication for MCP connections                |

### Workflows

| Demo         | Description                                              |
| ------------ | -------------------------------------------------------- |
| **Basic**    | Interactive multi-step workflow simulation with progress |
| **Approval** | Human-in-the-loop approval/rejection patterns            |

### Email

| Demo               | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| **Receive**        | Receive real emails via Cloudflare Email Routing              |
| **Secure Replies** | Send HMAC-signed replies for secure routing back to the agent |

> **Note:** Email demos require deployment to Cloudflare. A warning banner is shown when running locally.

## Project Structure

```
playground/
├── src/
│   ├── demos/           # Demo pages and agent definitions
│   │   ├── core/        # State, callable, streaming, schedule, etc.
│   │   ├── ai/          # Chat, tools, codemode
│   │   ├── mcp/         # Server, client, OAuth
│   │   ├── multi-agent/ # Supervisor, chat rooms, workers, pipeline
│   │   ├── workflow/    # Basic, approval
│   │   └── email/       # Receive, secure replies
│   ├── components/      # Shared UI components
│   ├── layout/          # App layout (sidebar, wrapper)
│   ├── hooks/           # React hooks (theme, userId, logs)
│   ├── pages/           # Home page
│   ├── client.tsx       # Client entry point
│   ├── server.ts        # Worker entry point
│   └── styles.css       # Tailwind styles
├── testing.md           # Manual testing guide
├── TODO.md              # Planned improvements
└── wrangler.jsonc       # Cloudflare configuration
```

## Testing

See [testing.md](./testing.md) for the source-of-truth test plan. **All E2E tests are AI-driven** — the test runner parses `testing.md` into scenarios, then uses an LLM to translate each scenario's natural-language actions and assertions into Playwright commands at runtime.

```bash
# Run the browser suite locally
npm run test:e2e
```

**How it works:**

1. `e2e/parse-testing-md.ts` parses `testing.md` into structured scenario objects
2. `e2e/ai-runner.spec.ts` creates one Playwright `test()` per scenario
3. `e2e/ai-executor.ts` navigates to the route, takes an accessibility snapshot, sends the scenario + snapshot to a Workers AI LLM, and executes the returned actions
4. Scenarios flagged `deployed-only` are auto-skipped in local/CI environments

**Required environment variables:**

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Workers AI access
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID

**Adding a new test:** Edit `testing.md` — no Playwright code needed. The AI runner will pick it up automatically.

The test command includes a smart dependency prepare step: it only rebuilds `agents`, `@cloudflare/ai-chat`, `@cloudflare/codemode`, and `@cloudflare/voice` when their source is newer than their built `dist/` output.

GitHub Actions runs the playground browser suite on every pull request (blocking merge) and nightly.

## Configuration

Each demo has its own Durable Object agent. The full list of agents and workflows is defined in `wrangler.jsonc`.

## Environment Variables

For the email demos, set `EMAIL_SECRET` for HMAC-signed replies:

```bash
# Production
wrangler secret put EMAIL_SECRET
```

For local development, add it to a `.env` file:

```
EMAIL_SECRET=your-secret-for-email-signing
```

## Email Routing Setup

To test the email demos with real emails:

1. Deploy to Cloudflare: `npm run deploy`
2. Go to Cloudflare Dashboard → Email → Email Routing
3. Add a routing rule to forward emails to your Worker
4. Send emails to:
   - `receive+instanceId@yourdomain.com` → ReceiveEmailAgent
   - `secure+instanceId@yourdomain.com` → SecureEmailAgent

## Dark Mode

Click the theme toggle in the sidebar footer to switch between Light, Dark, and System themes.
