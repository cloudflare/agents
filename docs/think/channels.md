# Channels

> Experimental. The API surface may evolve before Think graduates out of
> experimental.

A channel is a named behavior policy for a Think turn. Channels let one agent
respond differently when a turn comes from the web app, a messenger host, voice,
or another custom transport.

The standard custom-transport topology is two Durable Objects:

| Role  | Owns                                                                 |
| ----- | -------------------------------------------------------------------- |
| Host  | Transport, auth, webhook verification, commands, threading, delivery |
| Agent | `ingest()` over Workers RPC and per-channel behavior policy          |

The host calls the agent with native Workers RPC:

```typescript
import { getAgentByName } from "agents";
import { collectIngestReply } from "@cloudflare/think";

const agent = await getAgentByName(env.HostedAgent, threadName);
const stream = await agent.ingest({
  channelId: "telegram",
  text: messageText
});
const reply = await collectIngestReply(stream);
```

See `examples/channel-host-telegram` for the reference host pattern: the Chat SDK
and Telegram adapter live in the host Worker, while the Think Durable Object only
declares policy and accepts `ingest()` calls.

## Entry Points

`ingest()` is the primary invocation route for messages arriving from outside
the agent. For orientation, everything that can start or continue a Think turn:

- `ingest()` — external events from a host, over Workers RPC. Applies channel
  policy, returns the NDJSON byte stream. Use this for any transport you own.
- The built-in web WebSocket surface — browser chat via `useAgentChat`. Will
  eventually be re-expressed as a host as well.
- `runTurn()` / `chat()` — in-process calls: the agent's own code, sub-agents,
  scheduled tasks, and workflows. `ingest()` is a thin facade over `runTurn()`.
- `getMessengers()` webhooks — the deprecated Think-owned messenger runtime
  (see [Messengers](./messengers.md)).

## Configure Channels

Override `configureChannels()` to return a map of channel id to
`ChannelDefinition`. Every Think agent always has an implicit `web` channel. You
can override the web policy, but you cannot remove or replace the web channel.

```typescript
import { Think, type ThinkChannels } from "@cloudflare/think";

export class Assistant extends Think<Env> {
  configureChannels(): ThinkChannels {
    return {
      web: {
        kind: "web",
        instructions: "You are chatting in a web app. Use markdown freely."
      },
      voice: {
        kind: "voice",
        instructions: "Keep replies short and speakable. No markdown.",
        tools: (all) => ({ lookup: all.lookup }),
        maxTurns: 3
      },
      telegram: {
        kind: "custom",
        instructions:
          "You are replying inside Telegram. Be concise. Plain text only."
      }
    };
  }
}
```

A `ChannelDefinition` has these fields:

| Field          | Type                                                           | Description                                                                                                                                        |
| -------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`         | `"web" \| "messenger" \| "voice" \| "custom"`                  | **Deprecated — omit it.** Only the deprecated Think-owned `messenger`/`web` wiring consults it; a channel without `kind` is pure behaviour policy. |
| `ingress`      | built-in transport config                                      | Required for messenger channels. Optional for policy-only web, voice, and custom.                                                                  |
| `instructions` | `string \| (ctx: ChannelContext) => string \| Promise<string>` | Prepended to the system prompt for turns on this channel.                                                                                          |
| `tools`        | `(all: ToolSet) => ToolSet`                                    | Narrows the assembled tool set for this channel. It can remove tools, not add them.                                                                |
| `maxTurns`     | `number`                                                       | Per-channel cap on model steps for a turn.                                                                                                         |
| `capabilities` | `ChannelCapabilities`                                          | Surface capabilities such as streaming and message editing. Defaulted for `web`.                                                                   |
| `conversation` | messenger conversation mode or resolver                        | Messenger thread routing. See [Messengers](./messengers.md).                                                                                       |
| `delivery`     | channel delivery policy                                        | Messenger delivery policy.                                                                                                                         |

Transport-flavoured fields (`kind`, `ingress`, `capabilities`, `conversation`,
`delivery`) are **deprecated**: transport belongs to the host, and agent-side
channels are becoming pure behaviour policy (`instructions`, `tools`,
`maxTurns`).

`kind: "messenger"` channels must include webhook ingress. Use
`messengerChannel()` or `getMessengers()` for the built-in messenger runtime.
Other channel kinds can be policy-only.

## Behavior Policy

Channel policy is applied as an overridable default before
[`beforeTurn`](./lifecycle-hooks.md) runs, so a `beforeTurn` override still wins:

- `instructions` is prepended to the base system prompt for the turn.
- `tools` filters the assembled tool set.
- `maxTurns` caps model steps: `beforeTurn` `maxSteps` wins, then channel
  `maxTurns`, then the instance `maxSteps` default.

## Ingest

Use `ingest()` when a host or another Durable Object drives a Think turn.

```typescript
type IngestInput = {
  channelId: string;
  text: string; // or message: UIMessage
  idempotencyKey?: string;
};
```

`channelId` must name a channel from `configureChannels()` or the implicit
`web` channel. Think resolves the channel, stamps the turn with channel context,
applies policy, and runs the turn through `runTurn()`.

`ingest()` always returns `Promise<ReadableStream<Uint8Array>>`. The byte stream
is UTF-8 newline-delimited JSON so it can cross the Workers RPC boundary:

| Frame   | Shape                                      | Meaning                                            |
| ------- | ------------------------------------------ | -------------------------------------------------- |
| `delta` | `{ "type": "delta", "text": "..." }`       | Incremental assistant text.                        |
| `done`  | `{ "type": "done", "message": <message> }` | Terminal success with the final assistant message. |
| `error` | `{ "type": "error", "message": "..." }`    | Terminal failure.                                  |

The returned stream is an observation tap. The turn starts eagerly and continues
until it persists its transcript even if the host never reads the stream, reads
slowly, or cancels early. Hosts that want wait semantics buffer the stream on
their side:

```typescript
import { collectIngestReply } from "@cloudflare/think";

