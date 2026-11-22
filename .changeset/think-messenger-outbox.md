---
"@cloudflare/think": patch
---

`Think` retries a recovered messenger reply whose post failed for up to twelve hours, resuming after the last post that went out. Replies pending from earlier releases are delivered on start. See [Messengers](https://github.com/cloudflare/agents/blob/main/docs/think/messengers.md#delivery-and-recovery).
