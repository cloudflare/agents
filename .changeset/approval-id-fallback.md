---
"agents": patch
"@cloudflare/ai-chat": patch
---

Ensure tool approval updates always retain a provider-facing approval id.

Older or hand-seeded transcripts can contain an `approval-requested` tool part
without an `approval.id`. When that part is approved and auto-continuation
re-enters inference, the AI SDK requires a matching approval id in the converted
model messages. Approval updates now synthesize a stable id from the
`toolCallId` when the transcript is missing one, preventing invalid prompt
errors while preserving existing approval metadata. `@cloudflare/ai-chat` now
routes its approval merge through the shared `toolApprovalUpdate` builder so it
benefits from the same fallback instead of its own divergent copy.
