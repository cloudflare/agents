# `@cloudflare/channels`

`@cloudflare/channels` gives an agent one interface for sending and receiving
messages across different platforms. Use a Channel directly, expose it as an AI
tool, or register it with a durable `ChannelHost` that owns routing and delivery
recovery.

> [!NOTE]
> Channels is experimental. Its interface _will_ change before the package
> reaches a stable release.

## Install

```bash
npm install @cloudflare/channels
```

## Create channels

Each adapter turns provider configuration into the same `Channel` interface. A
`ChannelHost` holds them, keyed by names you choose:

```typescript
import { ChannelHost, email, routes, telegram } from "@cloudflare/channels";
import { slack } from "@cloudflare/channels/slack";

const host = new ChannelHost({
  channels: {
    slack: slack({
      botToken: env.SLACK_BOT_TOKEN,
      webhook: {
        signingSecret: env.SLACK_SIGNING_SECRET,
        botUserId: env.SLACK_BOT_USER_ID
      },
      route: routes.perThread
    }),
    telegram: telegram({
      botToken: env.TELEGRAM_BOT_TOKEN,
      webhook: { secretToken: env.TELEGRAM_WEBHOOK_SECRET },
      route: routes.perThread
    }),
    email: email({
      binding: env.EMAIL,
      from: "agent@example.com",
      route: routes.perThread
    })
  },

  async onMessage({ route, dispatchId, message }) {
    await conversationFor(route).receive(dispatchId, message);
  }
});
```

## 1. Send a message

A **surface** is a destination for an outbound message.
You get one from an inbound message's reply field, or by constructing one from a raw channel identifier through the host.

```typescript
const surface = host.contactSurface({
  channelKey: "slack",
  scope: "T123",
  subject: "U456"
});

await host.deliver(surface, {
  title: "Import needs attention",
  markdown: "The customer import stopped after **1,240 records**."
});
```

An identity's `channelKey` names the configured Channel that observed it. Its
optional `scope` names a tenant within that Channel and defaults to `"default"`;
for example, one configured Slack app can observe the same user ID in several
workspaces. The Host stamps `channelKey` on inbound identities because an adapter
does not know the key it was configured under.

The same human observed through two configured Channels on one platform is two
Channel identities, just as the same human on Slack and email is. Applications
that know they are the same person link those identities explicitly.

Compose destinations with `fallback()` and `fanout()`:

```typescript
import { fallback, fanout } from "@cloudflare/channels";

await host.deliver(fallback([slackSurface, emailSurface]), message);
await host.deliver(fanout([slackSurface, emailSurface]), message);
```

`fallback()` tries destinations in order, advancing only after a _confirmed_
failure, so it can never duplicate a delivery. `fanout()` sends to all of them;
a partial or uncertain result is reported as `uncertain` for the same reason.
The Host installs both policies as ordinary Channels under reserved keys. You
can register another composite policy as an ordinary Channel under your own key
and pair it with a surface constructor that writes that key; inject only the
outbound resolution capability the policy needs, as the exported built-in
policy Channels do.

## 2. Give a destination to a model

```typescript
import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createSendMessageTool } from "@cloudflare/channels/ai-sdk";

const workersai = createWorkersAI({ binding: env.AI });

await generateText({
  model: workersai("@cf/moonshotai/kimi-k2.7-code"),
  prompt: "An import stopped after 1,240 records. Notify support.",
  tools: {
    contactSupport: createSendMessageTool(
      host,
      fallback([slackSurface, emailSurface]),
      { description: "Contact support when a person needs to intervene" }
    )
  },
  stopWhen: stepCountIs(2)
});
```

The model writes the message; you chose the destination. TanStack AI exports the
same `createSendMessageTool(host, surface, options)` from
`@cloudflare/channels/tanstack-ai`.

## 3. Receive messages

One entry point covers every configured Channel's webhook, and Workers Email
arrives the same way:

```typescript
export default {
  async fetch(request: Request): Promise<Response> {
    const response = await host.handleRequest(request);
    if (response) return response;
    return new Response("Not found", { status: 404 });
  },

  async email(message: ForwardableEmailMessage): Promise<void> {
    await host.handleEmail(message);
  }
} satisfies ExportedHandler<Env>;
```

Each Channel authenticates its own input and declines what isn't its business,
so the Host asks them in configuration order and the first to claim it wins.

### Web chat from any Durable Object

The Web Channel speaks the same browser protocol as `AIChatAgent` without
requiring the Durable Object to extend `Agent`. It is an ordinary Channel that
uses an owned WebSockets capability; install that capability into Lifecycle and
handle its normalized messages through the Host:

```typescript
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { ChannelHost, type ChannelInboundMessage } from "@cloudflare/channels";
import { toChannelChunks } from "@cloudflare/channels/ai-sdk";
import { web } from "@cloudflare/channels/web";
import { streamText } from "ai";

export class Chat extends DurableObject<Env> {
  readonly web = web();
  readonly channels = new ChannelHost({
    channels: { web: this.web },
    onMessage: ({ message }) => this.onMessage(message)
  });
  readonly lifecycle = Lifecycle.install(this).use(this.web.webSockets);

  async onMessage(message: ChannelInboundMessage) {
    const result = streamText({
      model: this.env.MODEL,
      prompt: message.message.text
    });
    await this.channels.stream(
      message.replySurface!,
      toChannelChunks(result.fullStream)
    );
  }
}
```

