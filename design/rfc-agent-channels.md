Status: proposed

# Lifecycle-composed channels

## The problem

`Agent` still presents WebSocket callbacks as its application interface:

```ts
class MyAgent extends Agent {
  onConnect(connection) {}
  onMessage(connection, frame) {}
  onClose(connection) {}
}
```

That shape came from PartyServer. It mixes several responsibilities:

- the Durable Object lifecycle accepts and hibernates the socket;
- the Agents browser protocol sends identity and synchronizes state;
- callable RPC shares the same wire;
- MCP and chat add more protocol frames;
- unrecognized frames reach application code.

Slack, Telegram, Discord, email, and HTTP messages enter through different
APIs. An application cannot implement its behavior once and reuse it across
those providers.

HTTP is overloaded too. An MCP OAuth callback and an application JSON message
both arrive as requests, but they are not the same kind of input. The MCP
capability should claim its callback before channels and before the
application's raw request fallback.

## Terms

- **Lifecycle** coordinates Durable Object startup, requests, alarms, and
  hibernating WebSockets.
- **Capability** is a reusable extension installed into a Lifecycle.
- **Channel definition** describes one communication adapter without binding it
  to a Durable Object instance. For shared ingress it also owns the application
  routing callback that chooses the complete durable target. A Worker router and
  a Durable Object runtime can share the same definition.
- **Channel runtime** binds definitions to a Durable Object, storage, scheduling,
  and an application message callback. It is a Lifecycle capability.
- **Channel router** is Worker-side ingress over a set of channel definitions.
  It is used when a shared provider webhook must resolve the target Durable
  Object before calling it.
- **Channel message** is the normalized application input produced by a channel.
- **Reply target** is serializable data identifying the exact channel
  destination derived from an inbound message.
- **WebSocket owner** is the one named Lifecycle handler responsible for a
  physical hibernating socket.
- **Protocol extension** is behavior multiplexed inside one WebSocket channel,
  such as state sync or RPC.

# Ideal end state

## Architecture

Channels belong to the durable application, not specifically to `Agent`.
`Agent` provides defaults and a shorter configuration API over the same runtime.

```text
Worker
├─ shared channel router, only when the target is not in the URL
└─ ordinary Durable Object routing

DurableObject
├─ Lifecycle
│  ├─ MCP capability
│  ├─ Channels capability
│  ├─ schedules capability
│  └─ raw host fallback
├─ durable application state
└─ one normalized channel-message handler

Agent extends DurableObject
├─ installs the same Lifecycle and Channels capability
├─ preconfigures the Agents browser channel
├─ supplies state, RPC, observability, and sub-agent protocol extensions
└─ exposes defineChannels() and onMessage() as convenience
```

The core dependency direction is:

```text
Lifecycle knows WebSocket owners and capability phases
    ↑
Channel runtime knows channel definitions and normalized messages
    ↑
Agent adds Agent-specific protocols and convenience
    ↑
Think adds turns, model policy, streaming recovery, and notices
```

`Lifecycle` does not know what a message, actor, Slack workspace, or model turn
is. A provider adapter does not own application state. `Agent` is not required
for channels to work.

## End-state contracts

The exact names remain open, but the final concepts should resemble this:

```ts
type ChannelMessage = {
  /** Stable within the configured source channel. */
  id: string;
  text: string;
  attachments?: readonly ChannelAttachment[];
};

type ChannelMessageContext = {
  /** Stable configured key. This may be persisted with application data. */
  channel: string;
  actor?: ChannelActor;
  conversation?: {
    id: string;
    threadId?: string;
  };
  replyTarget: ChannelReplyTarget;
  reply(message: ChannelReply): Promise<ChannelDeliveryResult>;
};

type ChannelDeliveryResult =
  | { status: "delivered"; reference?: string }
  | { status: "failed"; retryable: boolean; error: ChannelError }
  | { status: "uncertain"; error: ChannelError };
```

Provider payloads do not enter the application handler. Adapters may expose
provider-specific routing callbacks in their configuration, where the raw type
is known.

