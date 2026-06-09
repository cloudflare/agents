# Chat SDK Messenger Agents

This example shows how to run a [Chat SDK](https://chat-sdk.dev/) messenger
runtime inside an Agents SDK `Agent`, with subagents for Chat SDK state and
Think-backed AI replies.

Telegram is the concrete adapter used here so the example is runnable as a bot,
but the architecture is not Telegram-specific. Chat SDK can host multiple
messenger adapters in one `Chat()` instance, so the same ingress/state/AI shape
can be adapted to Slack, Discord, Teams, Google Chat, or another Chat SDK
adapter.

## What This Shows

- A top-level `ChatIngressAgent` owns the Chat SDK runtime and webhook ingress.
- Telegram webhooks enter through Chat SDK and are normalized into Chat SDK
  `Thread` and `Message` objects.
- `ThinkMessengerStateAgent` backs Chat SDK subscriptions, locks, queues, cache,
  and lists as an Agents SDK subagent.
- `ConversationAgent extends Think` owns AI message history and model calls per
  Chat SDK `thread.id`.
- The provider boundary stays narrow: Telegram setup/rendering lives at ingress,
  while state and AI behavior stay reusable.

## Run Locally

Install dependencies from the repo root:

```bash
npm install
```

Create a Telegram bot with [BotFather](https://t.me/BotFather), then set local
environment variables:

```bash
cp .env.example .env
```

Fill in:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token-from-botfather
TELEGRAM_WEBHOOK_SECRET_TOKEN=generate-a-random-secret
TELEGRAM_BOT_USERNAME=your_bot_username
```

Start the local Vite/Workers dev server. This starts a Quick Tunnel by default
so Telegram can reach your local webhook:

```bash
npm start
```

The Vite plugin will print a public `trycloudflare.com` hostname. Open that
HTTPS hostname in your browser and click **Set webhook here** in the setup
panel. The button is disabled on `http://localhost` because Telegram requires an
HTTPS webhook URL. It checks Telegram's current webhook URL and only calls
`setWebhook` when it needs to point at this tunnel.

You can still set the webhook manually with:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-tunnel.example.com/webhooks/telegram",
    "secret_token": "'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'"
  }'
```

See Cloudflare's
[local dev tunnel docs](https://developers.cloudflare.com/workers/development-testing/local-dev-tunnels/)
for details.

Then DM your bot. Send `/menu` for the demos or any other message for an AI
reply. In groups, mention the bot to subscribe the thread; after that, mention
the bot again or send `/ask ...` for AI, `/menu` for demos, or `/reset` to clear
that thread's AI history.

This example also uses Workers AI. With the `remote` binding in
`wrangler.jsonc`, local AI calls run against your Cloudflare account.

## Deploy

Store secrets:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET_TOKEN
wrangler secret put TELEGRAM_BOT_USERNAME
```

Deploy:

```bash
npm run deploy
```

Open the deployed Worker root URL to inspect the admin dashboard, then click
**Set webhook here** in the setup panel to point Telegram at the deployed
`/webhooks/telegram` route.

## Architecture

The core pattern is one Chat SDK ingress Agent plus two subagent roles:

```mermaid
flowchart TB
  Messenger[Messenger Provider] -->|"webhook event"| Worker[Worker]
  Worker --> ChatIngressAgent[ChatIngressAgent]
  ChatIngressAgent --> ChatSdk["Chat SDK runtime"]
  ChatSdk -->|"locks, queues, subscriptions, cache"| ThinkMessengerStateAgent[ThinkMessengerStateAgent]
  ChatSdk -->|"normalized Thread and Message"| ChatIngressAgent
  ChatIngressAgent -->|"UIMessage by thread id"| ConversationAgent[ConversationAgent extends Think]
  ConversationAgent --> WorkersAI[Workers AI]
  ConversationAgent -->|"assistant text"| ChatIngressAgent
  ChatIngressAgent -->|"thread.post"| Messenger
  AdminUI["Admin web UI"] --> ChatIngressAgent
  AdminUI -->|"gated sub-agent chat"| ConversationAgent
```

The Worker binds only the top-level `ChatIngressAgent`:

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "ChatIngressAgent", "class_name": "ChatIngressAgent" }
  ]
}
```

Everything else is reached as a subagent:

```text
ChatIngressAgent
  Chat({ adapters: { telegram } })
  ThinkMessengerStateAgent # Chat SDK infrastructure state
  ConversationAgent    # Think messages and model calls per thread
```

The example code is split along the same boundaries:

```text
src/
  admin/                # Admin directory and reply-job display helpers
  intelligence/         # Think conversation, message conversion, reply policy
  provider/telegram.ts  # Telegram webhook setup
  state                 # Backed by @cloudflare/think/messengers
  index.ts              # Ingress orchestration and Chat SDK event wiring
