# RFC: Discord messengers for Think

Status: proposed

Related:

- [`docs/think/messengers.md`](../docs/think/messengers.md) - current
  Think messenger user-facing docs.
- [`ideas/messengers.md`](../ideas/messengers.md) - original cross-platform
  messenger exploration.

## Summary

Add a first-class Discord provider at
`@cloudflare/think/messengers/discord` that supports both Discord ingress
surfaces:

1. **Interactions** - signed HTTP callbacks for slash commands, buttons, and
   select menus.
2. **Gateway** - a persistent Discord Gateway connection for DMs, mentions,
   subscribed channel/thread messages, reactions, and other real-time events.

Both surfaces feed the same Chat SDK runtime and the same Think messenger
delivery path. Interactions are not a temporary MVP that excludes Gateway;
Gateway is part of the core design because normal Discord messages do not
arrive through HTTP webhooks.

The design takes the official `@chat-adapter/discord` package as the semantic
reference for Discord-specific behavior. Direct dependency reuse is not the
implementation path for Workers: a browser/Worker-style bundle validation fails
on Node-only imports from `@chat-adapter/discord`, `@chat-adapter/shared`, and
`discord.js` (`async_hooks`, `crypto`, `node:events`, `node:path`,
`node:process`). The package does bundle for Node, but the resulting graph is a
large `discord.js`-based runtime. Think should provide a Workers-native Discord
adapter that implements the Chat SDK `Adapter` contract and mirrors the official
adapter's event normalization, command parsing, card rendering, and thread ID
semantics.

## Problem

The current Think messenger runtime is webhook-first. Telegram fits that model:
Telegram sends message updates to one HTTP endpoint, Chat SDK normalizes them,
and Think routes direct messages, mentions, subscribed-thread messages, and
actions into durable reply fibers.

Discord splits bot ingress across two APIs:

- Interactions arrive over a signed HTTP endpoint and require a response or
  deferred response within roughly three seconds.
- Normal messages, DMs, mentions, reactions, member events, and thread events
  arrive over the Discord Gateway WebSocket.

If the SDK only implements Interactions, Discord agents cannot behave like the
Telegram messenger path. They cannot respond naturally to DMs or mentions. If
the SDK only implements Gateway, it misses slash commands and component actions,
and it does not satisfy Discord's recommended command UX.

## Goals

- Keep the user-facing Think API parallel to `telegramMessenger()`.
- Allow Interactions-only, Gateway-only, or both in one `discordMessenger()`
  definition.
- Route slash commands, buttons, DMs, mentions, and subscribed thread messages
  through one provider definition, one Chat SDK state adapter, and one Think
  delivery implementation.
- Reuse Chat SDK primitives for dispatch, dedupe, locking, callback URLs,
  slash commands, reactions, cards, formatted content, and thread serialization
  instead of adding parallel Think-only abstractions.
- Keep the Discord implementation Workers-native: no `discord.js`, no Node
  crypto, no Node event emitter stack, and no cron-overlap Gateway listener.
- Support durable Gateway reconnect/resume, heartbeats, sharding, and Identify
  rate limits.
- Preserve the existing provider-neutral messenger context shape where possible.
- Make Discord-specific limits explicit through capabilities and delivery
  policy.

## Non-goals

- Discord OAuth, bot installation, command registration, or application setup
  flows.
- Discord voice.
- A general-purpose Gateway framework for non-Discord providers.
- Modal UX as a Think messenger turn primitive. Discord modal support is a
  provider/card concern, not part of model-turn routing.
- Exactly-once processing across all Gateway reconnect races. The design uses
  stable idempotency keys and accepts at-least-once delivery from Discord.

## Proposed API

```ts
import { Think } from "@cloudflare/think";
import {
  defineMessengers,
  ThinkMessengerStateAgent
} from "@cloudflare/think/messengers";
import discordMessenger, {
  ThinkDiscordGatewayShardAgent
} from "@cloudflare/think/messengers/discord";

export { ThinkMessengerStateAgent, ThinkDiscordGatewayShardAgent };

export class SupportAgent extends Think<Env> {
  getMessengers() {
    return defineMessengers({
      discord: discordMessenger({
        token: this.env.DISCORD_BOT_TOKEN,
        applicationId: this.env.DISCORD_APPLICATION_ID,
        publicKey: this.env.DISCORD_PUBLIC_KEY,
        mentionRoleIds: ["123456789012345678"],
        userName: "support-bot",
        interactions: {
          defaultVisibility: "public",
          enabled: true
        },
        gateway: {
          intents: ["GuildMessages", "DirectMessages", "MessageContent"],
          shards: "auto"
        },
        guildMentions: {
          createThread: true
        },
        allowedMentions: {
          parse: []
        },
        respondTo: [
          "command",
          "direct-message",
          "mention",
          "subscribed-thread",
          "action",
          "reaction"
        ]
      })
    });
  }
}
```

`interactions.enabled: true` enables the HTTP endpoint at the normal messenger
path, `/messengers/discord/webhook`. `gateway` enables background Gateway shards
for real-time events. Users can set either one independently.

The provider helper should default to Interactions when `publicKey` is present
and Gateway when `gateway` is provided. Gateway should never turn on implicitly
from only `token`; it needs explicit intents.

## User Setup Workflow

Discord setup is part of the integration surface because the runtime cannot work
until the application, bot, commands, endpoint, permissions, and intents line up.
User-facing docs and examples should walk through this sequence:

