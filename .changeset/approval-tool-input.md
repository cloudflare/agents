---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Keep a tool call's input when its approval request arrives before the input is complete ([#1872](https://github.com/cloudflare/agents/issues/1872)).

A tool that needs approval could be saved without its `input`, so the approved call ran with no arguments while the approval card showed the full ones. Two cases caused this:

- `tool-input-delta` chunks were read from `input` instead of `inputTextDelta`, so streamed arguments were ignored. The delta text is now collected and parsed when the approval request arrives.
- A `tool-input-available` that arrived after `tool-approval-request` was dropped. It now fills in the missing input, keeps the approval state, and is not forwarded to clients, so their approval card stays in place. It never replaces a complete input the user has already seen.

`applyLateToolInput` and `isLateToolInputChunk` are exported from `agents/chat` for stream builders.
