# Chat SDK state

Use `agents/chat-sdk` when you run the [Chat SDK](https://chat-sdk.dev/) inside an Agent and want the Chat SDK `StateAdapter` to use Agents sub-agents for durable state.

The adapter stores Chat SDK subscriptions, locks, queues, dedupe keys, thread state, channel state, callback metadata, transcript lists, and thread history in Durable Object SQLite. Each state shard is a `ChatSdkStateAgent` sub-agent under your ingress Agent.

## Install

Install both packages in the Worker that hosts your messenger ingress:

```bash
npm install agents chat
```

`agents/chat-sdk` itself does not provide a messenger adapter. Use it with any Chat SDK adapter, such as Telegram, Slack, Discord, Teams, or Google Chat.

## Basic setup

Create a parent Agent that owns your Chat SDK runtime. Pass `createChatSdkState()` as the Chat SDK `state` option.

```typescript
import { Agent } from "agents";
import { Chat } from "chat";
import { createChatSdkState } from "agents/chat-sdk";
import { createTelegramAdapter } from "@chat-adapter/telegram";

export { ChatSdkStateAgent } from "agents/chat-sdk";

export class MessengerAgent extends Agent<Env> {
  private chat!: Chat;

  onStart() {
    const telegram = createTelegramAdapter({
      botToken: this.env.TELEGRAM_BOT_TOKEN,
      mode: "webhook",
      secretToken: this.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      userName: "my_bot"
    });

    this.chat = new Chat({
      adapters: { telegram },
      userName: "my_bot",
      state: createChatSdkState(),
      concurrency: { strategy: "burst", debounceMs: 600 }
    });
  }
}
```

Add the parent Agent to your Durable Object migration:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "MessengerAgent", "class_name": "MessengerAgent" }]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MessengerAgent"]
    }
  ]
}
```

Export `ChatSdkStateAgent` from your Worker entry point so sub-agent routing can resolve it. When `createChatSdkState()` is called inside an Agent lifecycle method, it uses the current Agent as the parent and creates state shards with `this.subAgent()`.

## State sharding

By default, Chat SDK state is sharded by the first two colon-separated segments of a thread-like key.

For example, `telegram:-100123:456` and `telegram:-100123:789` share the same state shard, `telegram:-100123`.

The default key sharder recognizes these Chat SDK key prefixes:

- `thread-state:`
- `channel-state:`
- `msg-history:`
- `transcripts:user:`

Unknown keys use the adapter's default shard name, `default`.

## Custom sharding

Use `shardKey` to control how thread IDs map to state sub-agent names:

```typescript
const state = createChatSdkState({
  shardKey(threadId) {
    return threadId.split(":").slice(0, 2).join(":");
  }
});
```

Use `keyShard` when an adapter stores non-thread-shaped keys that should still route to a provider-specific shard:

```typescript
const state = createChatSdkState({
  keyShard(key) {
    if (!key.startsWith("dedupe:telegram:")) {
      return undefined;
    }

    const chatId = key.slice("dedupe:telegram:".length).split(":")[0];
    return chatId ? `telegram:${chatId}` : undefined;
  }
});
```

Returning `undefined` falls back to the built-in key sharder and then to the default shard.

## API

### `createChatSdkState(options)`

Creates a Chat SDK `StateAdapter` backed by a `ChatSdkStateAgent` sub-agent.

```typescript
import { createChatSdkState } from "agents/chat-sdk";

export { ChatSdkStateAgent } from "agents/chat-sdk";

const state = createChatSdkState({
  // parent: this // optional, defaults to the current Agent from `getCurrentAgent()`
});
```

Options:

- `agent`: Optional custom subclass of `ChatSdkStateAgent`. Defaults to `ChatSdkStateAgent`.
- `parent`: Optional parent Agent that will call `subAgent()` to create state shards. Defaults to the current Agent from `getCurrentAgent()` when called inside an Agent lifecycle method or request handler.
- `name`: Default shard name for keys that cannot be mapped. Defaults to `default`.
- `shardKey(threadId)`: Maps Chat SDK thread IDs and lock keys to a shard name.
- `keyShard(key)`: Maps generic Chat SDK cache/list keys to a shard name.

### `ChatSdkStateAgent`

The sub-agent class that stores state in SQLite. Export it from your Worker entry point so the runtime can create it.

```typescript
export { ChatSdkStateAgent } from "agents/chat-sdk";
```

### `ChatSdkStateAdapter`

The concrete `StateAdapter` implementation returned by `createChatSdkState()`. Most applications do not need to instantiate it directly.

## What is stored

The adapter implements the full Chat SDK `StateAdapter` interface:

- Subscriptions for `thread.subscribe()` and `thread.unsubscribe()`.
- Locks for per-thread or per-channel concurrency.
- Pending message queues for `queue`, `debounce`, and `burst` concurrency strategies.
- Generic key-value cache entries with optional TTL.
- Append-only lists with max-length trimming and list-level TTL refresh.

Chat SDK features built on these primitives include:

- Message deduplication.
- Thread and channel state.
- Persistent thread history for adapters that opt in to `persistThreadHistory`.
- Callback URL token storage.
- Modal context storage.
- Cross-platform transcripts.

## Cleanup behavior

TTL reads are strict: expired locks, cache values, queue entries, and list entries are ignored or deleted before they are returned.

Physical cleanup is lazy. `ChatSdkStateAgent` schedules one cleanup callback for the earliest known expiry and reschedules after cleanup runs. This keeps idle shards quiet while preventing expired rows from accumulating indefinitely.

## Example

See `examples/chat-sdk-messenger` for a complete Telegram bot that uses:

- `createChatSdkState()` for Chat SDK state.
- `ThinkMessengerStateAgent`, a Think-specific wrapper around
  `ChatSdkStateAgent`, as a sub-agent.
- Chat SDK burst/debounce concurrency.
- Think-backed AI replies running in managed fibers.
