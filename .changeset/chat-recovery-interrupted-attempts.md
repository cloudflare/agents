---
"agents": patch
"@cloudflare/think": patch
"@cloudflare/ai-chat": patch
---

Chat recovery now seals a turn after `chatRecovery.maxInterruptedAttempts` interrupted attempts (default 5), so a turn that exceeds the Durable Object memory limit on every run no longer retries forever; `maxOomRetries` is deprecated. See [Stream Recovery](https://github.com/cloudflare/agents/blob/main/docs/agents/chat-agents.md#stream-recovery).
