Status: proposed

# Agent channels

## The problem

`Agent` still presents WebSocket callbacks as its application interface:

```ts
class MyAgent extends Agent {
  onConnect(connection) {}
  onMessage(connection, frame) {}
  onClose(connection) {}
}
```

That boundary came from PartyServer. It no longer matches the runtime or the
product we want to build.

The Durable Object lifecycle owns physical requests, alarms, and hibernating
WebSockets. The base Agent then mixes several concerns into its WebSocket
callbacks:

- connection setup and sub-agent forwarding;
- Agent identity and state synchronization;
- callable RPC;
- MCP server announcements;
- application frames.

Slack, Telegram, Discord, email, and HTTP messages have separate entry points.
An application cannot implement its behavior once and reuse it across those
providers.

HTTP is overloaded too. `onRequest` can mean an application endpoint, but
features such as the MCP client also need HTTP callback URLs. The MCP callback
is not an application message. It should be claimed by an MCP lifecycle
capability before the user's raw request fallback.

## Terms

This RFC uses these terms:

- **Lifecycle**: coordinates Durable Object startup, requests, alarms, and
  hibernating WebSockets.
- **Capability**: a reusable lifecycle extension. A capability may claim a
  request such as an MCP OAuth callback.
- **Channel**: an Agent-owned inbound and outbound communication adapter. The
  browser WebSocket protocol, Slack, and a selected JSON message endpoint are
  channels.
- **Transport**: the mechanism carrying a channel, usually HTTP or WebSocket.
  HTTP itself is not a channel.
- **Gateway**: Worker-side channel ingress used when a shared provider webhook
  must resolve the target Agent before calling it.
- **Agent message**: the normalized application input produced by a channel.
- **Protocol extension**: behavior multiplexed over a channel, such as state
  synchronization or RPC over the browser WebSocket.

## Decision

Channels belong to the Agent. Provider implementations may live in separate
modules, but there is no second application host beside `Agent`.

A channel authenticates and decodes input, then calls one framework-owned Agent
receive path. That path handles admission, durable acceptance where required,
tracing, and invocation context before calling one application hook.

Raw WebSocket connection hooks belong to the WebSocket channel. We retain the
current Agent methods temporarily as compatibility callbacks.

`onRequest` remains a raw HTTP fallback. Lifecycle capabilities and request
channels may claim selected requests before it.

## Proposed user experience

The exact names are provisional. This PR does not export any of them.

```ts
import {
  Agent,
  routeAgentRequest,
  type AgentMessage,
  type AgentMessageContext
} from "agents";
import {
  requestChannel,
  slackChannel,
  webSocketChannel
} from "agents/channels";

export class SupportAgent extends Agent<Env> {
  readonly channels = this.defineChannels({
    web: webSocketChannel({
      onConnect({ connection }) {
        console.log("browser connected", connection.id);
      },
      decode({ frame }) {
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

    api: requestChannel({
      path: "/messages",
      async decode(request) {
        const input = await request.json<{
          id: string;
          text: string;
        }>();
        return input;
      }
    }),

    slack: slackChannel({
      webhookPath: "/slack",
      signingSecret: ({ env }) => env.SLACK_SIGNING_SECRET,
      botToken: ({ env }) => env.SLACK_BOT_TOKEN
    })
  });

  async onMessage(
    message: AgentMessage,
    context: AgentMessageContext
  ): Promise<void> {
    const answer = await this.answer(message.text);
    await context.reply({ markdown: answer });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
```

The ownership is the important part:

- the registry is declared on the Agent;
- WebSocket callbacks are configured on `webSocketChannel`;
- provider details stay in provider adapters;
- application messages reach one Agent callback;
- unknown HTTP requests reach `onRequest`, then 404.

The initial normalized contract should stay small:

```ts
type AgentMessage = {
  /** Stable within the source channel. */
  id: string;
  text: string;
  attachments?: readonly AgentMessageAttachment[];
};

type AgentMessageContext = {
  /** Stable key from the Agent's channel registry. */
  channel: string;
  actor?: AgentMessageActor;
  conversation?: {
    id: string;
    threadId?: string;
  };
  reply(message: AgentReply): Promise<AgentDeliveryResult>;
};
```

