# Think Chat SDK Messenger

This Vite app shows the Think-native Chat SDK messenger path: a `Think` agent
declares Telegram ingress with `getMessengers()`, replies through the normal
streamed `chat()` flow, and exposes a small dashboard for inspecting the
conversation.

## Run

Install dependencies from the repository root, then start the Worker:

```bash
npm install
cd examples/think-chat-sdk
npm start
```

Set these environment variables in `.dev.vars` for local development, or with
`wrangler secret put` before deploying:

```bash
TELEGRAM_BOT_TOKEN=123456:telegram-bot-token
TELEGRAM_BOT_USERNAME=your_bot_username
TELEGRAM_WEBHOOK_SECRET_TOKEN=change-me-to-a-long-random-string
```

The Vite config starts a Cloudflare tunnel automatically. If you are testing
locally, open the `trycloudflare.com` URL printed in the terminal, then use the
dashboard button or this command to register the Telegram webhook:

```bash
curl -X POST https://<your-worker-or-tunnel>/setup/telegram-webhook
```

Telegram will then send updates to:

```text
https://<your-worker-or-tunnel>/messengers/telegram/webhook
```

## Key Pattern

```ts
export { ThinkMessengerStateAgent };

export class SupportAgent extends Think<Env> {
  getMessengers() {
    return defineMessengers({
      telegram: telegramMessenger({
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: this.env.TELEGRAM_BOT_USERNAME ?? "think_chat_sdk_bot",
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
        conversation: "self",
        respondTo: ["direct-message", "mention"]
      })
    });
  }
}
```

The Worker forwards the public webhook path to a single root Think agent:

```ts
const agent = await getAgentByName(env.SupportAgent, "default");
return agent.fetch(request);
```

Think owns the Chat SDK runtime, webhook verification, per-thread sub-agent
routing, streamed delivery, and recovery snapshots. The dashboard connects to the
default root agent with `useAgent()` and `useAgentChat()` from `@cloudflare/think/react`, so it hydrates from
Think's `/get-messages` endpoint and receives live message updates over the
Agent websocket.

This example sets `conversation: "self"` so the dashboard and Telegram webhook
share the same root Think conversation. Remove that option to use the default
one-sub-agent-per-Chat-SDK-thread isolation pattern.

Use `examples/chat-sdk-messenger` when you need to own the Chat SDK runtime and
build a custom control plane yourself.