1. Create a Discord application in the Developer Portal.
2. Copy the Application ID and Public Key from **General Information**.
3. Reset and store the bot token from **Bot** as a Worker secret.
4. Choose installation contexts: guild install, user install, or both.
5. Configure install scopes:
   - `applications.commands` for slash commands.
   - `bot` for Gateway messages, DMs, channel posting, reactions, and thread
     participation.
6. Configure bot permissions for guild installs:
   - `VIEW_CHANNEL`
   - `SEND_MESSAGES`
   - `SEND_MESSAGES_IN_THREADS`
   - `CREATE_PUBLIC_THREADS` when `guildMentions.createThread` is true.
   - `CREATE_PRIVATE_THREADS` only when private thread creation is enabled.
   - `READ_MESSAGE_HISTORY`
   - `ADD_REACTIONS` when reaction APIs are used.
   - `ATTACH_FILES` when file uploads are enabled.
   - `EMBED_LINKS` when cards render as embeds.
7. Enable privileged intents in the Bot settings when configured:
   - `MESSAGE_CONTENT` for non-mentioned guild message content, especially
     subscribed-thread follow-ups.
   - `GUILD_MEMBERS` only if the application needs member data beyond the
     message payloads Discord already sends.
8. Export `ThinkMessengerStateAgent` and `ThinkDiscordGatewayShardAgent` from
   the Worker module.
9. Add `discordMessenger()` to `getMessengers()` with `token`, `applicationId`,
   `publicKey`, explicit Gateway intents, and any role mention IDs.
10. Deploy the Worker before configuring the Interactions endpoint, because
    Discord verifies the endpoint with a signed `PING`.
11. Set the Interactions Endpoint URL to
    `https://<worker>/messengers/discord/webhook` when using HTTP
    Interactions.
12. Register slash commands through Discord's HTTP API. Use guild commands for
    development because they update immediately; use global commands for
    production after testing.
13. Wake the root Think agent to start Gateway shards. Interactions can do this
    on first request; Gateway-only deployments need a scheduled Worker trigger
    or authenticated control-plane call.
14. Test slash commands, buttons/selects, DMs, guild mentions,
    subscribed-thread follow-ups, reactions, Gateway reconnect, and Worker
    deploy disconnect recovery.

## Public Type Changes

Add a command event kind and response selector:

```ts
export type MessengerEventKind =
  | "action"
  | "command"
  | "delivery-event"
  | "direct-message"
  | "mention"
  | "reaction"
  | "subscribed-message";

export type MessengerRespondTo =
  | "action"
  | "command"
  | "direct-message"
  | "mention"
  | "reaction"
  | "subscribed-thread";
```

Add command and reaction context without overloading `message`:

```ts
export interface MessengerCommand {
  command: string;
  providerCommandId?: string;
  raw?: unknown;
  text?: string;
  user?: MessengerAuthor;
  values?: Record<string, unknown>;
}

export interface MessengerReaction {
  added: boolean;
  emoji: string;
  messageId: string;
  raw?: unknown;
  user?: MessengerAuthor;
}

export interface MessengerContext {
  action?: MessengerAction;
  author?: MessengerAuthor;
  capabilities: MessengerCapabilities;
  command?: MessengerCommand;
  kind: MessengerEventKind;
  message?: MessengerMessage;
  messengerId: string;
  provider: string;
  reaction?: MessengerReaction;
  thread: MessengerThread;
}
```

`toMessengerUserMessage()` should render commands as a user message such as:

```text
Slash command: /ask
Text: summarize the incident
```

If the command has an initiating user, include the display name in group
contexts in the same way normal group messages are attributed today.

Reactions are opt-in, matching actions. A reaction event should become a Think
user message only when `respondTo` includes `"reaction"`; otherwise the provider
can still expose reactions through lower-level Chat SDK handlers without
starting a model turn.

## Messenger Runtime Changes

The current runtime assumes every messenger has one HTTP webhook path. Discord
needs optional HTTP ingress plus background ingress. Extend
`MessengerDefinition` additively:

```ts
export interface MessengerDefinition {
  adapter: Adapter;
  adapterName: string;
  background?: MessengerBackgroundIngress;
  path?: string | false;
  verifyWebhook?:
    | false
    | ((request: Request) => boolean | Response | Promise<boolean | Response>);
  // existing fields unchanged
}

export interface MessengerBackgroundIngress {
  start(context: MessengerBackgroundContext): Promise<void> | void;
}

export interface MessengerBackgroundContext {
  chat: Chat<Record<string, Adapter>>;
  definition: NormalizedMessengerDefinition;
  host: MessengerThinkHost;
  messengerId: string;
}
```

Rules:

- Existing providers keep the default HTTP path and still require an explicit
  verification posture.
- `path: false` disables HTTP route registration and removes the verification
  requirement for Gateway-only providers. `path: false` is only valid when the
  messenger also provides `background` ingress; otherwise the provider has no
  way to receive events.
- Background ingress starts only on the root Think agent, matching existing
  messenger route ownership.
- The runtime must pass a `waitUntil`-style hook to Chat SDK webhook handling
  when the host can provide one. Discord Interactions need this so the adapter
  can acknowledge quickly and continue processing in the background.

The runtime should also register `chat.onSlashCommand()` when any definition
responds to `command`, parallel to `onDirectMessage`, `onNewMention`,
`onSubscribedMessage`, and `onAction`.

Chat SDK already exposes slash command primitives (`onSlashCommand()` and
`processSlashCommand()`). The Think change is to translate those existing Chat
SDK events into `MessengerEvent`/`MessengerContext`, not to add a new command
abstraction below Chat SDK.

