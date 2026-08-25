# Channels support application

A small support inbox built on [`agents/channels`](../../docs/agents/channels.md).
Slack, Telegram, email, and support-form messages become one normalized event;
each conversation lives in a Durable Object; and stored surfaces let the
application answer later on the same or another Channel.

## Run locally

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm run start
```

Fill in the provider secrets in `.dev.vars`.

The support form Channel works on `localhost`. Slack and Telegram deliver over
webhooks, so they need a public URL: expose the Vite server with
`cloudflared tunnel --url http://localhost:5173` and register that hostname with
each provider, or run `pnpm run deploy` and point them at the Worker. Workers
Email ingress requires a deployed Worker with Email Routing configured.

| Source       | Ingress                         | Setup                                                            |
| ------------ | ------------------------------- | ---------------------------------------------------------------- |
| Slack        | `/webhooks/slack`               | Subscribe the app to direct message and `app_mention` events     |
| Telegram     | `/webhooks/telegram`            | Register the URL with `setWebhook` and `TELEGRAM_WEBHOOK_SECRET` |
| Email        | Workers Email `email()` handler | Route `EMAIL_FROM` to this Worker and bind Email Service         |
| Support form | `POST /ingress/support-form`    | Nothing — it is this example's own Channel                       |

## Where to read

| File                                                         | What it shows                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| [`src/server.ts`](src/server.ts)                             | Every Channel, its routing, the Router, and the entry points |
| [`src/conversation.ts`](src/conversation.ts)                 | Storing what arrived and delivering through stored surfaces  |
| [`src/directory.ts`](src/directory.ts)                       | Linking Channel identities to users                          |
| [`src/support-form-channel.ts`](src/support-form-channel.ts) | Writing an inbound-only Channel                              |

`src/api.ts` and `src/ui/` are browser plumbing. Nothing in them is specific to
Channels.

## Ingress and routing

A `ChannelRouter` authenticates and normalizes each provider event, asks the
receiving Channel for an application route, stamps its reply surface with the
configured `channelKey`, and hands it to the application:

```typescript
new ChannelRouter({
  channels: createChannels(env),
  findUser: (identity) => directoryFor(env).userFor(identity),
  async onMessage({ channelKey, route, dispatchId, message }) {
    await env.Conversation.getByName(route).receive(
      route,
      channelKey,
      dispatchId,
      message
    );
  }
});
```

A route is any string returned by the Channel's `route` function, or `null` to
ignore the event. The common `byUser` policy prefers an explicitly linked user
and otherwise delegates to another policy:

```typescript
telegram({
  botToken: env.TELEGRAM_BOT_TOKEN,
  webhook: { secretToken: env.TELEGRAM_WEBHOOK_SECRET },
  route: routes.byUser(routes.perThread)
});
```

The Slack Channel keeps a hand-written route so the example also shows how to
accept direct messages, mentions, and replies within an existing thread while
returning `null` for standalone channel chatter.

Providers can deliver the same event more than once. The conversation
Durable Object deduplicates on `dispatchId` before storing anything.

## Surfaces and replies

Each inbound message may carry `replySurface`: the exact place the conversation
can be answered. The Router stamps the configured Channel key before the
application stores it. Every surface also carries an adapter-provided display
label. Replying later requires only the Router and that surface:

```typescript
const surface = JSON.parse(row.reply_surface);
const delivery = await router.deliver(surface, { markdown });
```

The conversation stores the resulting `delivered`, `failed`, or `uncertain`
result as-is, and the UI displays what the Channel reported.

The custom support-form Channel is inbound only. It has no fake surface and no
`deliver()` method; a linked email, Slack, or Telegram identity supplies an
outbound contact surface when one exists.

## Approvals

The composer can ask for elevated access instead of sending a message. The Router
resolves the same stored surface, and the selected Channel renders the request
as Slack buttons, a Telegram prompt, or email links:

```typescript
await router.requestApproval(surface, {
  interactionId: crypto.randomUUID(),
  request: { title: "Elevated access request", summary, input }
});
```

Correlation belongs to the application. An approval decision routes by the
approver's explicitly linked identity, then that conversation finds its pending
request by opaque interaction ID. The first decision wins.

## Identity and continuity

Identity and destination are separate:

- `actor.identity` says **who** sent an inbound message;
- `replySurface` says **where** this conversation can be answered;
- `router.contactSurface(identity)` finds a new direct destination;
- `createUserIdentityStore()` records explicit links between identities that
  represent the same application user.

Every Channel route prefers an explicitly linked user and returns
`user:${user.id}` when one exists. Future email, support-form, Slack, and
Telegram events from linked identities therefore continue in one cross-channel
conversation. Linking does not merge conversations that already exist; it
changes where future events route.

See [`docs/agents/channels.md`](../../docs/agents/channels.md) for the
complete package API.
