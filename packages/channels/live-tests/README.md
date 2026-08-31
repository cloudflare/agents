# Live delivery tests

These local-only tests call the real `telegram()`, `slack()`, `email()`, and `web()`
adapters through `ChannelHost`, then read each destination through an independent
provider API. They are not part of normal package tests, Nx affected tests, or
CI.

The configured destinations must be disposable. The test deletes their messages
before and after delivery. Telegram's immutable chat/channel creation service
record is ignored, but every text message is deleted. Do not use personal or
shared destinations.

## Configuration

Set these variables in an uncommitted environment file or the shell:

- Telegram: `CHANNELS_LIVE_TELEGRAM_BOT_TOKEN`,
  `CHANNELS_LIVE_TELEGRAM_CHAT_ID`, `CHANNELS_LIVE_TELEGRAM_API_ID`,
  `CHANNELS_LIVE_TELEGRAM_API_HASH`, `CHANNELS_LIVE_TELEGRAM_SESSION`
- Slack: `CHANNELS_LIVE_SLACK_BOT_TOKEN`,
  `CHANNELS_LIVE_SLACK_CHANNEL_ID`
- Email: `CHANNELS_LIVE_EMAIL_FROM`, `CHANNELS_LIVE_EMAIL_TO`,
  `CHANNELS_LIVE_FASTMAIL_API_TOKEN`,
  `CHANNELS_LIVE_CLOUDFLARE_ACCOUNT_ID`,
  `CHANNELS_LIVE_CLOUDFLARE_API_TOKEN`
- Web: `CHANNELS_LIVE_WEB_URL` and, for a deployed fixture,
  `CHANNELS_LIVE_WEB_TOKEN`

Telegram observation uses a non-bot Teleproto `StringSession`. Slack needs
`chat:write`, `channels:history`, and membership in the configured channel. The
email sender needs Cloudflare Email Service access; Fastmail supplies independent
JMAP observation and deletion.

Slack live streaming posts a disposable anchor and streams its thread reply. It
also needs the reader's user and team ids; the binding derives them from
`auth.test` and the one channel member that is not this bot, so no extra
configuration or scope is needed.

Telegram only shows drafts in private chats. Point
`CHANNELS_LIVE_TELEGRAM_CHAT_ID` at a private chat with the bot to exercise the
draft path. A group still receives the terminal message, but cannot prove that
streaming previews reached a reader.

The Web binding observes the destination through a real
`WebSocketChatTransport`. A separate non-hibernating Cap'n Web session drives
the fixture Durable Object's `ChannelHost`, keeping each streamed delivery on
one live object instance. The fixture persists only the reply surface; each test
uses a fresh object name and clears it afterward.

## Run

```sh
pnpm --filter @cloudflare/channels test:live
```

Run one provider with Vitest's name filter:

```sh
pnpm --filter @cloudflare/channels test:live -t telegram
```

For a local Web run, start the fixture and test it from separate terminals:

```sh
pnpm --filter @cloudflare/channels dev:live:web
```

```sh
CHANNELS_LIVE_WEB_URL=http://127.0.0.1:8799 \
  pnpm --filter @cloudflare/channels test:live -t web
```

To use a deployed fixture, configure its token and deploy the worker, then set
the matching URL and token in the test environment:

```sh
pnpm exec wrangler secret put LIVE_TEST_TOKEN \
  --config packages/channels/live-tests/web/wrangler.jsonc
pnpm exec wrangler deploy \
  --config packages/channels/live-tests/web/wrangler.jsonc
```

The worker accepts tokenless requests only on localhost. Do not commit the
token or an environment file containing it.
