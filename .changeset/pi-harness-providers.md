---
"agents": patch
---

`PiHarness` opens pi's `Harness` itself. Pass `providers` (such as `createAI`'s `ai.provider`) instead of the `harness` factory; pi-durable's other `Harness.open` options (`settings`, `env`, `onReport`, `conversationCreated`, `now`) go at the top level. `defaults.model` and `session.setModel()` take a pi-ai `Model`, such as `ai("@cf/…")`.