The runtime should also register `chat.onReaction()` when any definition
responds to `reaction`. Chat SDK already normalizes `ReactionEvent` and handles
self-filtering; Think only needs to convert the event into messenger context and
durable reply routing.

Commands are channel-originated in Chat SDK: `SlashCommandEvent` exposes
`event.channel`, not `event.thread`. Generic messenger delivery therefore
should accept any Chat SDK `Postable` surface with `post()` and `startTyping()`
rather than only `Thread`. The public `MessengerContext.thread` remains a
normalized conversation reference derived from the channel id so existing Think
conversation routing still has a stable key.

## Discord Installation Modes

Discord has two installation contexts that affect what the integration can do:

| Installation context                            | What works                                                               | Runtime implications                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Guild install with `bot` scope                  | Gateway messages, DMs, channel posts, reactions, threads, slash commands | Required for natural bots that respond to mentions and subscribed threads in servers.  |
| User install with `applications.commands` scope | Commands in supported contexts                                           | Useful for command-only experiences. Does not grant the bot guild message permissions. |

The Think Discord docs should recommend guild install with both `bot` and
`applications.commands` for the default messenger experience. User install is a
valid command-only setup, but it should not be presented as equivalent to a
Gateway-capable bot.

## Command Registration

Discord commands can only be registered through Discord's HTTP API. Runtime
ingress must not register commands implicitly during request handling, but the
SDK should provide a small helper or example script for command registration so
users can complete setup without writing raw REST calls.

The registration story should follow Discord's constraints:

- Use guild commands during development because they update immediately.
- Use global commands for production after validation.
- Include `integration_types` and `contexts` when commands should support user
  installs, guild installs, DMs, or private channels.
- Preserve Discord's limits: command names 1-32 characters, descriptions 1-100
  characters, at most 25 options, required options before optional options, and
  100 global chat input commands.
- Document the 200 application command creates per day per guild limit. Helpers
  should prefer bulk overwrite/update semantics and avoid repeated create loops.
- Command permissions that target users, roles, or channels require Bearer token
  flows and are outside the bot-token helper. Default member permissions can be
  included in command payloads.

## Message Content Intent Matrix

Discord's `MESSAGE_CONTENT` privileged intent affects whether message content is
present on Gateway events. The provider should document and enforce behavior as:

| Event source                                                | Content availability                | Think behavior                                                                     |
| ----------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| DM with the bot                                             | Available without `MESSAGE_CONTENT` | `direct-message` works without the privileged intent.                              |
| Guild message that mentions the app                         | Available without `MESSAGE_CONTENT` | `mention` works without the privileged intent.                                     |
| Subscribed guild thread/channel follow-up without a mention | Requires `MESSAGE_CONTENT`          | `subscribed-thread` should warn at startup if configured without `MessageContent`. |
| Bot-authored message                                        | Available, but filtered as self     | Never starts a model turn.                                                         |

If `respondTo` includes `"subscribed-thread"` for guild messages and Gateway
intents do not include `MessageContent`, startup should emit a clear warning. If
Discord omits content anyway, the adapter should not synthesize fake text; it
should skip the event or produce a safe empty-content event that does not start a
model turn.

## Discord Interactions Ingress

Interactions use the normal messenger HTTP route. The Discord adapter verifies:

- `X-Signature-Ed25519`
- `X-Signature-Timestamp`
- Raw request body bytes
- Configured Discord application public key

The verifier should reject stale timestamps to reduce replay risk. The helper
requires `publicKey` when Interactions are enabled unless the user supplies a
custom `verifyWebhook` or explicitly sets `verifyWebhook: false`.

Interaction handling maps Discord payloads into Chat SDK events:

| Discord interaction             | Chat SDK event       | Think event kind |
| ------------------------------- | -------------------- | ---------------- |
| `PING`                          | HTTP `PONG` response | none             |
| Application command             | slash command        | `command`        |
| Message component button/select | action               | `action`         |

Discord sends interactions through either an Interactions Endpoint URL or
Gateway `INTERACTION_CREATE`, not both for the same configured application
delivery mode. The supported modes are:

| Mode                                 | User setup                                                         | Think behavior                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| HTTP Interactions + Gateway messages | Set the Interactions Endpoint URL and start Gateway shards         | Commands/actions arrive over HTTP; messages/reactions arrive over Gateway. This is the recommended full messenger setup. |
| HTTP Interactions only               | Set the Interactions Endpoint URL and omit Gateway                 | Commands/actions work; DMs, mentions, reactions, and subscribed messages do not.                                         |
| Gateway-only                         | Leave the Interactions Endpoint URL unset and start Gateway shards | Commands/actions/messages/reactions arrive over Gateway; interaction responses still use Discord HTTP callbacks.         |

Long-running model replies must defer the interaction within Discord's response
deadline, then edit the original response or post follow-ups through Discord's
interaction webhook token. The Chat SDK adapter should own this because it is a
Discord delivery concern, not a Think concern.

The Workers-native adapter should mirror the official adapter's request-local
slash command response behavior: during a slash command handler, the first
`post()` to the command's channel edits the deferred original interaction
response, and subsequent posts use follow-up interaction webhooks. This keeps
Think delivery generic while producing the correct Discord UX.

`interactions.defaultVisibility` controls the initial command response flag:

| Value         | Behavior                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `"public"`    | Defer and edit a public original interaction response. Default.                                                                |
| `"ephemeral"` | Defer with Discord's `EPHEMERAL` flag and edit an ephemeral original response. Only applies to interaction-originated replies. |

