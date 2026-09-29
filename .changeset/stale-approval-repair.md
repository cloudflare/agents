---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Settle an approved tool call that never ran once the conversation moves past it ([#2382](https://github.com/cloudflare/agents/issues/2382)).

If the continuation that should run an approved tool never ran (for example it failed before streaming), the part stayed `approval-responded`. Every later turn then sent a tool call with no result, which OpenAI-compatible providers reject, so the conversation could not recover.

Transcript repair in `Think` and `AIChatAgent` now settles these parts when a new turn starts after them: an approved call goes through `repairInterruptedToolPart` (by default an `output-error` saying it did not run), and a denied one becomes `output-denied`. Approvals are left alone when the turn is a continuation, when a continuation is still waiting to run, or when the approval is in the last message, where the AI SDK executes it.

`repairInterruptedToolParts` in `agents/chat` has a new `repairApprovalResponded` option for this.