Provider payloads do not enter the application hook. An adapter may expose a
provider-specific routing callback in its own configuration, where the raw
payload type is known.

A reply target must be serializable so the Agent can persist it with accepted
work. Channel keys therefore become durable identifiers. Renaming one requires
a migration for stored reply targets.

## One application hook

The Agent should not grow `onSlackMessage`, `onTelegramMessage`, or
`onDiscordMessage`. That would preserve provider coupling and add a base-class
hook for every integration.

The target hook is `onMessage(message, context)`. It conflicts with the current
raw WebSocket signature. An additive release may use `onAgentMessage`
temporarily, but the API should converge on `onMessage` after raw frame handling
has moved into `webSocketChannel`.

Channels call an internal receive operation rather than invoking the override
directly:

```text
channel ingress
-> Agent receive operation
   -> parse normalized envelope
   -> deduplicate when the source can redeliver
   -> persist work and reply target when required
   -> establish tracing and channel context
   -> Agent.onMessage(message, context)
```

For webhook channels, provider acknowledgement means the target Agent has
accepted the event durably. It does not mean the model has finished. Long
processing must not hold a provider webhook open.

## The browser WebSocket channel

The first channel is the existing Agents browser protocol. It owns one physical
WebSocket and multiplexes its protocol extensions in a fixed order:

```text
Lifecycle
-> browser WebSocket channel
   -> sub-agent forwarding
   -> identity protocol
   -> state protocol
   -> RPC protocol
   -> MCP publication protocol
   -> higher chat protocol
   -> application frame decoder
```

State synchronization, RPC, identity, and MCP announcements are not separate
channels. They share one connection and compose inside its protocol dispatcher.
A binary voice socket could later be a different WebSocket channel with none of
those browser frames.

This PR performs only a private extraction:

- `packages/agents/src/internal/agent-websocket-channel.ts` owns connection
  setup, state sync, RPC dispatch, identity, MCP announcements, sub-agent
  forwarding, agent-tool replay, and unrecognized-frame forwarding;
- `packages/agents/src/internal/rpc.ts` owns callable RPC parsing and streaming
  response mechanics;
- neither module has a package export;
- existing `Agent.onConnect`, raw `Agent.onMessage`, and `Agent.onClose` remain
  compatibility callbacks;
- `AIChatAgent` and Think retain their current wrapper order.

The current connection form of `Agent.onError` still belongs to the lifecycle
compatibility path. It should move with the other connection hooks when the
public WebSocket channel API lands.

## Requests and capabilities

A request is not automatically a message. Request ownership remains explicit:

```text
Lifecycle startup
-> lifecycle capability request hooks
-> Agent request-channel adapters
-> Agent.onRequest
-> 404
```

Examples:

- an MCP OAuth callback is claimed by the MCP capability;
- a Slack webhook routed to an Agent is claimed by the Slack channel;
- `POST /messages` is normalized by a request channel;
- a health endpoint can remain in `onRequest` or its own capability;
- an unknown request returns 404.

The first returned `Response` wins. Every capability and channel must decline
requests outside its scope. Configuration should reject detectable path
conflicts during startup.

## Shared provider gateways

The simple provider URL contains the Agent class and name:

```text
/agents/support-agent/customer-123/slack
```

`routeAgentRequest` resolves the Durable Object first, then the Agent's Slack
channel verifies and handles the request.

Some providers instead call one webhook shared by many Agent instances. In
that case, a Worker-side gateway must authenticate and normalize the event
before the target Agent is known:

```text
provider webhook
-> channel gateway
-> resolve Agent name
-> Agent receive operation
-> durable acceptance
-> provider acknowledgement
```

The same adapter definition should support both roles:

```ts
const slack = slackChannel<Env>({
  webhookPath: "/slack",
  signingSecret: ({ env }) => env.SLACK_SIGNING_SECRET,
  botToken: ({ env }) => env.SLACK_BOT_TOKEN
});

export class SupportAgent extends Agent<Env> {
  readonly channels = this.defineChannels({ slack });

  async onMessage(message: AgentMessage, context: AgentMessageContext) {
    await context.reply({ markdown: await this.answer(message.text) });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentChannelRequest({
        request,
        env,
        namespace: env.SupportAgent,
        channel: slack,
        resolveAgent: (event) => event.workspaceId
      })) ??
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
```