This is intentionally separate from generic `supportsEphemeral`, which remains
false because Discord does not expose a general cross-surface ephemeral posting
primitive.

Button and select payloads should use Chat SDK's callback-token pattern. Chat
SDK rewrites `Button callbackUrl` into a short state-backed token before
rendering, then resolves that token when the action arrives. Discord `custom_id`
is limited to 100 characters, so long workflow callback URLs and long action
payloads must not be embedded directly in Discord components. The Discord
renderer should validate the encoded `custom_id` and fail before posting when an
action id/value cannot fit.

Select menus use the same action event path as buttons. `MessengerAction.value`
should contain the selected value for single-select inputs and a serialized
representation for multi-select inputs. The raw interaction keeps the original
`values` array and resolved users/roles/channels for applications that need the
full Discord payload.

Signature verification must use Workers-native Web Crypto. Cloudflare Workers
supports Ed25519 in `crypto.subtle`, so the provider can verify Discord's raw
body bytes with the configured public key without `discord-interactions` or Node
crypto. Verification must use the raw request body, reject missing signature
headers, and reject stale timestamps.

## Chat SDK Semantics to Mirror

The Workers-native Discord adapter should mirror these official Chat SDK
Discord adapter semantics:

- `adapter.name` is `"discord"`; `botUserId` is the application id; `userName`
  is configurable.
- `mentionRoleIds` augments direct bot mentions, so role mentions can trigger
  `onNewMention` and Think `mention` events.
- Slash commands normalize to command paths with subcommands included, for
  example `/project issue create`, while leaf option values flatten into
  `text`. The raw command option tree remains available on `raw`.
- Buttons and select menus normalize to Chat SDK action events with `actionId`,
  `value`, `messageId`, `threadId`, `user`, `triggerId`, and `raw` when
  available.
- Reactions normalize to Chat SDK reaction events with `added`, normalized emoji,
  raw emoji, `messageId`, `threadId`, `user`, and `raw`.
- Cards render as Discord embeds plus action rows. Action rows contain at most
  five components. Link buttons use URL buttons. GFM tables render in embed text
  as GFM tables. Unsupported card children fall back to readable text.
- Message content uses Discord markdown. `{ markdown }` converts from Chat SDK's
  formatted AST; bare strings remain plain text except for safe emoji/mention
  conversion.
- `openDM(userId)` creates or resolves `discord:@me:{channelId}`.
- `getUser(userId)` returns Discord profile fields available to bot tokens and
  never claims to provide email.
- `fetchMessages`, `fetchChannelMessages`, `listThreads`, `fetchThread`, and
  `fetchChannelInfo` should exist because Think tools and scheduled work can use
  them outside inbound handlers.

## Discord Gateway Ingress

Gateway is implemented as provider-owned Durable Object sub-agents, not as a
long-lived loop inside the root Think agent and not as a cron-overlap listener.
This keeps each shard isolated, lets shards reconnect independently, and keeps
Gateway protocol state separate from Think conversation state.

The Discord provider exports `ThinkDiscordGatewayShardAgent`. Applications that
enable Gateway export it from the Worker entry point, just like
`ThinkMessengerStateAgent`:

```ts
export { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";
export { ThinkDiscordGatewayShardAgent } from "@cloudflare/think/messengers/discord";
```

The root messenger runtime owns a lightweight Gateway manager:

1. Resolve shard count from `gateway.shards` or Discord's `/gateway/bot` API.
2. Create one `ThinkDiscordGatewayShardAgent` sub-agent per configured shard.
3. Pass serializable shard configuration to each shard.
4. Let shards own WebSocket connect, heartbeat, resume, backoff, and alarms.
5. Forward accepted Discord dispatches back to the root runtime as internal
   provider events.
6. The root runtime calls the Discord adapter's dispatch processor, which uses
   Chat SDK `processMessage`, `processReaction`, `processAction`, and
   `processSlashCommand` APIs.

The root remains the only place that registers Think reply handlers. Shards do
not run model turns and do not own Think conversation state.

The official adapter's serverless Gateway forwarder is still a useful boundary:
it forwards normalized events like `GATEWAY_MESSAGE_CREATE`,
`GATEWAY_MESSAGE_REACTION_ADD`, and `GATEWAY_MESSAGE_REACTION_REMOVE` into the
same webhook handler. The Workers design should keep that internal event shape
but deliver it through typed Agent/facet calls, not public HTTP, and never use
the Discord bot token as an internal forwarding credential.

Outgoing Gateway WebSockets do not use Durable Object hibernation. The shard DO
is active while connected, persists session/sequence state before updating
in-memory state, and uses alarms for reconnects. Each shard owns one alarm;
setting a reconnect alarm replaces any previous reconnect alarm for that shard.

### Gateway Shard State

Each shard stores:

- Shard id and total shard count.
- Gateway URL and `resume_gateway_url`.
- Discord `session_id`.
- Last sequence number.
- Last heartbeat send time and ACK time.
- Identify backoff state.
- Last fatal close code, if any.

Shard alarms reconnect when the socket closes unexpectedly. Resume is attempted
when Discord allows it. Invalid sessions fall back to Identify after the
required delay. Fatal close codes such as disallowed intents should stop the
shard and surface a clear diagnostic instead of looping.

### Gateway Connection Mechanics

Gateway shards should implement Discord's documented lifecycle directly with
Workers WebSockets:

- Fetch `/gateway/bot` with the bot token to resolve the recommended shard count,
  Gateway URL, session start limit, and `max_concurrency`.
