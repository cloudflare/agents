---
"@cloudflare/ai-chat": patch
---

Follow-up to #956. Allow `addToolOutput` to work with tools in `approval-requested` and `approval-responded` states, not just `input-available`. Also adds support for `state: "output-error"` and `errorText` fields, enabling custom denial messages when rejecting tool approvals (addresses remaining items from #955).

Additionally, tool approval rejections (`approved: false`) now auto-continue the conversation when `autoContinue` is set, so the LLM sees the denial and can respond naturally (e.g. suggest alternatives).

This enables the Vercel AI SDK recommended pattern for client-side tool denial:

```ts
addToolOutput({
  toolCallId: invocation.toolCallId,
  state: "output-error",
  errorText: "User declined: insufficient permissions"
});
```