The gateway is an inbound adapter, not a `ChannelHost`. It does not own
application callbacks, conversation state, an outbox, retries, or delivery
preferences. Its job ends at durable Agent acceptance.

## Lifecycle prerequisite for multiple WebSocket channels

The current lifecycle has one WebSocket host. It accepts every upgrade and
calls host methods on the Durable Object. The private browser-channel
extraction works because every Agent socket still has the same owner.

Before exposing a second WebSocket channel, the lifecycle needs named ownership:

```ts
interface DurableObjectCapability {
  webSocket?: {
    /** Stable key persisted with accepted sockets. */
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
}
```

The exact type is open. The required behavior is:

1. handlers claim upgrades in registration order;
2. the first accept or explicit response wins;
3. the lifecycle accepts the socket through the Hibernation API;
4. it stores the handler key in lifecycle-owned attachment metadata;
5. wakes dispatch only to that handler;
6. a missing handler is an ownership error, never fallthrough;
7. old sockets without a key use the current host fallback;
8. duplicate or renamed keys fail loudly.

The owner key must not live in `connection.state`, which belongs to channel and
application code.

The in-progress request-only MCP capability does not depend on this change. If
MCP publishes state over the browser socket, that publication should later
register as a browser protocol extension rather than become a second socket
owner.

## Compatibility and migration

1. Extract the browser protocol into an internal channel and retain current
   hooks as callbacks. This PR does that.
2. Add named WebSocket ownership to the lifecycle without changing Agent users.
3. Add the Agent channel registry and normalized receive path.
4. Move `AIChatAgent` and Think away from constructor-time method wrapping and
   into browser protocol registration.
5. Introduce the semantic message hook and deprecate raw Agent connection hooks.
6. Remove or rename raw hooks only at an allowed breaking boundary.

Compatibility must cover the browser client, React hooks, state sync, readonly
connections, protocol suppression, RPC, chat recovery, connection ordering, and
sub-agent routing.

## Relationship to existing channel work

Think already exports `ChannelDefinition`. It combines messenger configuration,
turn policy, tool narrowing, and delivery. This RFC defines a lower boundary:
transport normalization and reply delivery in base Agent, with turn policy and
recovery remaining in Think.

We should avoid publishing another unrelated type named simply `Channel`.
Explicit base names such as `AgentChannel`, `AgentMessage`, and
`AgentMessageContext` are safer until the layers converge.

PR #2129 contains useful pieces, especially normalized provider events,
serializable reply destinations, stable source IDs, and honest delivery
outcomes. Its `ChannelHost` creates a second application callback and routing
system beside Agent, and the PR also takes on identities, approvals, fallback,
fanout, AI tools, and several providers at once.

This proposal starts smaller:

1. private browser-channel extraction;
2. lifecycle ownership for multiple WebSocket channels;
3. one Agent message and reply boundary;
4. request channel and one external provider;
5. only then revisit identities, approvals, and composite delivery.

## Alternatives

- **Provider-specific Agent hooks.** Rejected because application logic stays
  tied to providers.
- **Standalone `ChannelHost` as the application owner.** Rejected because Agent
  would still need a second routing, callback, and durability model.
- **Every capability observes every frame.** Rejected because consumption,
  ordering, errors, and hibernation ownership become ambiguous.
- **State and RPC as channels.** Rejected because they are extensions of one
  browser connection.
- **Every HTTP request becomes a message.** Rejected because callbacks, health
  checks, assets, and arbitrary APIs have different semantics.
- **Every provider URL includes the Agent name.** Preferred where possible, but
  insufficient for a shared webhook serving many Agent instances.

## Open questions

- What temporary name should carry normalized messages while raw `onMessage`
  remains supported?
- How should one adapter definition bind Worker gateway configuration and Agent
  instance delivery without duplication?
- Which actor and conversation fields belong in base Agent rather than Think?
- What durable inbox should webhook channels use?
- How should protocol extensions register with the browser channel?
- Should the first external proof use Slack or Telegram?

## Decision status

Proposed. This PR makes the first private move by extracting the existing
browser protocol without exporting a channel API.