- Connect with `v=10&encoding=json` and no compression. JSON without compression
  avoids zlib/zstd streaming state in the first Workers-native implementation.
- On Hello (`op: 10`), wait `heartbeat_interval * jitter` before the first
  heartbeat, then heartbeat every interval with the latest sequence number.
- If a heartbeat ACK (`op: 11`) is not received before the next heartbeat window,
  close the socket with a non-1000/non-1001 code and attempt Resume.
- Store every non-null dispatch sequence (`s`) before dispatching the event.
- On Ready, persist `session_id` and `resume_gateway_url`.
- On Reconnect (`op: 7`), reconnect and send Resume (`op: 6`) when session data
  exists.
- On Invalid Session (`op: 9`), Resume only when Discord marks the session
  resumable; otherwise reconnect and Identify after the required delay.
- Respect close codes: invalid shard and disallowed intents are fatal until
  configuration changes; resumable disconnects should use Resume first.
- Identify requests are started in `shard_id % max_concurrency` buckets. Buckets
  start in order, and each bucket waits the Discord-required interval before the
  next bucket.
- Track daily Identify usage. Discord's 1000 Identifies per 24 hours limit is
  global across shards and excludes Resume calls; reconnect policy should prefer
  Resume whenever possible.

### Gateway Intents

The user must opt in to intents explicitly:

```ts
gateway: {
  intents: ["GuildMessages", "DirectMessages", "MessageContent"];
}
```

`MessageContent` is privileged for many bots. Without it, guild message text may
be unavailable. The adapter should still process mentions and events that
Discord includes, but it should not pretend to have message text when Discord
omits it.

### Gateway Dispatch Mapping

Gateway support covers:

| Discord dispatch                           | Chat SDK event     | Think event kind     |
| ------------------------------------------ | ------------------ | -------------------- |
| `MESSAGE_CREATE` in DM                     | direct message     | `direct-message`     |
| `MESSAGE_CREATE` mention                   | new mention        | `mention`            |
| `MESSAGE_CREATE` subscribed channel/thread | subscribed message | `subscribed-message` |
| `MESSAGE_REACTION_ADD` / remove            | reaction           | `reaction`           |
| Gateway interaction command                | slash command      | `command`            |
| Gateway interaction component              | action             | `action`             |
| `THREAD_CREATE` / update                   | thread metadata    | no model turn        |

## Thread and Message Identity

Use stable, provider-prefixed IDs compatible with Chat SDK's official Discord
adapter:

| Discord context        | Thread id shape                            |
| ---------------------- | ------------------------------------------ |
| DM channel             | `discord:@me:{channelId}`                  |
| Guild channel          | `discord:{guildId}:{channelId}`            |
| Discord thread channel | `discord:{guildId}:{channelId}:{threadId}` |

`channelIdFromThreadId()` maps guild channel and thread conversations to the
Discord channel/thread id that should receive replies. `providerThreadId` in the
Think context remains the encoded Discord thread id. `providerMessageId` remains
the Discord snowflake message id.

Conversation routing stays unchanged: the default Think conversation name is
`messenger:{messengerId}:{stable thread id}`. Applications can still provide a
custom `conversation(event)` resolver for tenant, guild, channel, or user based
routing.

### Guild Mention Threading

Discord guild mentions should create a Discord thread by default when the
mention happens in a normal text channel and not in an existing thread:

```ts
guildMentions: {
  createThread: true;
}
```

This mirrors the official Chat SDK Discord adapter and gives Think a stable
conversation container for subscribed follow-ups. It requires
`CREATE_PUBLIC_THREADS` and `SEND_MESSAGES_IN_THREADS`. If thread creation
fails because permissions are missing, the adapter should fall back to the parent
channel, post a safe diagnostic when possible, and emit a structured warning so
the developer can fix bot permissions.

Applications can set `guildMentions.createThread: false` to keep mention
conversations in the parent channel. That mode should be documented as noisier
for shared channels because subscribed follow-ups use the channel as the
conversation surface.

## Delivery Policy

Discord delivery defaults:

```ts
capabilities: {
  canEditMessages: true,
  canStream: true,
  maxMessageLength: 2000,
  supportsActions: true,
  supportsAttachments: true,
  supportsEphemeral: false
}

delivery: {
  splitText: splitDiscordMessageText,
  visibleSoftLimit: 1800
}
```

The adapter should use post-and-edit streaming for normal channel messages. For
Interactions, it should defer quickly and stream by editing the original
interaction response when possible, then post follow-up messages for overflow.

Discord does not have the same generalized ephemeral surface as Slack in Chat
SDK. The official Discord adapter uses DM fallback for ephemeral-style sends.
Think does not advertise native ephemeral support. If command-only responses
need private replies, that is an explicit Discord delivery option separate from
generic `supportsEphemeral`.

Discord has strict REST rate limits. The adapter owns route-level 429 handling,
global 429 handling, and safe retry-after behavior. Think should only see a
delivery error after the adapter exhausts safe retries or receives a permanent
Discord error.

### Allowed Mentions

Model output is untrusted text and can contain `@everyone`, role mentions, or
user mentions. Discord responses should default to safe `allowed_mentions`:

```ts
allowedMentions: {
  parse: [];
}
```

Applications can opt into selected user or role mentions, but `everyone` should
remain disabled unless explicitly configured. This applies to normal messages,
interaction responses, follow-ups, and edited messages.

### Permissions and Invalid Requests

Discord counts repeated `401`, `403`, and `429` responses toward its invalid
request limit. The adapter should reduce invalid requests by design:

