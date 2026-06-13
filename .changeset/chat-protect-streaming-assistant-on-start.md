---
"@cloudflare/ai-chat": patch
---

Stop a mid-stream full-message-list broadcast (`CF_AGENT_CHAT_MESSAGES`) from briefly clobbering the live-streamed assistant. On the originating tab, streaming protection was only armed at send time — before the turn's assistant message exists — so it latched the previous turn's id (or nothing on the first turn); it is now re-armed to the real assistant id the moment the `start` chunk reports it. Cross-tab observers, which build the in-flight assistant via the broadcast accumulator rather than the local transport, now re-apply that accumulator over an incoming snapshot too. Either way the active turn's parts (e.g. tool cards) no longer disappear and reappear when the server re-broadcasts a behind-the-stream snapshot mid-turn (most visible with agents like Think that broadcast after every tool result).
