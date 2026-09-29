---
"@cloudflare/think": minor
---

Messenger replies now see every message in a quick burst, not just the last one. The Chat SDK `burst` strategy answers only the newest message and hands the earlier ones to the handler as `context.skipped`, which the runtime ignored, so the model lost everything but the final line. They are now forwarded as `ChatSdkMessengerEventInput.skipped`, `MessengerEvent.skipped`, and `MessengerContext.skipped`, and rendered oldest first in the same user turn. Consecutive messages from one channel speaker share a label. In a subscribed thread, a burst whose mention is not the newest message is still answered as a mention. A custom `toEvent` must copy `input.skipped` onto its event (or start from `defaultChatSdkEvent`) to keep the earlier messages.
