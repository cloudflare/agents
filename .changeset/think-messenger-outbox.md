---
"@cloudflare/think": patch
---

`Think` holds and delivers recovered messenger replies through the `Outbox` capability, retrying a failed post for up to twelve hours. Replies stored by earlier releases move into it on start. See [Messengers](https://github.com/cloudflare/agents/blob/main/docs/think/messengers.md#delivery-and-recovery).
