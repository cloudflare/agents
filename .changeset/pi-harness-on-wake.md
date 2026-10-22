---
"agents": minor
---

`PiHarness` hands its factory an `onWake` to pass to `Harness.open`, so the Durable Object can hibernate while Pi's tasks sleep. Add it to your factory: `harness: ({ storage, context, onWake }) => Harness.open(storage, { ...options, onWake }, context)`. Without it the harness still works and logs a warning. See [Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/).
