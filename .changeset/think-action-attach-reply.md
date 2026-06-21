---
"@cloudflare/think": minor
---

Add `ctx.attachReply(attachment)` for actions: an advisory, recording-only reply-attachment side-channel surfaced on `ChatResponseResult.attachments` (in `onChatResponse`) and a public `replyAttachments(requestId?)` getter. Attachments are JSON-normalized, deep-copied on read, capped per turn, and never alter the model-visible tool output; policy callbacks are no-ops, failed executions discard their attachments, approval-gated approved actions support it, and durable-pause approved actions are a v1 no-op.
