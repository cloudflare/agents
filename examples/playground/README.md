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

| Demo            | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| **State**       | Real-time state synchronization with `setState()` and `onStateUpdate()` |
| **Callable**    | RPC methods using the `@callable` decorator                             |
| **Streaming**   | Streaming responses with `StreamingResponse`                            |
| **Schedule**    | One-time, recurring, and cron-based task scheduling                     |
| **Connections** | WebSocket lifecycle, client tracking, and broadcasting                  |
| **SQL**         | Direct SQLite queries using `this.sql` template literal                 |
| **Routing**     | Agent naming strategies (per-user, shared, per-session)                 |

### Multi-Agent

| Demo           | Description                                                  |
| -------------- | ------------------------------------------------------------ |
| **Supervisor** | Manager-child agent pattern using `getAgentByName()` for RPC |
| **Chat Rooms** | Lobby with room agents for multi-user chat                   |
| **Workers**    | Fan-out parallel processing (documentation)                  |
| **Pipeline**   | Chain of responsibility pattern (documentation)              |

### AI

| Demo      | Description                                          |
| --------- | ---------------------------------------------------- |
| **Chat**  | `AIChatAgent` with message persistence and streaming |
| **Tools** | Client-side tool execution with confirmation flows   |

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
│   ├── agents/          # Agent class definitions
│   │   ├── core-agent.ts
│   │   └── chat-agent.ts
│   ├── demos/           # Demo page components
│   │   ├── core/
│   │   ├── multi-agent/
│   │   ├── ai/
│   │   ├── mcp/
│   │   ├── workflow/
│   │   └── email/
│   ├── components/      # Shared UI components
│   ├── layout/          # App layout (sidebar, wrapper)
│   ├── hooks/           # React hooks (theme)
│   ├── pages/           # Home page
│   ├── client.tsx       # Client entry point
│   ├── server.ts        # Worker entry point
│   └── styles.css       # Tailwind styles
├── testing.md           # Manual testing guide
├── TODO.md              # Planned improvements
└── wrangler.jsonc       # Cloudflare configuration
```

## Testing

See [testing.md](./testing.md) for a comprehensive guide on manually testing every feature.

## Configuration

The playground uses several Durable Object agents:

- **CoreAgent** - Demonstrates state, RPC, streaming, scheduling, connections, and SQL
- **ChatAgent** - Demonstrates AI chat capabilities
- **SupervisorAgent** - Manages child agents for the supervisor demo
- **ChildAgent** - Simple counter agent spawned by the supervisor
- **LobbyAgent** - Tracks and manages chat rooms
- **RoomAgent** - Individual chat room with presence and messaging
- **WorkflowDemoAgent** - Simulates multi-step workflows and approval patterns
- **ReceiveEmailAgent** - Receives emails via Cloudflare Email Routing
- **SecureEmailAgent** - Receives emails and sends signed replies

## Environment Variables

Create a `.env` file for local development:

```
OPENAI_API_KEY=sk-...
EMAIL_SECRET=your-secret-for-email-signing
```

For production, set secrets using:

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put EMAIL_SECRET
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
