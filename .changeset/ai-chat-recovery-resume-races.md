---
"@cloudflare/ai-chat": patch
"agents": patch
---

Fix three chat recovery and resume races found by model-checking:

- Stopping a recovered turn while its continuation waits on the model now stops it. The client only knows the turn's original request id at that point, and that cancel used to be dropped.
- A recovery continuation no longer runs when a newer question is the last message (for example, one the user sent and then stopped). It used to answer that question inside the old reply.
- A reconnecting tab that acknowledges a resume notice for a stream that already finished keeps waiting for the replay of the stream that runs now, instead of getting that stream's live chunks from the middle.
