# Think Messengers

Use messengers when a Think agent should receive and reply to Chat SDK webhooks
directly. Think owns the webhook route, durable reply fiber, conversation
routing, and streamed delivery back to the provider.

## Install

Install the Think package and the provider adapter you use:

```bash
npm install @cloudflare/think agents ai @chat-adapter/telegram
```

Provider adapters are exported from provider-specific subpaths so unused
adapters are not bundled into your Worker.

## Telegram

```typescript
import { Think } from "@cloudflare/think";
import { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
import telegramMessenger from "@cloudflare/think/messengers/telegram";

export { ThinkMessengerStateAgent };

export class SupportAgent extends Think<Env> {
  getMessengers() {
    return {
      telegram: telegramMessenger({
        token: this.env.TELEGRAM_BOT_TOKEN,
        userName: "support_bot",
        secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN
      })
    };
  }
}
```

With the default `telegram` key, register the Telegram webhook at:

```text
https://<your-worker>/messengers/telegram/webhook
```

`telegramMessenger()` requires `secretToken` in webhook mode unless you pass a
custom `verifyWebhook` function or explicitly opt out with
`verifyWebhook: false`.

If one Think agent owns multiple Telegram bots, give each provider a distinct
Chat SDK adapter name:

```typescript
{
  support: telegramMessenger({
    adapterName: "support-telegram",
    token: this.env.SUPPORT_TELEGRAM_BOT_TOKEN,
    userName: "support_bot",
    secretToken: this.env.SUPPORT_TELEGRAM_WEBHOOK_SECRET_TOKEN
  }),
  sales: telegramMessenger({
    adapterName: "sales-telegram",
    token: this.env.SALES_TELEGRAM_BOT_TOKEN,
    userName: "sales_bot",
    secretToken: this.env.SALES_TELEGRAM_WEBHOOK_SECRET_TOKEN
  })
};
```

Duplicate adapter names fail during startup so providers cannot overwrite each
other in the shared Chat SDK runtime.

## Routing

The root Think agent handles messenger webhook routes after framework sub-agent
routing and Think internal routes, but before user-defined `onRequest` fallback.
Messenger routes are root-only. Defining `getMessengers()` on a sub-agent class
does not create webhook routes for that sub-agent.

By default, Think replies to direct messages and mentions. New mentions subscribe
the Chat SDK thread so later mentions in the same thread are still observed, but
ordinary subscribed-thread messages and button actions are ignored unless you
opt in:

```typescript
telegramMessenger({
  token: this.env.TELEGRAM_BOT_TOKEN,
  userName: "support_bot",
  secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
  respondTo: ["direct-message", "mention", "subscribed-thread", "action"]
});
```

Action events are converted into Think user messages with the action id, value,
source message id, and initiating user. Use `getMessengerContext()?.action`
inside hooks or tools when you need provider-specific action details. Actions
are opt-in so interactive cards do not accidentally trigger model turns.

## Channel Speaker Labels

In multi-user channels (group chats, rooms, threads that are not direct
messages), Think prefixes the speaker onto the model-facing text so the model
can attribute traffic from several people:

```text
Ada Lovelace: summarize this
```

The default label is the author cascade `fullName || userName || userId`.
**Direct messages never get a speaker prefix**, even if a label would resolve —
a DM is already a one-to-one conversation, so the extra name is noise.

Customize this with `channelSpeakerLabel` on the messenger definition. The option
accepts a formatter only; return `null` or an empty string to suppress the prefix
for that author.

```typescript
telegramMessenger({
  token: this.env.TELEGRAM_BOT_TOKEN,
  userName: "support_bot",
  secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
  channelSpeakerLabel: (author) => author.userName ?? author.userId
});
```

Action events (button presses) are labelled the same way as regular messages:
they get a speaker prefix in channels so the model can attribute interactive
clicks, and no prefix in DMs. Returning `null` or an empty string from
`channelSpeakerLabel` suppresses the channel label as well.

