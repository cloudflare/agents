---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Report a failed agent-tool child as failed even if it was evicted before it finished recording the failure.

When an `AIChatAgent` or `Think` child's turn failed mid-stream, it still saved its assistant reply (often an error message). If the child was evicted before it marked the run as failed, recovery later saw that reply and reported the run as `completed`, so the parent treated a failed task as a success. The child now saves the stream error on the run as soon as it happens, and recovery reports the run as `error` with that message.
