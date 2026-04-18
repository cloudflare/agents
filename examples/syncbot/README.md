# SyncBot

One agent, one conversation, multiple platforms. Messages from Slack and Telegram are unified into a single conversation history backed by a Durable Object. The agent responds on every connected platform simultaneously.

## How it works

```
Slack webhook ──→ Worker ──→ SyncBot agent ──→ AI response ──→ Slack + Telegram
                                  ↑
Telegram webhook ──→ Worker ──────┘                              ↑
                                                                 │
Browser ←─── WebSocket ←─── same agent instance ────────────────┘
```

1. Slack and Telegram webhooks arrive at separate endpoints (`/slack/events`, `/telegram/webhook`)
2. The Worker routes both to the same `SyncBot` agent instance via `getAgentByName`
3. The agent stores the message in a unified SQLite table, generates an AI response, and fans out the reply to every registered platform channel
4. The web dashboard shows the merged conversation in real time via WebSocket

## Setup

### 1. Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Under **OAuth & Permissions**, add bot scopes: `chat:write`, `app_mentions:read`, `channels:history`
3. Install to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`)
4. Under **Basic Information**, copy the **Signing Secret**

### 2. Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`
2. Follow the prompts and copy the bot token (`123456789:ABC...`)

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_WEBHOOK_SECRET=pick-any-random-string
```

### 4. Run locally

```bash
npm install
npm start
```

### 5. Expose via tunnel

```bash
cloudflared tunnel --url http://localhost:5173
```

### 6. Register webhooks

**Slack:** Go to **Event Subscriptions** in your app settings, set the Request URL to:

```
https://your-tunnel-url/slack/events
```

Subscribe to bot events: `message.channels`, `app_mention`

**Telegram:**

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-tunnel-url/telegram/webhook&secret_token=pick-any-random-string"
```

### 7. Try it

1. Send a message to your Telegram bot
2. Mention the Slack bot in a channel
3. Watch both conversations appear in the web dashboard — same agent, same history
4. The AI response appears on both platforms

## Key pattern

```typescript
export class SyncBot extends Agent<Env> {
  slack = new SlackMessenger({ ... });
  telegram = new TelegramMessenger({ ... });

  private async handleIncoming(event: InboundEvent) {
    // Store in unified history
    this.sql`INSERT INTO messages ...`;

    // Stream AI response — tokens arrive in real time on the source platform
    const result = streamText({ model, messages: history });
    const text = await this.fanOut(result.textStream, event.channel);
  }

  private async fanOut(textStream: AsyncIterable<string>, source: ChannelRef) {
    // Tee the stream: one for streaming, one for collecting the full text
    const { streams, collected } = teeAsyncIterable(textStream, 1);

    // Stream to the platform the user is on (they see tokens arriving)
    await this.adapterFor(source).streamMessage(source, streams[0]);

    // Post the complete text to every other connected platform
    const fullText = await collected;
    for (const channel of this.getOtherChannels(source)) {
      await this.postToChannel(channel, fullText);
    }
    return fullText;
  }
}
```
