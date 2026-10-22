---
"agents": patch
---

`PiHarness` wakes from Pi's `wake()` with one job per object, so a task parked by Pi's restart limit no longer keeps the Durable Object awake. See [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/).
