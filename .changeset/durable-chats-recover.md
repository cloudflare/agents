---
"agents": minor
"@cloudflare/ai-chat": minor
"@cloudflare/think": minor
---

Make durable chat recovery unconditional for `AIChatAgent` and `Think`.

Every chat turn now runs in a recovery fiber, including WebSocket, programmatic, retry, and continuation paths. `chatRecovery` accepts `true` or a configuration object; `false` is no longer supported. Previously compiled JavaScript that still supplies `false` safely receives the default recovery configuration.

To keep durable bookkeeping while preventing automatic inference after an interruption, return `{ continue: false }` from `onChatRecovery()`. Use durable cancellation, side-effect, or spend state in that hook and tune `chatRecovery` budgets when retries must be bounded.
