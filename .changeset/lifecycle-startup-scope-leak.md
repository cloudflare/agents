---
"agents": patch
---

Stop Lifecycle startup keeping an evicted Durable Object in memory when a capability's startup leaves a promise pending, as `PiHarness` does when it opens Pi. See [Pi harness](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md#create-the-harness).
