# @cloudflare/messengers

Cross-platform messaging adapters for the Cloudflare Agents SDK. Connect your agents to Slack, Telegram, and more — the conversation lives in the agent, platforms are just I/O channels.

## Install

```bash
npm install @cloudflare/messengers
```

## Quick start

```typescript
import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { SlackMessenger } from "@cloudflare/messengers/slack";

export class SupportBot extends Agent<Env> {
  slack = new SlackMessenger({
    botToken: this.env.SLACK_BOT_TOKEN,
    signingSecret: this.env.SLACK_SIGNING_SECRET
  });

  async onRequest(request: Request) {
    return this.slack.handleWebhook(request, async (event) => {
      if (event.type === "message") {
        await this.slack.postMessage(
          event.channel,
          `You said: ${event.message.text}`
        );
      }
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/slack/events") {
      const teamId = (await request.clone().json()).team_id;
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

## Adapters

### Slack

```typescript
import { SlackMessenger } from "@cloudflare/messengers/slack";

const slack = new SlackMessenger({
  botToken: "xoxb-...",
  signingSecret: "..."
});
```

Wraps [slack-cloudflare-workers](https://github.com/slack-edge/slack-cloudflare-workers). Supports messages, reactions, Block Kit rendering, slash commands, interactive actions, and streaming via post+edit.

### Telegram

```typescript
import { TelegramMessenger } from "@cloudflare/messengers/telegram";

const telegram = new TelegramMessenger({
  botToken: "123456:ABC-DEF",
  secretToken: "optional-webhook-secret"
});
```

Wraps [grammY](https://grammy.dev/). Supports messages, inline keyboards, reactions, callback queries, and streaming via post+edit.

### Google Chat

```typescript
import { GoogleChatMessenger } from "@cloudflare/messengers/google-chat";

const gchat = new GoogleChatMessenger({
  credentials: {
    clientEmail: "bot@project.iam.gserviceaccount.com",
    privateKey: "-----BEGIN PRIVATE KEY-----\n..."
  },
  verificationToken: "optional-static-token"
});
```

Uses the Google Chat REST API directly with service account JWT authentication. No `googleapis` dependency — all `fetch`-based, Workers-native. Supports messages, Cards v2 (buttons, images, sections), and streaming via post+edit.

## Core concepts

### handleWebhook

The simplest way to process incoming webhooks. Verifies the request signature, parses the payload, and returns the appropriate HTTP response — all in one call.

```typescript
async onRequest(request: Request) {
  return this.slack.handleWebhook(request, async (event) => {
    switch (event.type) {
      case "message":
        // event.message is guaranteed present (discriminated union)
        console.log(event.message.text, event.message.author.name);
        break;
      case "reaction":
        console.log(event.reaction.emoji, event.reaction.added);
        break;
      case "interaction":
        console.log(event.interaction.actionId, event.interaction.value);
        break;
      case "command":
        console.log(event.command.command, event.command.text);
        break;
    }
  });
}
```

For Slack, `handleWebhook` also handles the URL verification challenge automatically.

### Sending messages

Every adapter accepts three message formats:

```typescript
// Plain text
await slack.postMessage(channel, "Hello world");

// Markdown (converted to platform-native format)
await slack.postMessage(channel, { markdown: "**bold** and _italic_" });

// Structured blocks (rendered as Block Kit, inline keyboards, etc.)
await slack.postMessage(channel, {
  blocks: [
    { type: "text", content: "Deploy complete" },
    {
      type: "fields",
      items: [
        { label: "Environment", value: "production" },
        { label: "Version", value: "v1.2.3" }
      ]
    },
    {
      type: "actions",
      buttons: [
        { id: "rollback", label: "Rollback", style: "danger" },
        {
          id: "details",
          label: "View Details",
          url: "https://dash.example.com"
        }
      ]
    }
  ]
});
```

### Streaming AI responses

Pass any `AsyncIterable<string>` — works directly with AI SDK's `textStream`:

```typescript
import { streamText } from "ai";

