# Channels

This server-only example uses standalone `@cloudflare/channels` for direct and
durable delivery, Telegram and Email ingress, approval links, fallback and
fanout composition, a custom webhook Channel, shared Durable Object alarms, and
AI SDK and TanStack
AI tools. It intentionally does not use Think.

## Run

Update the addresses, Telegram chat ID, and public URLs in `wrangler.jsonc`, then
copy `.dev.vars.example` to `.dev.vars` and add your Telegram secrets. The
configured sender must be available to your Email Service binding.

```bash
pnpm install
pnpm run dev
```

Try each delivery surface:

```bash
curl -X POST http://localhost:8787/direct/telegram
curl -X POST http://localhost:8787/direct/fallback
curl -X POST http://localhost:8787/direct/fanout
curl -X POST http://localhost:8787/direct/custom
curl -X POST 'http://localhost:8787/durable?deliveryId=import-alert-2026-08-17'
curl -X POST 'http://localhost:8787/approval?interactionId=deploy-42&channel=operationsWebhook'
curl -X POST http://localhost:8787/ai-sdk
curl -N -X POST http://localhost:8787/tanstack-ai
curl -X POST http://localhost:8787/application-alarm
curl http://localhost:8787/events
```

Set the Telegram bot webhook to
`<PUBLIC_BASE_URL>/webhooks/telegram`, passing the configured
`TELEGRAM_WEBHOOK_SECRET` as Telegram's `secret_token`. Configure an Email
Routing rule to send inbound mail for `EMAIL_FROM` to this Worker. Telegram
messages, inbound email, approval responses, and application alarms appear in
`GET /events`.

The approval route accepts `supportChat`, `supportEmail`, or
`operationsWebhook` as its `channel` query parameter. Email and the custom
webhook render Host-owned approval links; Telegram accepts a `YES` or `NO` reply
to its approval message.

## Key pattern

One Durable Object owns all routes and gives Channels a named alarm source:

```typescript
const alarms = sharedAlarm(ctx.storage);
const host = new ChannelHost({
  storage: ctx.storage,
  scheduler: alarms.source("channels"),
  channels: { supportChat, supportEmail, resilientSupport },
  delivery: "resilientSupport",
  publicBaseUrl: env.PUBLIC_BASE_URL,
  onMessage,
  onApprovalResponse
});
```

Its request, email, and alarm handlers forward provider ingress and retry work
to the same Host:

```typescript
const response = await host.handleRequest(request);
if (response) return response;

await host.handleEmail(email);

await alarms.handleAlarm({
  channels: (deliveryIds) => host.handleAlarm(deliveryIds),
  application: handleApplicationAlarms
});
```

See [`packages/channels/README.md`](../../packages/channels/README.md) for the
complete standalone Channels guide.