- Use interaction `app_permissions` when present to detect missing send, embed,
  attach, thread, and reaction permissions before attempting API calls.
- Parse rate-limit headers and 429 bodies; do not hardcode route limits.
- Track global 429 responses separately from route buckets.
- Stop retrying after permanent `401` token failures until configuration changes.
- Treat missing permissions as actionable diagnostics, not generic delivery
  failures.
- Avoid repeated calls to deleted or inaccessible webhook/message resources after
  a `404` or permanent `403`.

## Activation and Operations

Gateway connections cannot start at deploy time because Workers only run when
invoked. Gateway startup therefore needs an activation path:

- If Interactions are enabled, the first Discord interaction can wake the root
  agent and start Gateway shards.
- Gateway-only bots should use a scheduled Worker trigger or an explicit
  application control-plane call that wakes the root agent and lets the gateway
  manager start shards.
- Once started, shard DO alarms keep reconnecting after socket closures or DO
  eviction.

The user-facing docs should call this out clearly so Gateway-only bots do not
appear idle simply because no request has awakened their root agent yet.

### Local Development

Local development needs two paths:

- Interactions require a public HTTPS URL because Discord verifies the endpoint
  by sending a signed `PING`. The docs should use the same local tunnel pattern
  as existing Worker examples and point the Discord Interactions Endpoint URL at
  `/messengers/discord/webhook`.
- Gateway can connect outbound from local dev once the root agent is awake. For
  local testing, provide an explicit setup action or route in the example that
  calls the root agent's Gateway startup method, instead of requiring users to
  wait for a scheduled trigger.

The local checklist should test both surfaces: a slash command/button through
the public tunnel and a DM/mention through the Gateway connection.

## Security

- Treat all Discord HTTP payloads and Gateway dispatches as untrusted input.
- Verify Interaction signatures against the raw request body before parsing JSON.
- Reject stale Interaction timestamps.
- Never log bot tokens, interaction tokens, authorization headers, or full raw
  payloads by default. Do not log public keys, signature prefixes, request body
  prefixes, or interaction webhook tokens during verification failures.
- Require explicit Gateway intents and document the risk of the privileged
  `MessageContent` intent.
- Drop messages authored by the bot itself before dispatching to Think.
- Use idempotency keys based on Discord snowflakes for messages and interaction
  ids for commands/actions.
- Use `crypto.subtle` for Ed25519 verification and `crypto.timingSafeEqual` for
  fixed-length internal token comparisons.

## Package Shape

`@cloudflare/think` should expose a provider-specific subpath:

```jsonc
{
  "exports": {
    "./messengers/discord": {
      "types": "./dist/messengers/discord.d.ts",
      "import": "./dist/messengers/discord.js"
    }
  }
}
```

As with Telegram, Discord adapter code should be optional so users who do not
import the Discord subpath do not bundle it. The implementation should not
depend directly on `@chat-adapter/discord` because the published adapter imports
Node-only modules and `discord.js`. Instead, the Think subpath should provide a
Workers-native Chat SDK adapter that mirrors the official adapter's public
semantics and avoids Node runtime dependencies.

## Validation

- `npm view @chat-adapter/discord@4.30.0` confirms an official Chat SDK Discord
  adapter exists with dependencies on `discord-api-types`,
  `discord-interactions`, `discord.js`, `@chat-adapter/shared`, and `chat`.
- A browser/Worker-style esbuild bundle of `createDiscordAdapter()` fails on
  Node-only imports: `async_hooks`, `crypto`, `node:events`, `node:path`, and
  `node:process`.
- A Node-platform bundle succeeds, but produces a large `discord.js` graph. That
  validates the package for Node/serverless use, not as a Workers-native
  dependency.
- Cloudflare Workers Web Crypto supports Ed25519 verification through
  `crypto.subtle`, so Interaction verification can be implemented without Node
  crypto or `discord-interactions`.
- Cloudflare Durable Objects support outbound WebSockets, alarms, and persistent
  SQLite state, which are the primitives needed for Gateway shard ownership.
- Discord docs confirm Interactions Endpoint delivery and Gateway
  `INTERACTION_CREATE` delivery are mutually exclusive delivery modes, while
  Gateway-received interactions still respond through HTTP callbacks.
- Discord docs require an initial interaction response within three seconds,
  expose interaction tokens for follow-ups for 15 minutes, require explicit
  Gateway intents, and define Identify/sharding/session-start limits that the DO
  shard manager must enforce.

## Implementation Plan

1. Add command and reaction event types, then wire Chat SDK's existing slash
   command and reaction events into the generic Think messenger runtime.
2. Generalize messenger delivery surfaces from `Thread` only to Chat SDK
   `Postable` surfaces so slash commands can reply through channels.
3. Add optional `path: false` and `background` ingress support to
   `MessengerDefinition`.
4. Implement a Workers-native Discord Chat SDK adapter inside the Think Discord
   subpath, using the official adapter as the behavior reference but avoiding
   Node-only dependencies.
5. Implement Discord command registration helpers/examples for guild and global
   commands, including contexts, integration types, default member permissions,
   and safe update/bulk-overwrite behavior.
6. Implement Interactions support with Web Crypto signature verification,
   timestamp freshness checks, fast ACK/defer behavior, action mapping, command
   mapping, select mapping, callback-token component ids, and Discord delivery
   limits.
7. Implement `ThinkDiscordGatewayShardAgent`, Gateway shard state, reconnect,
   resume, heartbeats, alarms, session start limit handling, shard Identify
   bucket scheduling, and internal Gateway event forwarding.