One outbound `reply()` call performs one provider attempt. The runtime does not
silently retry an uncertain delivery because that can duplicate a real message.

Definitions are reusable and grouped into one configured set. The set handles
more than one provider request path and retains each stable channel key:

```ts
const externalChannels = defineChannelSet<Env>({
  slack: slackChannel({
    webhookPath: "/webhooks/slack",
    signingSecret: ({ env }) => env.SLACK_SIGNING_SECRET,
    botToken: ({ env }) => env.SLACK_BOT_TOKEN,
    route({ event, env }) {
      return env.SupportAgent.getByName(event.workspaceId);
    }
  }),

  telegram: telegramChannel({
    webhookPath: "/webhooks/telegram",
    secretToken: ({ env }) => env.TELEGRAM_WEBHOOK_SECRET,
    botToken: ({ env }) => env.TELEGRAM_BOT_TOKEN,
    route({ event, env }) {
      return env.SupportAgent.getByName(`telegram:${event.chatId}`);
    }
  })
});
```

`externalChannels.routeRequest(request, env)` offers the request to each
HTTP-ingress definition. A channel returns `undefined` when the path does not
belong to it. Once a channel claims and authenticates the request, its `route`
callback chooses the complete Durable Object target.

Returning the target keeps one routing decision together:

```ts
route({ event, env }) {
  return env.SupportAgent.getByName(event.workspaceId);
}
```

The alternative splits that decision across `namespace`, `resolveName`, and the
router's own call to `getByName`. That makes the framework own application
naming and prevents a channel from selecting another Durable Object class,
jurisdiction, location hint, or existing stub. The router needs only a target
with `fetch(request): Promise<Response>`.

A route may return `null` to deliberately ignore an authenticated event. It must
not return `undefined`, which is reserved for a channel declining an HTTP
request before authentication and normalization.

A runtime binds the same definitions to a durable host:

```ts
const channels = createChannelRuntime({
  storage,
  scheduler,
  env,
  channels: externalChannels.definitions,
  onMessage
});
```

The configured keys `slack` and `telegram` are durable data. Renaming one
requires a migration for persisted inbox records and reply targets.

## End state in an Agent

`Agent` is the simple path. It already owns storage, Lifecycle, invocation
context, observability, and the browser protocol.

```ts
import {
  Agent,
  callable,
  routeAgentRequest,
  type StreamingResponse
} from "agents";
import {
  agentBrowserChannel,
  defineChannelSet,
  requestChannel,
  slackChannel,
  telegramChannel,
  type ChannelMessage,
  type ChannelMessageContext
} from "agents/channels";

interface Env {
  SupportAgent: DurableObjectNamespace<SupportAgent>;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

type SupportState = {
  handled: number;
  lastChannel?: string;
};

const externalChannels = defineChannelSet<Env>({
  slack: slackChannel({
    webhookPath: "/webhooks/slack",
    signingSecret: ({ env }) => env.SLACK_SIGNING_SECRET,
    botToken: ({ env }) => env.SLACK_BOT_TOKEN,
    route({ event, env }) {
      return env.SupportAgent.getByName(event.workspaceId);
    }
  }),

  telegram: telegramChannel({
    webhookPath: "/webhooks/telegram",
    secretToken: ({ env }) => env.TELEGRAM_WEBHOOK_SECRET,
    botToken: ({ env }) => env.TELEGRAM_BOT_TOKEN,
    route({ event, env }) {
      return env.SupportAgent.getByName(`telegram:${event.chatId}`);
    }
  })
});

export class SupportAgent extends Agent<Env, SupportState> {
  initialState: SupportState = { handled: 0 };

  readonly channels = this.defineChannels({
    // This channel includes the Agent identity, state, RPC, MCP publication,
    // sub-agent, and chat protocol extensions.
    web: agentBrowserChannel({
      onConnect({ connection }) {
        console.log("browser connected", connection.id);
      },
      decodeApplicationFrame({ frame }) {
        if (typeof frame !== "string") return null;
        return {
          id: crypto.randomUUID(),
          text: frame
        };
      },
      onClose({ connection }) {
        console.log("browser disconnected", connection.id);
      }
    }),

    // Only this path is translated into a message. Other requests continue.
    api: requestChannel({
      path: "/messages",
      async decode(request) {
        return request.json<{ id: string; text: string }>();
      }
    }),

    ...externalChannels.definitions
  });

  async onMessage(
    message: ChannelMessage,
    context: ChannelMessageContext
  ): Promise<void> {
    this.setState({
      handled: this.state.handled + 1,
      lastChannel: context.channel
    });

    const answer = await this.answer({
      text: message.text,
      channel: context.channel,
      conversationId: context.conversation?.id
    });

    await context.reply({ markdown: answer });
  }

  // RPC remains a protocol extension of the Agent browser channel.
  @callable({ streaming: true })
  async streamStatus(stream: StreamingResponse): Promise<void> {
    stream.send({ phase: "working" });
    stream.end({ phase: "ready", handled: this.state.handled });
  }

  // This runs only when no capability or channel claimed the request.
  onRequest(request: Request): Response {
    if (new URL(request.url).pathname.endsWith("/health")) {
      return Response.json({ ok: true, handled: this.state.handled });
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One router handles every gateway-capable definition. Each channel owns
    // its provider-specific route to the complete Durable Object target.
    return (
      (await externalChannels.routeRequest(request, env)) ??
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
```