The current compatibility layer converts neutral `ChannelChunk`s into AI SDK
UI message chunks. Live cancellation is supported, while durable stream replay
is intentionally not yet implemented; reconnecting clients receive an idle
resume response.

### Routing

A Channel's `route` turns one normalized event into an opaque application
string — a Durable Object name, a queue key, a database id — or `null` to ignore
the event entirely. The key is used to identify a common destination for
messages -- i.e. typically a single conversation:

```typescript
telegram({
  // …credentials…
  route(event) {
    return event.thread.isDirectMessage === true ? event.thread.id : null;
  }
});
```

Channels exposes builtin helpers for the common mappings — `routes.perThread`
and `routes.perEvent`, which namespace their routes as `thread:…` and
`event:…`.

Deciding whether an event is relevant at all is a different question, and one
only your application can answer, because the answer usually depends on state
you hold. Write that in your own `route` and return `null` to ignore the event:

```typescript
route(event) {
  // Slack shows a bot every message in every channel it belongs to. Answer
  // when addressed, and otherwise only join threads we are already in.
  const thread = routes.perThread(event);
  const addressed =
    event.thread.isDirectMessage === true || event.message.isMention === true;
  if (addressed) return thread;
  return (await myConversations.knows(thread)) ? thread : null;
}
```

A lookup like that runs for every event reaching it, so put it behind a cheaper
check, keep it read-only, and do not let it create the state it is testing for —
otherwise the first stray message conjures the thing the check is looking for.

### Link identities

Personal agents often wwant to resolve users regardless of the channel they messaged on. Your application can explicitly record connections between channel identities and expose them to the Host for messages to be routed on:

```typescript
const host = new ChannelHost({
  channels,
  findUser: (identity) => users.findUser(identity),
  onMessage,
  onApprovalResponse
});

// ...
// route to a user's central conversaion if one exists, else start a new
// conversation for each thread:
route: routes.byUser(routes.perThread);

// or prefer the linked person, then the sender we recognise, then a new
// conversation per event:
route: routes.byUser(routes.byIdentity(routes.perEvent));
```

`byIdentity` groups events carrying the _same_ identity. It never infers that
two different identities belong to one person — that stays an explicit
application decision, which `byUser` then exposes to routing. Omit its fallback
to ignore events that carry no identity at all.

If your application does not already store user identities, `createUserIdentityStore(storage)` creates a Durable Object SQL store of the right shape. Your application can call `store.link` to connect multiple identities together.

### Ask for approval

### Request approval

The Host exposes a utility for durably correlating inbound approvals to outbound requests:

```typescript
await host.requestApproval({
  interactionId: "deploy-42",
  request: {
    title: "Production deployment",
    summary: "Deploy version 2026.08.17 to production?",
    input: {
      version: "2026.08.17",
      environment: "production"
    }
  }
});
await host.requestApproval(surface, {
  interactionId: crypto.randomUUID(),
  request: {
    title: "Production deployment",
    summary: "Deploy version 2026.08.17 to production?",
    input: { version: "2026.08.17" }
  }
});
```

Users can respond to approval requests through native surfaces (e.g. Telegram
buttons) or HTTP inbound URLs, resolved by the Channel Host itself for your application to settle.

## Custom channels

Any transport can become a Channel:

```typescript
import { matchesPath, routes, type Channel } from "@cloudflare/channels";

const supportForm: Channel = {
  route: routes.perEvent,
  ingress: {
    async receive(request) {
      if (!matchesPath(request, "/support")) return null;

      const raw = await request.json<{ message: string; email: string }>();
      const eventId = crypto.randomUUID();
      return {
        events: [
          {
            raw,
            event: {
              type: "message",
              eventId,
              thread: { id: eventId, isDirectMessage: true },
              actor: {
                id: raw.email,
                // The Host stamps the configured `channelKey`.
                identity: { subject: raw.email }
              },
              message: { id: eventId, text: raw.message }
            }
          }
        ],
        response: Response.json({ accepted: true }, { status: 202 })
      };
    }
  }
};
```

Returning `null` declines the request so another Channel can claim it.

## Durability contract

Channels holds no state: no outbox, no retries, no deduplication, no scheduler.
Durability is a property of how your application uses it.

| Channels guarantees                                                     | Your application must                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A `dispatchId` stable across redelivery and unaffected by routing       | Deduplicate on it before starting any side effect                           |
| The Host awaits your callback before the provider is acknowledged       | Hand off durably before returning — a DO RPC, queue send, or workflow start |
| One outbound attempt per `deliver()` or `stream()`, reported honestly   | Decide whether to retry; `uncertain` may duplicate a real delivery          |
| Surfaces are plain JSON you can persist                                 | Keep configured channel keys stable                                         |
| Decisions arrive as normalized events carrying your own `interactionId` | Own settlement; an interaction id is not an authorization credential        |

## Future work

- [ ] Approval-link ingress: signing, verification, and a confirmation page, so
      link approvals return through the same normalized path as Slack buttons
- [ ] Reader-initiated stream cancellation: Slack's `message_stream_stopped`
      and Telegram's `stopped_message_generation` should reach the running
      generation as ordinary ingress, so aborting it errors the stream and
      each Channel finalizes on the path it already has
- [ ] More built-in channels
- [ ] Rendering templates (pretty emails)
- [ ] Automatic webhook registration
- [ ] Security review of approval flows
- [ ] Conformance tests of adapters
