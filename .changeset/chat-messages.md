---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Stored chat messages.

- Before each turn, calls and approvals left pending earlier are failed (`chat:transcript:repaired`), and `continueLastTurn()` returns `"awaiting-client"` while a reply waits on a client.
- Stored parts keep metadata, file names and steering messages, and a finished streaming tool stays in later turns (#3143, #3145).
- A repeated tool result is a no-op, an early approval keeps the final input, and a failed store reaches `onChatResponse` as `error` (#2981).
