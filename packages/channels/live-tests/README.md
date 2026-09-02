# Live delivery tests

These local-only tests call the real `telegram()`, `slack()`, and `email()`
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

## Run

```sh
pnpm --filter @cloudflare/channels test:live
```

Run one provider with Vitest's name filter:

```sh
pnpm --filter @cloudflare/channels test:live -t telegram
```
