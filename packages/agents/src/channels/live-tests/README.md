# Live delivery tests

These local-only tests call the real `telegram()`, `slack()`, `email()`, and
`web()` adapters through `ChannelHost`, then read each destination through an
independent provider API. The shared rich-stream scenario sends real reasoning
boundaries and tool input/output chunks. Its Slack and Telegram bindings opt in
to rendering both kinds of part. A Web-only scenario opens two sockets in one
conversation, verifies the Channel preserves prior canonical history while
broadcasting the accepted user message and ordinary output to the other socket,
and verifies only the initiating socket receives and executes its browser tool.
Additional Web-only scenarios disconnect the destination, reconnect through the
resume handshake, replay a prefix, and follow the live tail without duplicate
deltas. Another replays retained partial output followed by the durable
producer error. A replacement owner also replays its browser tool, returns the result
through the reconstructed correlation, and keeps the tool hidden from the other
conversation member. It then returns the client result, completes the resume
offer/ack handshake, and checks that both sockets observe the continuation.
These tests are not part of normal package tests, Nx affected tests, or CI.

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
one live object instance. The fixture stores a deterministic canonical history, persists admitted user
messages, and installs the same `Streams` capability used by `ChannelHost`.
Each test uses a fresh object name and clears it afterward. This proves
full-snapshot history synchronization, live conversation fanout, and durable
replay-to-live delivery after a disconnect. The fixture also forwards Host HTTP
ingress so the default `useAgentChat` `/get-messages` loader reads the same
canonical resolver as socket hydration.

The separate `web-channel-stream-eviction.test.ts` starts this fixture with
persistent local storage. It proves a normal `requestApproval` call and
`onApprovalResponse` application continuation over a real socket, verifies
initial HTTP hydration and application-owned conversation reset, then records a
terminal response, kills Wrangler, restarts it, and completes the offer/ACK
replay on a replacement socket.

## Run

Build `agents` before starting the Web fixture. Its public `agents/lifecycle`
and `agents/channels/web` imports resolve through package build output.

Run all configured providers:

```sh
pnpm --filter agents test:channels:live
```

Run one provider with Vitest's name filter:

```sh
pnpm --filter agents test:channels:live -t telegram
```

For a local Web run, start the fixture and test it from separate terminals:

```sh
pnpm --filter agents build
pnpm --filter agents dev:channels:live:web
```

```sh
CHANNELS_LIVE_WEB_URL=http://127.0.0.1:8799 \
  pnpm --filter agents test:channels:live -t web
```

The parent package script starts Wrangler with
`src/channels/live-tests/web/wrangler.jsonc` and the `WebChannelLiveObject`
entrypoint.

To see the Web Channel through the React client hooks, leave the fixture running
and start the client in a third terminal:

```sh
pnpm --filter agents dev:channels:react:web
```

Open <http://localhost:8800/> in two tabs. Both tabs join the same live
conversation and use the local `useAgent` and `useAgentChat` builds. A message
sent from either tab appears in both, while its browser tool runs only in the
sending tab. The default path appends the server continuation to the same
assistant message. Select
**Rich stream** to see deterministic reasoning, text, and a source. **Stop**
sends the hook's cancellation and retains partial output. Select **Interrupted
rich stream** to see the error state. The page also displays the expected identity gap: the chat works, but the
Web Channel does not yet implement the broader Agent identity protocol.

The raw protocol viewer remains at <http://127.0.0.1:8799/>. It displays every
WebSocket frame and is useful when debugging the transport separately from the
hooks.

Neither page calls a model or needs credentials locally. Only requests whose
body contains `demo: "rich"` receive the deterministic reply, so the live tests'
control-plane requests continue to capture a reply surface without triggering
an application response. Canonical history synchronization and durable response
replay are enabled. Agent state and ordinary Agent RPC remain unimplemented.

To use a deployed fixture, configure its token and deploy the worker, then set
the matching URL and token in the test environment:

```sh
pnpm exec wrangler secret put LIVE_TEST_TOKEN \
  --config packages/agents/src/channels/live-tests/web/wrangler.jsonc
pnpm exec wrangler deploy \
  --config packages/agents/src/channels/live-tests/web/wrangler.jsonc
```

The worker accepts tokenless requests only on localhost. A deployed fixture
requires `LIVE_TEST_TOKEN` on the worker and a matching
`CHANNELS_LIVE_WEB_TOKEN` for the test process. Do not commit either token or an
environment file containing it.