const stream = await agent.ingest({
  channelId: "telegram",
  text: "hello"
});

const reply = await collectIngestReply(stream);
```

Or decode frames directly to stream into the host-owned transport:

```typescript
import { decodeIngestStream } from "@cloudflare/think";

const stream = await agent.ingest({
  channelId: "telegram",
  text: "hello"
});

for await (const event of decodeIngestStream(stream)) {
  if (event.type === "delta") {
    // Stream text to the host-owned transport.
  }
}
```

## Select A Channel Directly

Pass `channel` to [`runTurn()`](./index.md#runturn) or `chat()` to run a
programmatic turn on a specific channel:

```typescript
await this.runTurn({ input: "Read this out loud", channel: "voice" });
```

Inside a turn, the active channel is available as `this.activeChannel`.
Continued and recovered turns re-resolve the stamped channel and re-apply its
policy.

## Deliver Out Of Band

`deliverNotice()` sends a message to a channel without starting a model turn.
Use it for status updates or to surface an action's
[reply attachment](./actions.md#reply-attachments).

```typescript
await this.deliverNotice("Your export is ready to download.");

await this.deliverNotice("Background research finished.", {
  informModel: true
});
```

Behavior depends on the target channel:

- `web`: the notice is appended to the transcript.
- `messenger`: the notice is posted to the provider. Out of turn, pass `thread`
  to target a conversation.
- `voice` and `custom`: out-of-turn delivery throws because Think does not own a
  transport delivery surface for these channels.

Override `renderAttachment(attachment)` to turn an action reply attachment into a
notice. Think calls it at the end of a turn and delivers the rendered text as a
trailing `interim` notice. Return `undefined` to skip an attachment type.

## Relationship To Messengers

`configureChannels()` wraps `getMessengers()`. It does not replace it. Each
`getMessengers()` entry becomes a `kind: "messenger"` channel, and existing
messenger webhook routing, conversation targets, delivery, and recovery continue
to apply.

Use `getMessengers()` for messenger-only apps where Think owns the Chat SDK
runtime. Use a host plus `ingest()` when your app needs to own the transport,
commands, adapter options, or state outside Think.

## Observability

Channel activity is reported on the `channel` observability channel:

```typescript
import { subscribe } from "agents/observability";

const unsubscribe = subscribe("channel", (event) => {
  // event.type is one of:
  //   "channel:resolved"  - a turn resolved a registered channel
  //   "channel:delivered" - a turn's final reply was delivered
  //   "notice:delivered"  - deliverNotice() succeeded
  //   "notice:failed"     - deliverNotice() threw
});
```

## Reference

| Member                          | Description                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `configureChannels()`           | Return the channel map. Defaults to `{}` plus the implicit `web` channel.      |
| `ingest(input)`                 | External ingress over Workers RPC or in-process calls.                         |
| `deliverNotice(text, options?)` | Send an out-of-band message to a channel with no model turn.                   |
| `activeChannel`                 | The `ChannelContext` for the in-flight turn, or `undefined`.                   |
| `renderAttachment(attachment)`  | Map a reply attachment to channel notice text or `undefined` to skip.          |
| `messengerChannel(definition)`  | Wrap a Chat SDK adapter as a `kind: "messenger"` channel with webhook ingress. |

## Related

- [Messengers](./messengers.md) - Chat SDK webhook setup and delivery in depth.
- [Actions](./actions.md) - record reply attachments for `renderAttachment()`.
- [Voice Agents](https://github.com/cloudflare/agents/blob/main/docs/voice/index.md) - real-time speech surfaces.