```

`ChatIngressAgent` creates one Chat SDK runtime during `onStart()`:

```ts
export { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";

export class ChatIngressAgent extends Agent {
  onStart() {
    this.bot = this.createBot();
  }

  private createBot() {
    return new Chat({
      userName,
      adapters: { telegram },
      state: createChatSdkState({ agent: ThinkMessengerStateAgent }),
      concurrency: { strategy: "burst", debounceMs: 600 }
    });
  }
}
```

To adapt this example to another messenger, replace or add adapters in that
`Chat()` call and adjust the webhook/setup route. The state adapter and Think
conversation subagent do not need to know which messenger produced the message.

## Adapting To Another Messenger

The provider-specific part of this example is intentionally small:

- Import or create another Chat SDK adapter.
- Add it to the `adapters` object in `createBot()`.
- Route that provider's webhook path to the same `ChatIngressAgent`.
- Adjust menu/actions only where the provider's UX differs.

For example, a multi-provider ingress would still share the same state and AI
subagents:

```ts
const bot = new Chat({
  userName,
  adapters: {
    telegram,
    slack,
    discord
  },
  state: createChatSdkState()
});
```

The important boundary is that provider adapters produce Chat SDK `Thread` and
`Message` objects. From there, `ThinkMessengerStateAgent` and
`ConversationAgent` stay the same.

## State Subagent

The Chat SDK state adapter is provided by `agents/chat-sdk`. This example uses
Think's messenger state agent alias so it matches the first-class Think
messenger APIs:

```ts
import { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
import { createChatSdkState } from "agents/chat-sdk";
```

Export `ThinkMessengerStateAgent` from your Worker entry point so sub-agent
routing can resolve it. The state agent is infrastructure only: it stores Chat
SDK locks, subscriptions, queues, generic cache values, and lists in Durable
Object SQLite. It should not own channel personality, tools, or reasoning.

The community
[`chat-state-cloudflare-do`](https://github.com/dcartertwo/chat-state-cloudflare-do)
package covers the generic Workers story: bring a Durable Object binding and
use it as a Chat SDK state adapter. This example shows the Agents SDK version:
if your app already has an Agent, Chat SDK state can live in a subagent instead
of a separate top-level binding.

## Think-Backed Replies

The AI path is small on purpose:

```text
src/intelligence/
  conversation-agent.ts  # ConversationAgent extends Think
  delivery.ts            # Managed reply snapshots and failure policy
  messages.ts            # Chat SDK Message -> AI SDK UIMessage helpers
```

The RPC-safe `TextStreamCallback` and Telegram delivery helpers now come from
`@cloudflare/think/messengers`.

`ConversationAgent` uses Think's `messages` / Session storage as the canonical
AI history for one Chat SDK `thread.id`. Chat SDK history remains
platform/event history and optional source material for later backfill.

The response path uses Think's `chat()` RPC stream and relays text deltas into
Chat SDK's streaming post API from a managed fiber:

```ts
await this.startFiber(
  "chat-sdk-messenger:ai-reply",
  async (fiber) => {
    fiber.stash({
      type: "chat-sdk-messenger:ai-reply",
      stage: "accepted",
      thread: thread.toJSON(),
      message: message.toJSON()
    });
    await this.answerWithConversationAgent(thread, message, fiber);
  },
  {
    idempotencyKey: `ai-reply:${thread.id}:${message.id}`,
    waitForCompletion: true
  }
);

// Inside answerWithConversationAgent:
// - start a bounded Chat SDK streaming post for the first visible message
// - call Think's chat() with a StreamCallback that keeps the full text
// - post any remaining text as additional provider-safe chunks
// - checkpoint completed state when all visible delivery work finishes
```

This keeps visible messenger writes under application control while still
exercising Think's durable message ownership and streaming turn API. The
callback receives Think's request id in `onStart`, so the ingress agent can call
`cancelChat()` on the conversation sub-agent if the first messenger stream fails
with a real delivery error. Expected Telegram final-edit no-op errors after the
soft limit are treated as delivery completion, not model cancellation. The
managed fiber gives webhook retries a stable idempotency boundary.
`waitForCompletion: true` keeps the Chat SDK handler open until the visible reply
finishes, so Chat SDK's per-thread concurrency strategy still serializes user
visible replies. The serialized Chat SDK thread/message snapshots give recovery
code enough context to restore the reply target after a restart.

Recovery has an explicit visible policy. If the fiber was interrupted before
streaming began, `onFiberRecovered()` restores the Chat SDK thread/message and
replays the AI reply, then returns `{ status: "completed" }` to settle the
managed fiber. If the interruption happened after streaming began, the bot posts
a concise interruption apology and also settles the fiber as completed. Duplicate
webhooks for already completed replies are ignored; duplicates for interrupted
replies trigger the same recovery policy once, then resolve the retained fiber.
Delivery failures after the model finishes are different: they stay terminal
errors unless every intended visible chunk has posted successfully.

`waitForCompletion: true` preserves one visible AI reply at a time per Chat SDK
thread by keeping the Chat SDK handler pending until the managed fiber reaches a
terminal status. That keeps durable webhook acceptance from bypassing the Chat
SDK burst/debounce UX and avoids overlapping Telegram placeholder or streaming
messages.

Think remains the durable source of truth for the complete AI turn. Telegram has
a bounded message size, so the example streams a conservative first message and
then posts long overflow text as follow-up messages after Think completes. That
keeps short replies feeling live while avoiding Telegram final-edit no-op errors
or single-message truncation for long replies.

## Admin Dashboard

The Worker root serves a small admin dashboard. It connects to the parent
`ChatIngressAgent` with `useAgent()` and shows:

- Telegram setup state and the current webhook command.
- Chat SDK conversations that have routed through the AI path.
- The `ConversationAgent` name backing each Chat SDK thread.
- Recent managed AI reply jobs for the selected conversation.
- A Think chat pane for the selected `ConversationAgent`.

The Think pane is intentionally internal-only. Messages sent from the browser
go into the Think session for inspection, debugging, or steering, but they do
not post into Telegram. Posting into the messenger should remain an explicit
channel action so operator messages, bot messages, and synthetic user messages
do not get confused.

The Think pane also shows compact message diagnostics: role, a short message id,
and text length. Those fields make it easier to tell whether an unexpected
assistant entry came from a genuine second turn, an internal admin prompt, or a
replayed/recovered messenger turn.

Browser access to `ConversationAgent` subagents is gated by
`ChatIngressAgent.onBeforeSubAgent()`: only conversation names recorded in the
parent-owned directory can be reached from the admin UI.

## Production Behavior

The example keeps the retry and recovery policy explicit so it is easy to adapt
for other providers:

- The managed fiber idempotency key is
  `ai-reply:${thread.id}:${message.id}`. Provider retries for the same Chat SDK
  message reuse the retained fiber instead of starting a second visible reply.
- `waitForCompletion: true` keeps the Chat SDK handler pending until the visible
  reply work reaches a terminal managed-fiber status. This preserves Chat SDK's
  per-thread burst/debounce behavior for visible replies.
- Long model turns can still exceed provider webhook timeouts. If Telegram
  retries while the original reply is running in the same isolate, the duplicate
  delivery joins the active managed fiber. After a restart, the duplicate
  delivery observes the retained status and either returns or runs recovery.
- `completed` duplicate deliveries are ignored because the visible reply already
  finished.
- Overflow chunk failures are still delivery failures. The managed fiber should
  not be treated as completed until the first visible stream and all follow-up
  chunks have posted successfully.
- `interrupted` duplicate deliveries restore the serialized Chat SDK
  thread/message snapshot, run the same recovery policy, and call
  `resolveFiber()` after application-level recovery succeeds.
- `error` and `aborted` fibers are terminal. This example does not auto-retry
  them; a production bot could add an operator command, retry button, or manual
  reconciliation flow.

Future iterations can use Chat SDK `createChatTools` once there is an approval
UX for model-driven writes.

## Telegram Behavior

Telegram is the included adapter, so the sample handlers are written around
Telegram bot UX:

- Direct messages receive an AI response unless the message is `/menu` or
  `/reset`.
- In groups, the bot subscribes the thread on first mention.
- In subscribed group threads, the bot responds only to later mentions or
  messages starting with `/ask`.
- `/menu` opens the Chat SDK demo menu.
- `/reset` clears the Think conversation for the current Chat SDK thread.
- Long AI replies are split across multiple Telegram messages. The first message
  streams live up to a soft limit, and the remainder is posted after the model
  turn completes.

## Scaling This Up

The current `getIngressAgentName()` helper returns `default`. A larger app
could route to different parent Agent names by tenant, bot, or chat after
verifying the webhook and parsing the update at the Worker boundary:

```text
ChatIngressAgent:tenant-a
  ThinkMessengerStateAgent:telegram:-100123
  ThinkMessengerStateAgent:slack:T123

ChatIngressAgent:tenant-b
  ThinkMessengerStateAgent:discord:987
```

## Caveats

- Telegram webhook URLs must be public. Quick Tunnel URLs are ephemeral, so click
  **Set webhook here** again whenever your tunnel URL changes.
- `TELEGRAM_WEBHOOK_SECRET_TOKEN` is required so Telegram signs webhook
  requests.
- Telegram callback data is limited to 64 bytes. Keep button action IDs short.
- Telegram bots cannot fetch complete historical chat logs. Adapter history is
  limited to what the bot can see/cache.
- The AI path renders assistant text into the messenger only. Reasoning, tool
  calls, tool results, and unknown message parts are visible in the admin Think
  pane for debugging, but they are not posted into Telegram.
- The `default` parent Agent is intentionally simple; high-volume bots should
  consider routing to more specific parent Agent names.
- The admin dashboard is a development/control-plane surface. Add real
  authentication before exposing it in production.

## Related

- [Chat SDK](https://chat-sdk.dev/)
- [Chat SDK Telegram adapter](https://chat-sdk.dev/adapters/official/telegram)
- [Chat SDK state adapters](https://chat-sdk.dev/docs/state)
- [Chat SDK AI helpers](https://chat-sdk.dev/docs/ai)
- [`chat-state-cloudflare-do`](https://github.com/dcartertwo/chat-state-cloudflare-do)
