# Messengers: Cross-Platform Chat for the Agents SDK

## The opportunity

Every AI agent eventually needs to meet users where they are — Slack, Discord, Telegram, Teams, WhatsApp, email, SMS. Today, building a Slack bot that's also a Discord bot that's also available on a web UI means writing three separate integrations, three separate conversation stores, and three separate streaming implementations. The conversations are siloed. The code is duplicated.

The Agents SDK already solves the hard part: a Durable Object agent is a persistent, stateful, single-threaded instance with SQLite, scheduling, MCP tools, AI streaming, and bidirectional WebSocket connections. It is already a conversation engine. What it lacks is a way to plug external messaging platforms in as I/O channels.

The pitch: **"One agent, every surface. The conversation follows the user."**

---

## The core idea

A messaging platform is an I/O peripheral, not a framework. An agent should be able to receive a Slack message, generate a response using its full toolkit (state, SQL, tools, AI), and post that response back to Slack — without Slack dictating the agent's architecture.

The same agent instance should be able to simultaneously:

- Receive and respond to messages on Slack
- Maintain a web UI conversation over WebSocket
- Handle Telegram DMs
- All pointing at the same underlying conversation in SQLite

```
Slack webhook ──→ Worker ──→ getAgentByName(env.Bot, "team-acme") ──→ agent.onRequest()
                                                                          │
Telegram webhook ──→ Worker ──→ getAgentByName(env.Bot, "team-acme") ──→ agent.onRequest()
                                                                          │
Browser ──→ WebSocket ──→ same agent instance ──→ agent.onMessage()       │
                                                                          │
                                                            ┌─────────────┴─────────────┐
                                                            │  Unified conversation      │
                                                            │  in SQLite                 │
                                                            │                            │
                                                            │  Agent state, scheduling,  │
                                                            │  MCP, tools, AI, etc.      │
                                                            └────────────────────────────┘
```

The agent owns the conversation. Platforms are windows into it.

---

## Platform adapters

An adapter handles the mechanical parts of talking to a platform: verifying webhook signatures, parsing platform-specific payloads into a normalized format, converting outbound messages into the platform's native format, and calling the platform's API to send them.

An adapter is not a framework. It does not route, does not manage state, does not decide which agent handles which message. The agent (or the Worker routing layer) decides that.

### What an adapter does

```typescript
interface MessengerAdapter {
  // Inbound: verify and parse a webhook into something the agent can work with
  verifyWebhook(request: Request): Promise<boolean>;
  parseWebhook(request: Request): Promise<InboundEvent>;

  // Outbound: send messages to the platform
  postMessage(
    channel: ChannelRef,
    content: OutboundMessage
  ): Promise<SentMessage>;
  editMessage(
    channel: ChannelRef,
    messageId: string,
    content: OutboundMessage
  ): Promise<void>;
  deleteMessage(channel: ChannelRef, messageId: string): Promise<void>;

  // Reactions
  addReaction(
    channel: ChannelRef,
    messageId: string,
    emoji: string
  ): Promise<void>;

  // Streaming: post a message and update it as chunks arrive
  streamMessage(
    channel: ChannelRef,
    stream: AsyncIterable<string>
  ): Promise<SentMessage>;

  // What this platform can do
  capabilities: PlatformCapabilities;
}
```

### What an adapter does not do