## Conversation Targets

The default conversation mode is one Think sub-agent per Chat SDK thread. This
keeps group chats, direct messages, and channels from sharing memory
accidentally.

Use the root agent as the conversation when all messenger traffic should share
one Think session:

```typescript
telegramMessenger({
  token: this.env.TELEGRAM_BOT_TOKEN,
  userName: "support_bot",
  secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
  conversation: "self"
});
```

Use a resolver when routing depends on tenant, channel, thread, or user:

```typescript
telegramMessenger({
  token: this.env.TELEGRAM_BOT_TOKEN,
  userName: "support_bot",
  secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
  conversation(event) {
    return {
      target: "subagent",
      name: `tenant:${event.thread.channelId ?? event.thread.id}`
    };
  }
});
```

## State

Messenger state is backed by `agents/chat-sdk`. Export
`ThinkMessengerStateAgent` from the Worker module so sub-agent routing can
resolve it. Production applications do not need a separate Durable Object
binding or migration for this facet-only state class. Test harnesses may still
need explicit bindings.

## Delivery and Recovery

Think replies with the streamed `chat()` path. The root agent starts an
idempotent managed fiber, resolves the conversation target, calls
`target.chat(message, callback)`, and lets the provider delivery policy post or
edit visible messages.

Recovery snapshots store only serializable event and Chat SDK thread data. If a
restart happens before streaming starts, Think can replay the answer. If a
restart happens after streaming starts, Think posts the configured interruption
message instead of risking a duplicate partial answer.

Delivery errors use a generic user-facing message by default so internal
exception details are not posted into external chats. Override
`delivery.errorResponseText` when you want a custom safe message.

## Messenger Context

During a messenger turn, `getMessengerContext()` returns provider, thread,
author, message, capabilities, and attachment metadata for the initiating event.
Use it from prompts, tools, or hooks that need channel-specific behavior.

```typescript
const messenger = this.getMessengerContext();
if (messenger?.thread.isDirectMessage === false) {
  // Adjust behavior for group chats.
}
```

## Self-Mentions

When a user @-mentions the bot, the triggering message leads with the bot's own
mention. Adapters resolve every other user's mention to a readable
`@DisplayName`, but they leave the bot's own mention as a raw user-id token (for
example, Slack's `@U0BD9EYL52S`) because mention detection still needs it. That
raw id is the only unresolved mention that can survive in the text, so Think
rewrites it to `@<userName>` (the bot handle you already configure) before the
model sees it. This reconstructs the `@handle` the sender originally typed and
keeps a small model from reading the unexplained id as a third party the sender
was trying to reach.

Rewriting reuses the required `userName` option, so no extra configuration is
needed. It only applies when the adapter exposes a `botUserId` (used by
platforms that put ids in mentions). Adapters that mention the bot by handle
(for example, Telegram's `@username`) already produce readable text and are left
unchanged.

## Custom Chat SDK Adapters

Use `chatSdkMessenger()` for providers that do not have a Think helper yet:

```typescript
chatSdkMessenger({
  adapter,
  provider: "custom",
  userName: "custom_bot",
  // Optional: control how channel speakers are labelled for the model.
  // channelSpeakerLabel: (author) => string | null | undefined
  verifyWebhook(request) {
    return request.headers.get("x-custom-signature") === expectedSignature;
  }
});
```

Every custom messenger must provide `verifyWebhook` or explicitly use
`verifyWebhook: false`.

## Advanced Manual Ingress

The `examples/think-chat-sdk` example demonstrates the Think-native
`getMessengers()` path with a small Vite dashboard that inspects the root Think
conversation over the Agent websocket.

The `examples/chat-sdk-messenger` example demonstrates a larger manual ingress
agent with an admin dashboard, menu handling, and application-owned reply
fibers. Use `getMessengers()` for the simple Think-native path. Use the example
when you need to own the Chat SDK runtime and control-plane UI yourself.