const result = streamText({ model, messages });
await slack.streamMessage(event.channel, result.textStream);
```

The adapter posts a placeholder message and updates it as chunks arrive, throttled to avoid rate limits (500ms for Slack, 1s for Telegram).

### Platform capabilities

Each adapter declares what the platform supports. Use this to adapt your agent's behavior:

```typescript
if (adapter.capabilities.interactiveElements !== "none") {
  await adapter.postMessage(channel, {
    blocks: [
      { type: "actions", buttons: [{ id: "approve", label: "Approve" }] }
    ]
  });
} else {
  await adapter.postMessage(channel, "Reply YES to approve.");
}
```

### Escape hatch

Both adapters expose the underlying platform client via `.api` for operations the normalized interface does not cover:

```typescript
// Slack: open a modal, post ephemeral, use full Block Kit
await slack.api.views.open({ trigger_id, view: { ... } });

// Telegram: send a photo, sticker, or use any Bot API method
await telegram.api.sendPhoto(chatId, "https://example.com/img.png");

// Google Chat: list spaces, get members, etc.
const spaces = await gchat.api.listSpaces();
```

## Cross-platform conversations

Because the agent is a Durable Object, one instance can receive messages from multiple platforms and maintain a single unified conversation:

```typescript
export class OmniBot extends Agent<Env> {
  slack = new SlackMessenger({ ... });
  telegram = new TelegramMessenger({ ... });

  async onRequest(request: Request) {
    const url = new URL(request.url);

    if (url.searchParams.get("platform") === "slack") {
      return this.slack.handleWebhook(request, (event) => this.handleIncoming(event));
    }
    if (url.searchParams.get("platform") === "telegram") {
      return this.telegram.handleWebhook(request, (event) => this.handleIncoming(event));
    }

    return new Response("Unknown platform", { status: 400 });
  }

  private async handleIncoming(event: InboundEvent) {
    if (event.type !== "message") return;

    // Store in unified conversation history (SQLite in the DO)
    this.sql`INSERT INTO messages (role, content, platform, timestamp)
             VALUES ('user', ${event.message.text}, ${event.platform}, ${Date.now()})`;

    // Generate response using full history
    const history = [...this.sql`SELECT role, content FROM messages ORDER BY timestamp`];
    const response = await generateResponse(history);

    // Fan out to all active channels
    await this.slack.postMessage(this.slackChannel, response);
    await this.telegram.postMessage(this.telegramChannel, response);
  }
}
```

## API

### MessengerAdapter interface

| Method                                     | Description                               |
| ------------------------------------------ | ----------------------------------------- |
| `handleWebhook(request, handler)`          | Verify + parse + handle + return Response |
| `verifyWebhook(request)`                   | Verify request signature                  |
| `parseWebhook(request)`                    | Parse into `InboundEvent`                 |
| `postMessage(channel, content)`            | Send a message                            |
| `editMessage(channel, messageId, content)` | Edit a sent message                       |
| `deleteMessage(channel, messageId)`        | Delete a message                          |
| `addReaction(channel, messageId, emoji)`   | Add an emoji reaction                     |
| `streamMessage(channel, stream)`           | Stream via post+edit                      |

### InboundEvent (discriminated union)

| Type              | Guaranteed field                | Description                  |
| ----------------- | ------------------------------- | ---------------------------- |
| `"message"`       | `message: NormalizedMessage`    | A chat message               |
| `"reaction"`      | `reaction: ReactionEvent`       | Emoji added/removed          |
| `"interaction"`   | `interaction: InteractionEvent` | Button click, menu selection |
| `"command"`       | `command: CommandEvent`         | Slash command                |
| `"member_joined"` | —                               | User joined a channel        |
| `"unknown"`       | —                               | Unrecognized event type      |

All events include `platform`, `channel`, and `raw` (the original payload).

### OutboundMessage

| Format                       | When to use                                   |
| ---------------------------- | --------------------------------------------- |
| `string`                     | Quick plain-text replies                      |
| `{ markdown: string }`       | Formatted text (converted per platform)       |
| `{ blocks: MessageBlock[] }` | Structured content with buttons, fields, code |
