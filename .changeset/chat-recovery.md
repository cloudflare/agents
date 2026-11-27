---
"agents": patch
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Chat recovery after a restart or a dropped stream.

- A request waiting behind a turn that a reset cut off now runs after the recovered turn (#2922). See [Requests waiting behind an interrupted turn](https://developers.cloudflare.com/agents/api-reference/chat-agents/#requests-waiting-behind-an-interrupted-turn).
- The recovery budget no longer grows by a conversation's whole history on each new isolate, which sealed long conversations with `work_budget_exceeded` (#3055).
- Stopping a request being recovered always ends it `aborted` (#3027).
- A turn found interrupted after a restart is skipped when the conversation moved on, its question is answered again when it is still the latest message, and the latest reply is continued.
- Recovery no longer continues a reply twice and honours a provider's `Retry-After` (up to 60 seconds).
- A rebuilt orphaned reply no longer repeats its parts (#2979).
- Provider rate-limit, transient and context-overflow errors are recognised without `classifyChatError`. `AIChatAgent` recovers a rate-limited or transient error like a dropped stream when the error reaches it with its status (a `toUIMessageStreamResponse()` whose `onError` rethrows; the default masks it).
- Recovery work units (`maxRecoveryWork`, `ctx.work`) now count ten stored chunks each. See [Recovery work units](https://developers.cloudflare.com/agents/api-reference/chat-agents/#recovery-work-units).
- A reply cut off twice by resets a few seconds apart is recovered again before a request queued behind it runs, so that request no longer leaves it unanswered.
- A stop issued while the stall watchdog aborts a reply (for example from an `abortRequest` override) is a stop: the stalled reply is not recovered.
- A message sent while an interrupted reply waits to be recovered is answered after the recovered reply, not before it, so replies stay in the order their questions were sent.
- A stop that lands just as a reply is cut off no longer makes the next message wait out the cancelled recovery's backoff.
- An agent-tool run on a sub-agent whose chat recovery gave up before running a turn now ends `error`; it stayed `running`.
- A tool cut off by a reset after reporting only progress (an `async function*` `execute`) is reported interrupted, not given its progress as its result.
- `chatRecovery.stableTimeoutMs` is deprecated and has no effect: a recovered turn is the next attempt of the turn's own run, so there is no wait for a stable chat before it continues.
- An `AIChatAgent` turn that is recovered keeps its request id and ends once, so a tab no longer sees an end with `outcome: "recovering"` followed by a new request.
- `saveMessages` and `continueLastTurn` resolve once recovery has finished the turn, with how it ended, instead of with `reason: "interrupted"`.
- `onError` hears of an `onChatMessage` failure once per turn, where a recovered `continueLastTurn` reported it twice.
- Recovery no longer calls an overridden `continueLastTurn` or `waitUntilStable`: an interrupted turn is retried or continued as attempts of its own run.
- A turn cut off before the upgrade is carried onto the new chat module under its request id, with the recovery budget of a new turn.
- A stopped reply that was waiting to be retried is stored before the next request's question, and every tab is told the request ended.
- A parent `AIChatAgent` turn that waits on an agent-tool child no longer counts the child's streamed output as its own recovery progress, so a parent turn cut off while it waits is given up by its own no-progress window.