- Route webhooks to agents (the Worker `fetch` handler does that)
- Manage conversation state (the agent's SQLite does that)
- Decide subscription logic (the agent decides when to respond)
- Hold any persistent state (adapters are stateless — the agent is the state)

### Platform capabilities

Every platform is different. Rather than pretending they are the same, the adapter declares what it can do, and the agent adapts its output accordingly.

```typescript
interface PlatformCapabilities {
  streaming: "native" | "post-edit" | "none";
  maxMessageLength: number;
  richText: "full-html" | "markdown" | "mrkdwn" | "plain";
  interactiveElements: "full" | "buttons" | "none";
  fileUpload: { maxSize: number } | false;
  threading: "native" | "reply-to" | "flat";
  typing: boolean;
  editAfterPost: boolean;
  reactions: boolean;
}
```

An agent can check `adapter.capabilities.streaming` before deciding whether to stream token-by-token or send a complete response. It can check `maxMessageLength` before deciding whether to split a long response. It can check `interactiveElements` before deciding whether to render approval buttons or fall back to "reply YES or NO."

---

## Normalized message format

Inbound messages from any platform get parsed into a common shape. This is not about making platforms identical — it is about giving the agent a consistent interface to work with.

```typescript
interface InboundEvent {
  type: "message" | "reaction" | "interaction" | "command";
  platform: string;
  channel: ChannelRef;
  message?: NormalizedMessage;
  reaction?: { emoji: string; added: boolean };
  interaction?: { actionId: string; value?: string };
  raw: unknown; // the original platform payload, always available
}

interface NormalizedMessage {
  id: string;
  text: string;
  author: {
    id: string;
    name: string;
    isBot: boolean;
  };
  timestamp: number;
  attachments?: Attachment[];
  isMention?: boolean;
  replyTo?: string;
}
```

The `raw` field is always there. If the normalized shape does not capture something platform-specific, the agent can dig into the raw payload.

### Outbound messages

The agent sends messages in a semantic format. The adapter converts it to the platform's native representation.

```typescript
type OutboundMessage =
  | string                          // plain text
  | { markdown: string }            // markdown, converted per platform
  | { blocks: MessageBlock[] }      // structured blocks (see below)
  | AsyncIterable<string>;          // streaming

interface MessageBlock =
  | { type: "text"; content: string }
  | { type: "code"; content: string; language?: string }
  | { type: "image"; url: string; alt?: string }
  | { type: "actions"; buttons: Button[] }
  | { type: "fields"; items: { label: string; value: string }[] };

interface Button {
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
  value?: string;
}
```

The block model is deliberately simple. It covers the 90% case. For the 10% where you need platform-specific rendering (Slack Block Kit, Adaptive Cards), the agent can bypass the abstraction and use the raw API via the adapter.

---

## How it works in practice

### Basic: Slack bot with AI responses

```typescript
import { Agent, getAgentByName } from "agents";
import { SlackAdapter } from "@cloudflare/messengers/slack";

export class SupportBot extends Agent<Env> {
  slack = new SlackAdapter({
    botToken: this.env.SLACK_BOT_TOKEN,
    signingSecret: this.env.SLACK_SIGNING_SECRET
  });

  async onRequest(request: Request) {
    if (!(await this.slack.verifyWebhook(request))) {
      return new Response("Unauthorized", { status: 401 });
    }

    const event = await this.slack.parseWebhook(request);
    if (event.type !== "message" || !event.message) {
      return new Response("OK");
    }

    // Store the inbound message
    this.sql`INSERT INTO messages (role, content, timestamp)
             VALUES ('user', ${event.message.text}, ${Date.now()})`;

    // Generate a response using conversation history
    const history = [
      ...this.sql`SELECT role, content FROM messages ORDER BY timestamp`
    ];
    const result = streamText({
      model: workersAI("@cf/moonshotai/kimi-k2.6"),
      messages: history.map((m) => ({ role: m.role, content: m.content }))
    });

    // Stream the response back to Slack
    const sent = await this.slack.streamMessage(
      event.channel,
      result.textStream
    );

    // Store the final response
    this.sql`INSERT INTO messages (role, content, timestamp)
             VALUES ('assistant', ${sent.finalText}, ${Date.now()})`;

    return new Response("OK");
  }
}

// Worker routing: one agent per Slack team
export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/slack/events") {
      const body = await request.clone().json();

      // Slack URL verification handshake
      if (body.type === "url_verification") {
        return new Response(JSON.stringify({ challenge: body.challenge }), {
          headers: { "Content-Type": "application/json" }
        });
      }

      const teamId = body.team_id;
      const agent = await getAgentByName(env.SupportBot, teamId);
      return agent.fetch(request);
    }

    return (
      routeAgentRequest(request, env) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

### Cross-platform: same conversation on Slack, Telegram, and the web

```typescript
export class OmniBot extends Agent<Env> {
  slack = new SlackAdapter({
    /* ... */
  });
  telegram = new TelegramAdapter({
    /* ... */
  });

  // Track which platform channels are active for this conversation
  channels: ChannelRef[] = [];

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS channels (
      ref TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      added_at INTEGER NOT NULL
    )`;
    this.channels = [...this.sql`SELECT * FROM channels`];
  }

  // Slack and Telegram webhooks come through here
  async onRequest(request: Request) {
    const url = new URL(request.url);
    const platform = url.searchParams.get("platform");

    let event: InboundEvent;
    if (platform === "slack") {
      if (!(await this.slack.verifyWebhook(request))) {
        return new Response("Unauthorized", { status: 401 });
      }
      event = await this.slack.parseWebhook(request);
    } else if (platform === "telegram") {
      if (!(await this.telegram.verifyWebhook(request))) {
        return new Response("Unauthorized", { status: 401 });
      }
      event = await this.telegram.parseWebhook(request);
    } else {
      return new Response("Unknown platform", { status: 400 });
    }

    if (event.type === "message" && event.message) {
      await this.handleIncoming(event.message, event.channel);
    }

    return new Response("OK");
  }

  // Web UI messages come through here
  async onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    const parsed = JSON.parse(message);
    await this.handleIncoming(
      {
        id: crypto.randomUUID(),
        text: parsed.text,
        author: parsed.author,
        timestamp: Date.now()
      },
      { platform: "web", connectionId: connection.id }
    );
  }

  private async handleIncoming(message: NormalizedMessage, source: ChannelRef) {
    // Register this channel
    this.registerChannel(source);

    // Store in unified history
    this.sql`INSERT INTO messages (role, content, source, timestamp)
             VALUES ('user', ${message.text}, ${source.platform}, ${Date.now()})`;

    // Generate response
    const history = [
      ...this.sql`SELECT role, content FROM messages ORDER BY timestamp`
    ];
    const response = await generateText({
      model: workersAI("@cf/moonshotai/kimi-k2.6"),
      messages: history.map((m) => ({ role: m.role, content: m.content }))
    });

    // Store response
    this.sql`INSERT INTO messages (role, content, source, timestamp)
             VALUES ('assistant', ${response.text}, 'agent', ${Date.now()})`;

    // Fan out to all active channels
    await this.fanOut(response.text, source);
  }

  private async fanOut(text: string, source: ChannelRef) {
    for (const channel of this.channels) {
      try {
        if (channel.platform === "slack") {
          await this.slack.postMessage(channel, { markdown: text });
        } else if (channel.platform === "telegram") {
          await this.telegram.postMessage(channel, { markdown: text });
        } else if (channel.platform === "web") {
          // WebSocket broadcast to all connected browsers
          this.broadcast(
            JSON.stringify({
              type: "message",
              role: "assistant",
              content: text
            })
          );
        }
      } catch (err) {
        // A channel might be stale (deleted thread, kicked bot). Log and move on.
        console.error(`Failed to post to ${channel.platform}:`, err);
      }
    }
  }

  private registerChannel(channel: ChannelRef) {
    const ref = JSON.stringify(channel);
    const existing = [...this.sql`SELECT ref FROM channels WHERE ref = ${ref}`];
    if (existing.length === 0) {
      this
        .sql`INSERT INTO channels (ref, platform, added_at) VALUES (${ref}, ${channel.platform}, ${Date.now()})`;
      this.channels.push(channel);
    }
  }
}
```

### Agent-initiated: scheduled messages across platforms

```typescript
export class CheckInBot extends Agent<Env> {
  slack = new SlackAdapter({
    /* ... */
  });
  telegram = new TelegramAdapter({
    /* ... */
  });

  async onStart() {
    // Daily check-in at 9am
    this.schedule("daily-checkin", { cron: "0 9 * * *" });
  }

  async onAlarm() {
    const channels = [...this.sql`SELECT * FROM channels`];
    const message = await this.generateDailyBriefing();

    for (const channel of channels) {
      if (channel.platform === "slack") {
        await this.slack.postMessage(channel, { markdown: message });
      } else if (channel.platform === "telegram") {
        await this.telegram.postMessage(channel, { markdown: message });
      }
    }
  }
}
```

---

## Platform-aware rendering

The same semantic response should look native on every platform. The agent generates content in a platform-agnostic format; the adapter renders it appropriately.

An AI response containing a table, a code block, and an approval prompt:

**Web UI** (full fidelity):

- Rendered HTML table with sorting
- Syntax-highlighted code block
- Interactive React component with Approve/Reject buttons and a diff preview

**Slack** (Block Kit):

- Section fields faking a table layout
- Code block (no syntax highlighting but formatted)
- Actions block with two buttons

**Telegram** (markdown + inline keyboard):

- ASCII/monospace table (or just the key fields as a list)
- Code block (triple backticks, no highlighting)
- Two inline keyboard buttons

**Discord** (embeds + components):

- GFM table in an embed description
- Code block with syntax highlighting
- Button row (max 5 per action row)

The adapter does the conversion. The agent does not think in Block Kit or Adaptive Cards unless it wants to.

For the cases where the normalized block model is not enough, the agent can reach through:

```typescript
if (channel.platform === "slack") {
  // Use raw Block Kit for something the abstraction can't express
  await this.slack.postRaw(channel, {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Deployment Status" }
      }
      // ... full Block Kit payload
    ]
  });
} else {
  // Everywhere else, use the simplified format
  await this.postToChannel(channel, { markdown: "## Deployment Status\n..." });
}
```

---

## The problems we accept

Cross-platform normalization is lossy. Rather than pretending platforms are the same, we acknowledge the gaps and give the agent the information to handle them.

### Message fidelity

Rich text conversion is inherently lossy. A Slack mrkdwn message round-tripped through Telegram loses formatting nuance. We convert faithfully where possible and fall back to plain text where not. The agent can check `adapter.capabilities.richText` and adjust.

### Interactive elements

Buttons translate across most platforms. Anything beyond buttons (select menus, date pickers, modals) is platform-specific. The block model supports buttons. For richer interactions, the agent uses platform-specific APIs through the adapter's raw escape hatch.

### Threading models

Slack threads, Discord threads, Telegram reply chains, and flat web conversations are fundamentally different. The adapter does not try to unify threading. It provides a `ChannelRef` that identifies where to post. The agent's conversation model (linear history in SQLite) is the source of truth; platform threading is a display concern.

### Message length limits

Platforms have different limits (Discord: 2,000 chars, Telegram: 4,096, Slack: 40,000). The adapter declares its limit. A utility function splits long messages across multiple posts when needed, preserving code blocks and markdown structure at split points.

### Identity

When the agent relays a message from one platform to another, it appears as the bot, not the original author. For cross-platform conversations, the agent can prefix with attribution ("Alice (via Slack): ...") but this is an application concern, not a framework concern.

---

## Package structure

```
packages/messengers/
  src/
    index.ts                 # Core types: MessengerAdapter, NormalizedMessage, etc.
    types.ts                 # Shared type definitions
    blocks.ts                # Block model and rendering utilities
    split.ts                 # Message splitting for length limits
    adapters/
      slack/
        index.ts             # SlackAdapter implementation
        verify.ts            # Webhook signature verification
        parse.ts             # Payload → NormalizedMessage
        render.ts            # OutboundMessage → Block Kit
        api.ts               # Slack Web API client (thin, no SDK dependency)
      discord/
        index.ts
        verify.ts
        parse.ts
        render.ts
        api.ts
      telegram/
        index.ts
        verify.ts
        parse.ts
        render.ts
        api.ts
      teams/
        index.ts
        ...
```

Each adapter is a separate entry point so tree-shaking works — if you only use Slack, you do not bundle the Telegram renderer.

```jsonc
// package.json exports
{
  "exports": {
    ".": "./src/index.ts",
    "./slack": "./src/adapters/slack/index.ts",
    "./discord": "./src/adapters/discord/index.ts",
    "./telegram": "./src/adapters/telegram/index.ts",
    "./teams": "./src/adapters/teams/index.ts"
  }
}
```

No external dependencies beyond the platform API calls (all `fetch`-based, no SDKs). Runs in Workers.

---

## What this enables that nothing else can

**Durable conversations.** The conversation persists in SQLite across platform outages, bot restarts, and Durable Object evictions. If Slack goes down, the user continues on the web UI. When Slack comes back, the agent catches up.

**Agent-initiated outreach.** A scheduled alarm, a workflow completion, a webhook from another service — the agent decides to reach out and posts to every surface the user is on. No other bot framework can do this because they are reactive (webhook in, response out). Our agents are proactive.

**Cross-platform memory.** The user mentioned their deployment preference in a Slack thread three weeks ago. The agent remembers, because it is the same SQLite, the same agent instance. When they ask on Telegram, the context is already there.

**Tool use across surfaces.** The agent calls an MCP tool, gets a result, and renders it appropriately on each platform — interactive chart on the web, image on Slack, text summary on Telegram. Same tool call, different projections.

**Human-in-the-loop across platforms.** An approval request can be sent to Slack (where the manager is) and the web UI (where the dashboard is). Whoever approves first, the agent proceeds and updates both surfaces.

---

## Open questions

- **Granularity of agent instances.** One agent per user? Per team? Per channel? Per thread? This is an application decision, but the framework should make all options easy. The current `getAgentByName` pattern supports any of these.

- **AIChatAgent integration.** Should there be a `MessengerChatAgent` that combines `AIChatAgent`'s conversation management with messenger adapters? Or should messengers sit alongside `AIChatAgent` as a separate concern? Leaning toward separate — `AIChatAgent` manages the AI conversation loop, and the messenger adapter is just another way to inject messages and extract responses.

- **Think integration.** Think already has the richest conversation model (sessions, memory, context blocks, tools). Messengers as an I/O layer for Think agents would be the most powerful combination. A Think agent that you can talk to on Slack, that remembers everything, that has tools and memory — that is the product.

- **Rate limiting and back-pressure.** Platform APIs have rate limits. If an agent fans out a response to 5 platforms simultaneously, some might fail. Retry logic, circuit breakers, and graceful degradation need thought.

- **Webhook registration.** Setting up Slack apps, Telegram bots, Discord applications — the OAuth flows and webhook registration are separate from the runtime adapter. Should we provide helpers for this, or is it out of scope?

- **Email and SMS.** Email already works via `onEmail`. SMS via Twilio is just another webhook/API pair. These could be adapters in the same package, unifying all communication channels under one pattern.
