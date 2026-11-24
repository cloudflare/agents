---
"agents": patch
---

ThinkHarness chat: a chat request checks only its incoming message ids against storage, and an approval answer finds its tool call from the newest message back, instead of each reading the whole transcript.
