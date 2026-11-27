---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat recovery.

- Recovery work units (`maxRecoveryWork`, `ctx.work`) now count ten stored chunks each. See [Recovery work units](https://developers.cloudflare.com/agents/api-reference/chat-agents/#recovery-work-units).
- Rate-limit, transient and overflow errors are recognised without `classifyChatError`, and recovery honours `Retry-After` (up to 60 s).
- An interrupted turn is skipped if the conversation moved on, else answered or continued once, and requests behind it run afterwards in order (#2922).
- Long conversations are no longer sealed with `work_budget_exceeded` (#3055).
- A stop during recovery always ends the request `aborted`, and the next message no longer waits out its backoff (#3027).
- A rebuilt reply no longer repeats parts, and a tool that only reported progress before a reset is reported interrupted (#2979).
- An agent-tool run on a sub-agent whose chat recovery gave up before running a turn now ends `error`; it stayed `running`.
- `chatRecovery.stableTimeoutMs` is deprecated and has no effect: a recovered turn is the next attempt of the turn's own run, so there is no wait for a stable chat before it continues.
- An `AIChatAgent` turn that is recovered keeps its request id and ends once, so a tab no longer sees an end with `outcome: "recovering"` followed by a new request.
- `saveMessages` and `continueLastTurn` resolve once recovery has finished the turn, with how it ended, instead of with `reason: "interrupted"`.
- `onError` hears of an `onChatMessage` failure once per turn, where a recovered `continueLastTurn` reported it twice.
- Recovery no longer calls an overridden `continueLastTurn` or `waitUntilStable`: an interrupted turn is retried or continued as attempts of its own run.
- A turn cut off before the upgrade is carried onto the new chat module under its request id, with the recovery budget of a new turn.
- A stopped reply that was waiting to be retried is stored before the next request's question, and every tab is told the request ended.