8. Add Gateway dispatch normalization for DMs, mentions, reactions, subscribed
   channel/thread messages, and Gateway-delivered interactions.
9. Implement guild mention auto-threading, safe `allowed_mentions`, permission
   diagnostics, route/global rate-limit handling, and invalid request tracking.
10. Add tests for command registration payloads, command routing, action/select
    routing, reaction routing, Interaction verification, timestamp rejection,
    thread id encoding, auto-thread fallback, safe allowed mentions, card
    rendering, custom id length validation, Gateway dispatch idempotency, and
    recovery behavior.
11. Add user-facing docs and a Discord example that covers application setup,
    command registration, local tunnel testing, Interactions, Gateway activation,
    and permissions/intents troubleshooting.

## Future Capability Slices

The initial provider slice can land with signed Interactions, command/action
normalization, and short-lived interaction webhook delivery. The remaining
Discord surface should land as independent, reviewable slices in this order.

### Slice 1: Durable Channel Delivery

Goal: allow Think to post to Discord channels, threads, and DMs outside the
15-minute interaction token window.

Scope:

- Implement bot-token REST delivery for `postMessage()` to encoded Discord thread
  ids, including guild channels, Discord thread channels, and DMs.
- Implement `openDM(userId)` or an equivalent internal helper so application code
  can resolve `discord:@me:{channelId}` before posting.
- Preserve current interaction response behavior: interaction-originated replies
  still use the deferred original response first, then follow-up webhooks while
  the interaction token is valid.
- Fall back from expired/missing interaction response contexts to bot-token
  channel delivery when the adapter has a real Discord thread id.
- Centralize REST request handling so later edit/delete/fetch/attachment work can
  share auth headers, JSON parsing, error shaping, and rate-limit handling.

Tests:

- Posting to `discord:{guildId}:{channelId}` calls `POST /channels/{channelId}/messages`.
- Posting to `discord:{guildId}:{channelId}:{threadId}` targets the Discord
  thread id, not the parent channel id.
- Expired interaction contexts are deleted and do not reuse stale webhook tokens.
- `allowed_mentions: { parse: [] }` remains the default on every REST send.
- Permanent `401`/`403` responses surface actionable delivery errors without
  unsafe retries.

Non-goals:

- Gateway ingress.
- File uploads.
- Edit/delete/fetch parity beyond what channel delivery needs internally.

### Slice 2: Gateway Background Ingress

Goal: receive normal Discord messages, DMs, mentions, subscribed-thread messages,
and reactions without relying on slash commands.

Scope:

- Export `ThinkDiscordGatewayShardAgent` and wire `discordMessenger({ gateway })`
  to a `MessengerBackgroundIngress` manager.
- Resolve shard count and session-start limits from `/gateway/bot` when configured
  with `shards: "auto"`.
- Store shard session state in the shard Durable Object: shard id/count,
  `session_id`, `resume_gateway_url`, last sequence, heartbeat state, and
  identify backoff state.
- Implement Gateway connect, Hello, jittered heartbeat, heartbeat ACK timeout,
  dispatch sequence persistence, Ready, Resume, Reconnect, Invalid Session,
  close-code handling, and alarm-based reconnect.
- Forward accepted dispatches back to the root runtime through typed Agent/facet
  calls, then normalize them through Chat SDK `processMessage()`,
  `processReaction()`, `processAction()`, and `processSlashCommand()`.
- Drop self-authored messages before they reach Think routing.
- Warn when `respondTo` includes subscribed guild messages but Gateway intents do
  not include `MessageContent`.

Tests:

- Shard state persists sequence before dispatch normalization.
- Resume is attempted after resumable disconnects and Identify is used after
  invalid sessions that cannot resume.
- Fatal close codes stop reconnect loops and surface diagnostics.
- DM `MESSAGE_CREATE` routes to `direct-message`; guild mentions route to
  `mention`; subscribed messages route only when configured.
- Duplicate Gateway dispatches use stable idempotency keys and do not start
  duplicate reply fibers.

Non-goals:

- Command registration.
- Rich component rendering.
- Native WebSocket hibernation for outgoing Discord Gateway sockets.

### Slice 3: Command Registration Tooling

Goal: let users register Discord commands without hand-writing raw REST calls,
while keeping registration out of runtime request handling.

Scope:

- Provide a small helper or example script for guild command create/update/bulk
  overwrite and global command create/update/bulk overwrite.
- Support command names, descriptions, options, subcommands, default member
  permissions, `integration_types`, and `contexts`.
- Prefer update/bulk-overwrite workflows that avoid repeated create loops and
  respect Discord's daily create limits.
- Keep Bearer-token command permission flows out of the bot-token helper; document
  them as an advanced setup concern.
- Include a dry-run/print mode in the example so users can inspect payloads before
  sending them to Discord.

Tests:

- Payload generation enforces Discord command shape limits and required-before-
  optional option ordering.
- Guild and global registration hit the correct API routes.
- Bulk overwrite does not issue per-command create calls.
- `integration_types`, `contexts`, and `default_member_permissions` round-trip in
  generated payloads.

Non-goals:

- Developer Portal application creation.
- OAuth installation flows.
- Automatic registration during Worker startup or webhook handling.

### Slice 4: Attachments

Goal: expose inbound Discord attachments in messenger context and support outbound
file uploads when explicitly enabled.

Scope:

- Map Discord message attachments into `MessengerAttachment` with id, name,
  media type, size, URL, and lazy `fetch()`.
- Keep attachment bytes lazy so normal text-only turns do not fetch files.
- Add outbound multipart upload support for `AdapterPostableMessage` attachments
  and model/tool-produced file parts when the Think delivery path can represent
  them.