`defineChannels()` is convenience over the generic runtime. It installs the
runtime into the Agent's Lifecycle and binds the normalized callback to
`Agent.onMessage()`.

The flow is:

```text
browser / API / Slack
-> channel adapter
-> durable channel admission
-> Agent.onMessage(message, context)
-> context.reply(...)
-> originating reply target
```

## End state in a plain Durable Object

The reusable foundation uses the same definitions without extending `Agent`.
The application supplies an explicit callback, so `Lifecycle` remains free of
messaging concepts.

```ts
import { DurableObject } from "cloudflare:workers";
import { Lifecycle, routeDurableObjectRequest } from "agents/lifecycle";
import {
  createChannelRuntime,
  defineChannelSet,
  requestChannel,
  slackChannel,
  telegramChannel,
  webSocketChannel,
  type ChannelMessage,
  type ChannelMessageContext
} from "agents/channels";

interface Env {
  SupportConversation: DurableObjectNamespace<SupportConversation>;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
}

const externalChannels = defineChannelSet<Env>({
  slack: slackChannel({
    webhookPath: "/webhooks/slack",
    signingSecret: ({ env }) => env.SLACK_SIGNING_SECRET,
    botToken: ({ env }) => env.SLACK_BOT_TOKEN,
    route({ event, env }) {
      return env.SupportConversation.getByName(event.workspaceId);
    }
  }),

  telegram: telegramChannel({
    webhookPath: "/webhooks/telegram",
    secretToken: ({ env }) => env.TELEGRAM_WEBHOOK_SECRET,
    botToken: ({ env }) => env.TELEGRAM_BOT_TOKEN,
    route({ event, env }) {
      return env.SupportConversation.getByName(`telegram:${event.chatId}`);
    }
  })
});

export class SupportConversation extends DurableObject<Env> {
  private readonly channels = createChannelRuntime({
    storage: this.ctx.storage,
    env: this.env,

    channels: {
      web: webSocketChannel({
        path: "/socket",
        decode({ frame }) {
          if (typeof frame !== "string") return null;
          return {
            id: crypto.randomUUID(),
            text: frame
          };
        }
      }),

      api: requestChannel({
        path: "/messages",
        async decode(request) {
          return request.json<{ id: string; text: string }>();
        }
      }),

      ...externalChannels.definitions
    },

    onMessage: (message, context) => this.handleMessage(message, context)
  });

  readonly lifecycle = Lifecycle.install(this).use(this.channels);

  onStart(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        channel TEXT NOT NULL,
        message_id TEXT NOT NULL,
        text TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (channel, message_id)
      )
    `);
  }

  private async handleMessage(
    message: ChannelMessage,
    context: ChannelMessageContext
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO messages
       (channel, message_id, text, received_at)
       VALUES (?, ?, ?, ?)`,
      context.channel,
      message.id,
      message.text,
      Date.now()
    );

    const rows = [
      ...this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM messages"
      )
    ];

    await context.reply({
      markdown: `Stored message ${rows[0]?.count ?? 0}: ${message.text}`
    });
  }

  // Raw fallback after lifecycle capabilities decline.
  onRequest(request: Request): Response {
    if (new URL(request.url).pathname.endsWith("/health")) {
      return new Response("ok");
    }
    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await externalChannels.routeRequest(request, env)) ??
      (await routeDurableObjectRequest(request, env, {
        prefix: "conversations"
      })) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
```

The call path is:

```text
routeDurableObjectRequest or provider gateway
-> Durable Object stub.fetch(...)
-> Lifecycle startup
-> earlier request capabilities, such as MCP OAuth
-> Channels capability
-> handleMessage(message, context)
-> raw Durable Object onRequest when unclaimed
```

## Request ownership in the end state

A request is not automatically a message:

```text
Lifecycle startup
-> capability onRequest hooks in registration order
   -> MCP OAuth callback may return Response
   -> Channels may return Response
-> host onRequest
-> 404 chosen by host
```

Examples:

- MCP OAuth callback: MCP capability.
- Slack webhook routed directly to an instance: Slack channel.
- `POST /messages`: request channel.
- Health endpoint: host `onRequest` or a health capability.
- Unknown request: 404.

The first returned `Response` wins. Capabilities and channels decline requests
outside their scope. Startup should reject path conflicts it can detect.

## WebSocket ownership in the end state

A physical socket has exactly one durable owner. Lifecycle owns acceptance and
hibernation. The channel owns protocol semantics.

```text
Lifecycle WebSocket owner "channels:web"
└─ browser channel
   ├─ sub-agent forwarding protocol
   ├─ identity protocol
   ├─ state protocol
   ├─ RPC protocol
   ├─ MCP publication protocol
   ├─ Think or AIChat protocol
   └─ application frame decoder
```

A voice channel can claim another path and receive none of the browser
protocols. Lifecycle never broadcasts one frame to every capability.

The owner key belongs in Lifecycle attachment metadata, not
`connection.state`. User and channel code must not be able to change ownership.

## Durable ingress and acknowledgement

A shared provider webhook must not wait for model completion, but it must not be
acknowledged before the target Durable Object accepts it durably.

The channel runtime owns a narrow normalized inbox for this handoff:

```text
Channel router receives provider event
-> adapter authenticates and normalizes
-> adapter computes stable dispatchId and serializable replyTarget
-> router forwards an internal channel envelope to target.fetch(...)
-> target ChannelRuntime transactionally inserts inbox row
-> target schedules inbox drain
-> target returns accepted
-> router acknowledges provider
-> target invokes application handler separately
```

This inbox is not the application's conversation store, delivery preference
store, or outbound retry system. It records only accepted normalized ingress
that must survive eviction and provider redelivery.

Pseudocode:

```ts
type ChannelEnvelope = {
  channel: string;
  dispatchId: string;
  message: ChannelMessage;
  context: {
    actor?: ChannelActor;
    conversation?: ChannelConversation;
    replyTarget: ChannelReplyTarget;
  };
};

async function accept(envelope: ChannelEnvelope): Promise<AcceptResult> {
  return storage.transactionSync(() => {
    const existing = inbox.get(envelope.channel, envelope.dispatchId);
    if (existing) return { status: "duplicate" };

    inbox.insert({
      ...envelope,
      state: "pending",
      acceptedAt: Date.now()
    });

    scheduler.requestRun("channels:drain");
    return { status: "accepted" };
  });
}
```

WebSocket and explicit request-response channels may use inline handling when
their acknowledgement is the application response. Provider webhook channels
use durable admission by default.

# How we get there

## Phase 0: extract the current browser protocol

Status: included privately in this PR.

Today `Agent` wraps its own methods in the constructor. The first step moves
that behavior behind one internal object while preserving every public hook:

```ts
const userHooks = {
  onConnect: this.onConnect.bind(this),
  onMessage: this.onMessage.bind(this),
  onClose: this.onClose.bind(this)
};

this.#webSocketChannel = new AgentWebSocketChannel(
  agentProtocolPorts(this),
  userHooks
);

this.onConnect = this.#webSocketChannel.onConnect.bind(this.#webSocketChannel);
this.onMessage = this.#webSocketChannel.onMessage.bind(this.#webSocketChannel);
this.onClose = this.#webSocketChannel.onClose.bind(this.#webSocketChannel);
```

The internal channel owns state and RPC frame classification. Unknown frames
still reach the captured `Agent.onMessage(connection, frame)` callback.
`AIChatAgent` and Think continue wrapping the same methods outside this layer.

Exit criteria:

- no new package export;
- generated declarations contain no channel internals;
- browser identity, state, RPC, readonly, protocol suppression, ordering, and
  sub-agent tests remain unchanged;
- AIChat and Think suites remain unchanged.

## Phase 1: add named WebSocket ownership to Lifecycle

The current Lifecycle assumes one host callback. Add an internal owner
registry, then expose it only after the behavior is proven.

Proposed shape:

```ts
type LifecycleWebSocketOwner = {
  /** Stable key persisted in the socket attachment. */
  key: string;
  onUpgrade(
    context: WebSocketUpgradeContext
  ):
    | { type: "accept"; tags?: readonly string[] }
    | { type: "respond"; response: Response }
    | undefined
    | Promise<
        | { type: "accept"; tags?: readonly string[] }
        | { type: "respond"; response: Response }
        | undefined
      >;
  onConnect?(context: WebSocketConnectContext): MaybePromise<void>;
  onMessage?(context: WebSocketMessageContext): MaybePromise<void>;
  onClose?(context: WebSocketCloseContext): MaybePromise<void>;
  onError?(context: WebSocketErrorContext): MaybePromise<void>;
};

interface DurableObjectCapability {
  webSockets?: readonly LifecycleWebSocketOwner[];
}
```

Upgrade dispatch:

```ts
async function fetch(request: Request): Promise<Response> {
  await start();

  if (!isWebSocketUpgrade(request)) {
    return dispatchRequest(request);
  }

  for (const owner of webSocketOwners) {
    const decision = await owner.onUpgrade({ request });
    if (decision === undefined) continue;
    if (decision.type === "respond") return decision.response;

    const connection = acceptHibernatingWebSocket({
      request,
      tags: decision.tags,
      owner: owner.key
    });
    await owner.onConnect?.({ connection, request });
    return switchingProtocols(connection);
  }

  return hostWebSocketFallback(request);
}
```

Attachment metadata changes from:

```ts
{
  (id, tags, uri);
}
```

to:

```ts
{ id, tags, uri, owner: "channels:web" }
```

Wake dispatch:

```ts
async function webSocketMessage(socket, frame) {
  const metadata = readLifecycleAttachment(socket);

  if (metadata.owner === undefined) {
    return host.onMessage?.(connection(socket), frame);
  }

  const owner = ownersByKey.get(metadata.owner);
  if (!owner) {
    socket.close(1011, "WebSocket owner is no longer configured");
    reportMissingOwner(metadata.owner);
    return;
  }

  await owner.onMessage?.({ connection: connection(socket), frame });
}
```

Rules:

1. first claim wins;
2. duplicate owner keys fail during setup;
3. a missing owner never falls through to another owner;
4. owner keys are durable identifiers;
5. old sockets without an owner retain current behavior;
6. Lifecycle remains the only code calling `acceptWebSocket`.

## Phase 2: replace method wrapping with browser protocol composition

Define a protocol contract inside the WebSocket channel. Protocols consume a
frame in order or pass it onward.

```ts
type WebSocketProtocol = {
  onConnect?(context: ProtocolConnectContext): MaybePromise<void>;
  onFrame?(context: ProtocolFrameContext): MaybePromise<"handled" | "next">;
  onClose?(context: ProtocolCloseContext): MaybePromise<void>;
  onError?(context: ProtocolErrorContext): MaybePromise<void>;
};

function webSocketChannel(options: {
  path: string;
  protocols?: readonly WebSocketProtocol[];
  decode?: ApplicationFrameDecoder;
  onConnect?: ConnectionHook;
  onClose?: CloseHook;
}): ChannelDefinition;
```

Agent composes its browser channel:

```ts
function createAgentBrowserChannel(agent: Agent) {
  return webSocketChannel({
    path: "/",
    protocols: [
      subAgentProtocol(agent),
      identityProtocol(agent),
      stateProtocol(agent),
      rpcProtocol(agent),
      mcpPublicationProtocol(agent.mcp),
      ...agent.chatProtocols()
    ],
    decode: agent.applicationFrameDecoder
  });
}
```

Frame dispatch:

```ts
for (const protocol of protocols) {
  if ((await protocol.onFrame?.(context)) === "handled") return;
}

const message = await decode?.(context);
if (message) await channelRuntime.receive(message, context.replyTarget);
```

At this point `AIChatAgent` and Think register protocols instead of assigning to
`this.onConnect` and `this.onMessage` in their constructors.

The MCP request capability and MCP browser publication remain separate roles:

```text
MCP capability onRequest -> OAuth callback ownership
MCP browser protocol     -> server-list publication on Agent browser sockets
```

## Phase 3: introduce internal channel definitions and runtime

Start package-private. Prove the generic Durable Object composition before
adding `agents/channels` to package exports.

```ts
type ChannelTarget = {
  fetch(request: Request): Promise<Response>;
};

interface ChannelDefinition<Env, RoutingEvent = unknown, Raw = unknown> {
  gateway?: {
    receive(
      request: Request,
      context: { env: Env }
    ): Promise<ChannelGatewayResult<RoutingEvent, Raw> | undefined>;
    route(context: {
      event: RoutingEvent;
      raw: Raw;
      env: Env;
    }): MaybePromise<ChannelTarget | null>;
  };
  request?: ChannelRequestIngress<Env>;
  email?: ChannelEmailIngress<Env>;
  webSockets?: readonly ChannelWebSocketIngress<Env>[];
  deliver(
    target: ChannelReplyTarget,
    message: ChannelReply
  ): Promise<ChannelDeliveryResult>;
}

class ChannelRuntime<Env> implements DurableObjectCapability {
  constructor(options: {
    storage: DurableObjectStorage;
    scheduler: DurableScheduler;
    env: Env;
    channels: Record<string, ChannelDefinition<Env>>;
    onMessage: ChannelMessageHandler;
  });

  onStart(): void;
  onRequest(context: CapabilityRequestContext): Promise<Response | undefined>;
  onAlarm(): Promise<void>;
  readonly webSockets: readonly LifecycleWebSocketOwner[];
  accept(envelope: ChannelEnvelope): Promise<AcceptResult>;
}
```

The configured set stamps channel keys onto normalized reply targets and gateway
envelopes. A definition never needs to know the key under which an application
installed it.

Request dispatch pseudocode:

```ts
async onRequest({ request }): Promise<Response | undefined> {
  if (isInternalGatewayEnvelope(request)) {
    const envelope = await parseAndVerifyInternalEnvelope(request);
    return Response.json(await this.accept(envelope), { status: 202 });
  }

  for (const [key, channel] of configuredChannels) {
    const result = await channel.request?.receive(request);
    if (result === undefined) continue;

    const envelope = stampChannelKey(key, result.envelope);
    if (result.mode === "durable") {
      await this.accept(envelope);
    } else {
      await this.dispatchInline(envelope);
    }
    return result.response;
  }
}
```

## Phase 4: add durable inbox draining

The runtime stores only normalized ingress needed for durable acknowledgement.
The application owns conversation state and outbound policy.

```ts
type InboxRow = {
  channel: string;
  dispatchId: string;
  envelopeJson: string;
  state: "pending" | "running" | "completed";
  acceptedAt: number;
  leaseUntil: number | null;
};
```

Drain pseudocode:

```ts
async function drainInbox(): Promise<void> {
  for (const row of inbox.claimPending({ leaseMs: 60_000 })) {
    const envelope = parseEnvelope(row.envelopeJson);

    try {
      await onMessage(envelope.message, makeContext(envelope));
      inbox.complete(row.channel, row.dispatchId);
    } catch (error) {
      inbox.releaseOrFail(row, classifyChannelHandlerError(error));
    }
  }

  if (inbox.hasPending()) {
    scheduler.requestRun("channels:drain");
  }
}
```

The runtime deduplicates stable `(channel, dispatchId)` pairs. It does not claim
exactly-once application side effects. Application handlers that perform
external mutations still need their own idempotency key.

## Phase 5: add request channels and one provider

First prove two transports entering the same handler:

```ts
channels: {
  web: webSocketChannel(...),
  api: requestChannel(...)
}
```

Then add one real provider, Slack or Telegram:

```ts
channels: {
  web: webSocketChannel(...),
  api: requestChannel(...),
  slack: slackChannel(...)
}
```

Do not add identity linking, approvals, fallback, fanout, AI tools, or automatic
outbound retries in this phase. Those features should be evaluated against the
working Agent and plain Durable Object consumers.

## Phase 6: add the Worker channel router

One configured set handles any number of gateway-capable channels:

```ts
const externalChannels = defineChannelSet({
  slack: slackChannel(...),
  telegram: telegramChannel(...),
  discord: discordChannel(...)
});

const response = await externalChannels.routeRequest(request, env);
```

The set checks channels in declaration order. A channel first decides whether it
owns the HTTP request. Once it claims the request, no later channel sees it. The
claiming channel either returns its provider-specific authentication error or
normalizes provider events. Its own `route` callback then chooses the complete
durable target for each event.

```ts
async function routeRequest(request, env) {
  for (const [channelKey, channel] of configuredChannels) {
    const received = await channel.receiveGateway(request, { env });
    if (received === undefined) continue;

    for (const item of received.events) {
      const target = await channel.route({
        event: item.routing,
        raw: item.raw,
        env
      });

      if (target === null) continue;

      const response = await target.fetch(
        makeInternalChannelRequest({
          channelKey,
          envelope: item.envelope
        })
      );

      if (!response.ok) return received.retryResponse();
    }

    return received.acknowledge();
  }

  return undefined;
}
```

`route` returns a stub rather than a name:

```ts
route({ event, env }) {
  return env.SupportAgent.getByName(event.workspaceId);
}
```

This lets application policy choose the Durable Object class and any namespace
options in one place. The router neither knows nor reconstructs application
identity. The structural requirement is only:

```ts
type ChannelTarget = {
  fetch(request: Request): Promise<Response>;
};
```

A provider request may contain several events. Each event may route to a
different target. The router acknowledges the provider only after every
non-ignored event has been durably accepted.

Use `target.fetch`, not arbitrary RPC, so Lifecycle startup and capability
ordering remain automatic. The internal envelope must be authenticated or
impossible to forge from the public internet.

## Phase 7: add Agent convenience and migrate the hook

`Agent.defineChannels()` constructs and installs the generic runtime:

```ts
protected defineChannels(definitions) {
  const runtime = createChannelRuntime({
    storage: this.ctx.storage,
    scheduler: this.schedules,
    env: this.env,
    channels: {
      web: createAgentBrowserChannel(this),
      ...definitions
    },
    onMessage: (message, context) =>
      this.onAgentMessage(message, context)
  });

  this.lifecycle.use(runtime);
  return runtime;
}
```

Use a temporary semantic hook while raw `onMessage(connection, frame)` exists:

```ts
async onAgentMessage(
  message: ChannelMessage,
  context: ChannelMessageContext
): Promise<void> {}
```

Migration:

```text
release N
  add onAgentMessage(message, context)
  keep raw onMessage(connection, frame)
  move docs to channel configuration

breaking release
  rename raw hook to onWebSocketFrame or remove it
  rename onAgentMessage to onMessage
  keep raw hooks only inside webSocketChannel options
```

The ideal final Agent has one semantic `onMessage(message, context)` method.
Connection events live only in the configured WebSocket channel.

## Phase 8: converge Think channels

Think currently owns channel policy above a special-cased transport layer. It
should consume base Channel messages rather than define another unrelated
transport system.

```text
base ChannelRuntime receives message
-> Think resolves channel policy
-> Think admits durable turn
-> Think runs model and recovery
-> Think calls base context.reply
```

Think continues owning:

- model instructions and tool narrowing;
- turn admission and concurrency;
- streaming and recovery;
- notices and reply attachments.

Base channels continue owning:

- provider authentication and normalization;
- durable ingress acceptance;
- reply targets and delivery attempts;
- WebSocket connection ownership.

## Phase 9: publish only after the seams hold

Add `agents/channels` only after:

- one Agent and one plain Durable Object use the same runtime;
- browser, request, and one external provider reach the same handler;
- hibernation restores the correct WebSocket owner;
- the shared channel router acknowledges only after durable acceptance;
- existing Agent, AIChat, Think, React, RPC, state, readonly, and sub-agent tests
  remain green;
- generated declarations expose no implementation host interfaces.

# Relationship to current work

## This PR

This PR implements Phase 0 only. It also records the proposed end state and
migration. It exports no channel API.

## MCP capability work

The request-only MCP capability can proceed independently using the existing
ordered `onRequest` phase. Later, MCP publication becomes a protocol extension
inside the Agent browser channel. MCP does not become a WebSocket owner.

## PR #2129

PR #2129 contains useful ideas:

- normalized provider events;
- serializable reply destinations;
- stable source IDs;
- delivery results that admit uncertainty.

This RFC does not adopt a standalone `ChannelHost` as the application owner.
The durable application owns a `ChannelRuntime` capability beside its other
capabilities. Identity linking, approvals, fallback, fanout, AI tools, and
multiple providers are deferred until this smaller boundary works.

# Alternatives

- **Provider-specific Agent hooks.** Rejected because application logic remains
  tied to providers.
- **A standalone application `ChannelHost`.** Rejected because Agent and plain
  Durable Objects would gain a second routing, callback, and durability model.
- **Every capability observes every WebSocket frame.** Rejected because
  consumption, ordering, error ownership, and hibernation routing become
  ambiguous.
- **State and RPC are channels.** Rejected because they are protocols carried by
  one browser connection.
- **Every HTTP request is a message.** Rejected because callbacks, health checks,
  assets, and arbitrary APIs have different semantics.
- **Every provider URL contains the Durable Object name.** Preferred where
  possible, but insufficient for shared webhooks.
- **Durability inside every adapter.** Rejected because providers would expose
  inconsistent guarantees and duplicate runtime storage logic.

# Open questions

- Should the temporary semantic hook be `onAgentMessage`, `onChannelMessage`, or
  another name?
- What scheduler port should the runtime use before schedules are fully
  extracted from Agent?
- Which actor and conversation fields belong in the base normalized contract?
- Which ingress types may opt into inline rather than durable handling?
- How should internal router envelopes be authenticated?
- Should the first provider proof use Slack or Telegram?
- When should the existing Think `ChannelDefinition` converge with this base
  contract?

# Decision status

Proposed. The ideal architecture is a Lifecycle-composed `ChannelRuntime` usable
from any Durable Object, with `Agent` providing the preconfigured browser
protocol and a simpler API. This PR makes the first private move by extracting
the current Agent browser protocol without exporting channel symbols.
