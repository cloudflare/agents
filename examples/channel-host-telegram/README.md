# channel-host-telegram

A real messenger built on the transport outside, agent as callee pattern: the
Chat SDK runs in a Worker-owned host, and Think agents are callees invoked over
Workers RPC.

| Role                             | Where                                                                                                                                               | Owns                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Client                           | the Telegram app                                                                                                                                    | nothing you control: raw updates, including slash commands, hit your webhook.                                                        |
| Host (worker in `src/server.ts`) | `Chat` from the Chat SDK, state in its own `ChatStateDO` (via [`chat-state-cloudflare-do`](https://github.com/dcartertwo/chat-state-cloudflare-do)) | the Telegram connection, webhook verification, threading, dedupe, locks, the command surface, and which agent handles a thread.      |
| Agent (`HostedAgent`)            | a Think Durable Object, one instance per Telegram thread                                                                                            | the model turn and per-thread transcript. Its public surface is only `ingest()` over RPC plus `configureChannels()` behavior policy. |

> Note: Chat SDK state uses the community
> [`chat-state-cloudflare-do`](https://chat-sdk.dev/adapters/community/cloudflare-do)
> adapter. It should be vendored into this repo before the host pattern is
> promoted beyond experimental.

Key differences from the built-in `getMessengers()` path:

- The Chat SDK instance and adapter options are ordinary app code in the host.
- The Worker only serves `/webhooks/telegram` and `/setup/telegram`.
- The agent has no public transport route, static routing manifest, or webhook
  handler.
- Trade-off you now own: reply durability. The built-in messenger runtime wraps
  delivery in recovery fibers; this host posts once per turn and relies on
  Telegram webhook retries plus Chat SDK dedupe for at-least-once ingress.

The agent surface is literally two things:

```typescript
async ingest(input: {
  channelId: "telegram";
  text: string;
}): Promise<ReadableStream<Uint8Array>>;

configureChannels() {
  return {
    telegram: {
      instructions: "Telegram-specific behavior policy"
    }
  };
}
```

The returned stream is UTF-8 NDJSON with `delta`, `done`, and `error` frames.
This host decodes `delta` frames and passes an `AsyncIterable<string>` to
`thread.post(...)`, letting the Chat SDK stream by posting and editing the
Telegram reply.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather), note the token and
   the bot's username.
2. `cp .dev.vars.example .dev.vars` and fill in the three values
   (`TELEGRAM_WEBHOOK_SECRET_TOKEN` is any random string you choose).
3. Deploy and register the webhook. Telegram needs a public HTTPS URL, so local
   `wrangler dev` cannot receive real messages:

```sh
pnpm deploy
npx wrangler secret bulk <(node -e '
  const fs=require("fs");const o={};
  for(const l of fs.readFileSync(".dev.vars","utf8").split("\n")){
    const m=l.match(/^([A-Z_]+)=(.*)$/); if(m) o[m[1]]=m[2];
  } console.log(JSON.stringify(o))')
curl https://channel-host-telegram.<your-subdomain>.workers.dev/setup/telegram
```

4. DM the bot on Telegram:

```text
/help            -> answered by the host, no agent DO, no model turn
/whoami          -> answered by the host, shows the thread's agent instance
anything else    -> Workers AI turn in the thread's Think agent
```

`npx wrangler tail` while you chat to watch the host and agent split in the logs.
