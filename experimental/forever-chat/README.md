# Forever Chat — Durable AI Streaming

AI chat with `durableStreaming` enabled — wraps each chat turn in `runFiber` for automatic keepAlive during streaming and recovery after DO eviction.

See [forever.md](../forever.md) for the full design doc.

## What it shows

- `durableStreaming = true` on `AIChatAgent` — wraps chat turns in fibers
- keepAlive during streaming — DO stays alive for long LLM responses
- `onChatRecovery` — provider-specific recovery after eviction
- `continueLastTurn()` — seamlessly continues the interrupted assistant message inline
- Multi-provider support with a dropdown selector:

| Provider   | Model             | Recovery strategy                                                                                 |
| ---------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| Workers AI | kimi-k2.5         | Persist partial + continue via `continueLastTurn()` (text + reasoning merge into existing blocks) |
| OpenAI     | gpt-5.4           | Retrieve completed response via Responses API (`store: true`) — zero wasted tokens                |
| Anthropic  | claude-sonnet-4.6 | Persist partial + continue via synthetic user message (reasoning disabled for recovery)           |

## Run it

```bash
npm install
cd experimental/forever-chat
cp .env.example .env  # add your API keys
npm start
```

Workers AI works automatically (uses the `AI` binding). OpenAI and Anthropic require API keys in `.env`.
