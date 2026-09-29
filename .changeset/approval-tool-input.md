---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Keep a tool call's input when its approval request arrives before the input is complete ([#1872](https://github.com/cloudflare/agents/issues/1872)).

A tool that needs approval could be saved without its `input`, so the approved call ran with no arguments while the approval card showed the full ones. Two cases caused this:

- `tool-input-delta` chunks were read from `input` instead of `inputTextDelta`, so streamed arguments were ignored. The delta text is now collected and parsed when the approval request arrives.
- A `tool-input-available` that arrived after `tool-approval-request` was dropped. It now fills in the missing input and keeps the approval state. It can replace input taken from partial deltas, but never a complete input. Clients and stream replay receive it followed by the approval request again, so the approval card shows the input and recovery rebuilds the approval with it.

`applyLateToolInput`, `isLateToolInputChunk` and `lateToolInputForwardChunks` are exported from `agents/chat` for stream builders. In Think, the action approval descriptor now also takes its input from streamed delta text.
