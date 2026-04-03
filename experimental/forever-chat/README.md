# Forever Chat — Durable AI Streaming

> **WARNING: EXPERIMENTAL.** This example uses APIs from `agents/experimental/forever` and `@cloudflare/ai-chat/experimental/forever` that are under active development and **will break** between releases. Do not use in production. Pin your package versions and expect to rewrite your code when upgrading.

AI chat using `withDurableChat(AIChatAgent)` — the mixin adds keepAlive during streaming and automatic recovery after DO eviction.

See [forever.md](../forever.md) for the full design doc.

## What it shows

- `withDurableChat` mixin from `@cloudflare/ai-chat/experimental/forever`
- keepAlive during streaming — DO stays alive for long LLM responses
- `onChatRecovery` — provider-specific recovery after eviction
- `continueLastTurn()` — seamlessly continues the interrupted assistant message inline
- Multi-provider support with a dropdown selector:

| Provider   | Model             | Recovery strategy                                                                       |
| ---------- | ----------------- | --------------------------------------------------------------------------------------- |
| Workers AI | kimi-k2.5         | Persist partial + inline continuation via `continueLastTurn()`                          |
| OpenAI     | gpt-5.4           | Retrieve completed response via Responses API (`store: true`) — zero wasted tokens      |
| Anthropic  | claude-sonnet-4.6 | Persist partial + continue via synthetic user message (reasoning disabled for recovery) |

## Run it

```bash
npm install
cd experimental/forever-chat
cp .env.example .env  # add your API keys
npm start
```

Workers AI works automatically (uses the `AI` binding). OpenAI and Anthropic require API keys in `.env`.
