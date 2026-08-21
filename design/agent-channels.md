# Agent channels

Agent channels are the boundary between communication protocols and Agent
application behavior. The public channel API is still proposed. The base Agents
SDK now has one internal channel: the browser WebSocket channel.

## Current implementation

A browser connection still enters through the Durable Object lifecycle:

```text
routeAgentRequest
-> Agent.fetch
-> Lifecycle.fetch
-> hibernating WebSocket acceptance
-> Agent browser WebSocket channel
```

The internal browser channel owns the Agents WebSocket protocol:

- connection setup and protocol suppression;
- Agent identity delivery;
- initial state delivery and later state broadcasts;
- client state updates and readonly rejection;
- callable RPC, including streaming responses;
- MCP server announcements;
- agent-tool replay on connect;
- sub-agent WebSocket forwarding;
- connect and disconnect observability;
- forwarding unrecognized frames to the compatibility hook.

The implementation lives in
`packages/agents/src/internal/agent-websocket-channel.ts`. RPC parsing and
streaming response mechanics live in `packages/agents/src/internal/rpc.ts`.
Neither file is a package entry point. The extraction adds no channel API or
import path.

## Compatibility hooks

`Agent.onConnect`, `Agent.onMessage(connection, frame)`, and `Agent.onClose`
remain public for compatibility. The Agent constructor captures the subclass
implementations, creates the internal browser channel, then installs channel
methods as the lifecycle callbacks. Once the channel has handled its own
protocol work, it invokes the captured callback.

This preserves the existing wrapper order used by `AIChatAgent` and Think:

```text
Lifecycle WebSocket callback
-> AIChatAgent or Think protocol wrapper
-> base Agent browser channel
-> user compatibility callback
```

A later public channel API can move these callbacks into
`webSocketChannel({ onConnect, onMessage, onClose })`. That migration must not
happen until the higher chat layers register their protocol behavior without
rewriting Agent methods in their constructors.

## Lifecycle ownership

The current lifecycle has one WebSocket host. It accepts every upgrade and
calls the host's `onConnect`, `onMessage`, `onClose`, and `onError` methods. The
internal extraction works within that constraint because every Agent socket
still belongs to the built-in browser channel.

Multiple WebSocket channels need a stronger lifecycle contract. The lifecycle
must let a named handler claim an upgrade, persist the handler key in its private
WebSocket attachment, and route hibernation wakes back to that handler. It must
not broadcast frames to all capabilities.

Until that exists, the internal browser channel is the only physical WebSocket
owner. State synchronization, RPC, identity, MCP announcements, and chat are
protocol extensions carried by that channel rather than competing channel
owners.

## Proposed user model

The proposed API is recorded in
[`rfc-agent-channels.md`](./rfc-agent-channels.md). The intended direction is an
Agent-owned registry and one transport-neutral application entry point:

```ts
export class SupportAgent extends Agent<Env> {
  readonly channels = this.defineChannels({
    web: webSocketChannel({
      onConnect({ connection }) {
        console.log("connected", connection.id);
      }
    }),
    api: requestChannel({ path: "/messages" }),
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
    await context.reply({ markdown: await this.answer(message.text) });
  }
}
```

These symbols are not exported today. The code records ownership and call flow,
not a committed signature.

## Key decisions

- The Agent owns its channel registry. Provider implementations may be separate
  modules, but there is no second application host beside Agent.
- Raw connection callbacks belong to the WebSocket channel. They are retained on
  Agent only as compatibility hooks.
- The lifecycle owns physical hibernating WebSockets. A channel never accepts a
  socket behind the lifecycle's back.
- One physical socket has one channel owner. Features multiplexed over that
  socket compose inside its protocol dispatcher.
- `onRequest` remains a raw HTTP fallback. Lifecycle capabilities such as MCP
  may claim feature callback URLs before it, and request channels may normalize
  selected requests into Agent messages.

## Tradeoffs

The internal channel currently receives a narrow callback object backed by
Agent operations. This is more wiring than letting it reach into Agent directly,
but it keeps the protocol module independent from Agent's large implementation
and makes its dependencies visible.

Compatibility means the raw WebSocket methods cannot disappear yet. Think and
AIChatAgent both decorate them at runtime, and applications override them. The
private extraction improves ownership without pretending the migration is
complete.

## History

- [rfc-durable-object-lifecycle.md](./rfc-durable-object-lifecycle.md) introduced
  the composed lifecycle and removed the PartyServer base class.
- [rfc-agent-channels.md](./rfc-agent-channels.md) proposes the public Agent
  channel and normalized message model.