- Respect Discord file size limits and bot permissions before uploading.
- Preserve safe defaults: do not fetch arbitrary attachment URLs unless caller
  code asks through the attachment `fetch()` function.

Tests:

- Inbound Gateway messages with attachments produce serializable attachment
  metadata without eager byte loading.
- `fetch()` downloads bytes only when invoked and handles non-OK responses.
- Outbound file sends use multipart form data and include `allowed_mentions`.
- Missing `ATTACH_FILES` permission fails before repeated invalid REST calls.
- Oversized files fail with a clear error before upload.

Non-goals:

- Virus scanning or content moderation.
- Persisting attachment bytes in Think state by default.
- Provider-neutral binary delivery redesign beyond Discord's needs.

### Slice 5: Reactions, Edit/Delete, And Fetch APIs

Goal: complete the Discord adapter methods that Think tools and scheduled work
need after initial reply delivery works.

Scope:

- Implement `addReaction()` and `removeReaction()` using Discord emoji route
  encoding for unicode and custom emoji values.
- Implement `editMessage()` and `deleteMessage()` for bot-authored messages and
  interaction-originated original responses where the adapter still has a valid
  interaction context.
- Implement `fetchMessages()`, `fetchChannelMessages()`, `fetchThread()`,
  `fetchChannelInfo()`, and thread listing helpers needed by tools.
- Normalize fetched Discord messages into Chat SDK message/thread/channel shapes
  with stable encoded ids.
- Share REST rate-limit handling with the durable channel delivery slice.

Tests:

- Unicode and custom emoji reactions are encoded correctly in REST routes.
- Editing a normal channel message targets `/channels/{channelId}/messages/{id}`.
- Editing an interaction original response uses the webhook route only while the
  context is valid.
- Deleting and fetching inaccessible messages produce permanent errors without
  unsafe retry loops.
- Fetched Discord threads preserve `discord:{guildId}:{channelId}:{threadId}`
  identity.

Non-goals:

- Moderation actions beyond message delete.
- Full Discord audit-log integration.
- Cross-provider fetch API redesign.

### Slice 6: Ephemeral Replies And Rich Components

Goal: improve Discord-specific UX for command responses and cards without
claiming a provider-neutral ephemeral primitive.

Scope:

- Add `interactions.defaultVisibility: "public" | "ephemeral"` and set the
  initial defer response flags accordingly.
- Keep `supportsEphemeral` false unless a provider-neutral contract exists;
  ephemeral replies are interaction-originated Discord delivery options.
- Render Chat SDK cards to Discord embeds and action rows, respecting Discord
  limits for embeds, fields, rows, buttons, select menus, and component
  `custom_id` length.
- Use Chat SDK callback-token state for component `custom_id` values rather than
  embedding long callback URLs or payloads directly.
- Support link buttons as Discord URL buttons and reject unsupported component
  shapes with readable errors before posting.

Tests:

- Ephemeral command defer responses include Discord's ephemeral flag and still
  edit the original response for the first reply.
- Public command replies remain the default.
- Card rendering respects embed/action-row/component count limits.
- Long callback URLs are tokenized before they enter `custom_id`.
- Invalid component payloads fail before REST delivery, not after Discord rejects
  the request.

Non-goals:

- Discord modals as a model-turn primitive.
- General ephemeral posting to arbitrary channels.
- A complete Discord UI framework beyond Chat SDK card rendering.

## Alternatives Considered

### Interactions-only first

Rejected as the complete design. It is a useful slice, but it excludes DMs and
natural mention-based bots. Discord users expect bots to respond in channels and
DMs without requiring every turn to start as a slash command.

### Gateway-only first

Rejected. Slash commands and component interactions are core Discord bot UX, and
Interactions have a different security and delivery model. Excluding them would
make buttons and commands second-class.

### Separate cross-platform `packages/messengers`

Rejected. The current repo already has a Think-native messenger architecture
backed by Chat SDK. Discord should extend that path rather than restart the
older standalone package idea.

### Run Gateway sockets inside the root Think agent only

Rejected for the full design. It is simpler for a single-shard prototype, but it
mixes Gateway protocol state with Think conversation state and does not scale
cleanly to multiple shards. Provider-owned shard sub-agents keep the boundaries
clear.

### Depend directly on `@chat-adapter/discord`

Rejected for Workers. The package is the right semantic reference, but direct
reuse pulls in Node-only modules and `discord.js`. Think's Discord subpath needs
a Workers-native adapter that speaks the Chat SDK `Adapter` contract.

### Use a cron-overlap Gateway listener

Rejected for Workers. The official adapter's cron pattern is a pragmatic
serverless Node workaround. Durable Object shard agents provide a stronger
ownership model for Cloudflare: one coordination atom per Discord shard,
durable resume state, alarms for reconnect, and no public HTTP forwarding loop.

## Decisions Closed By Validation

- Command routing uses Chat SDK's existing slash command primitives and is
  documented in Think messenger docs only where Think adds messenger context and
  model-turn routing.
- Gateway startup is explicit. The root Think agent starts shards when it wakes;
  Gateway-only deployments configure a scheduled Worker trigger or authenticated
  application control-plane call to wake the root. The SDK should not add an
  unauthenticated built-in HTTP control route.
- Command registration remains outside runtime ingress. The SDK should provide a
  helper or example script for guild/global command registration, while docs
  show the minimum Discord Developer Portal setup and link to Discord's full
  registration docs rather than becoming an application setup framework.
