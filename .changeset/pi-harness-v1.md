---
"agents": patch
---

Move the experimental pi integrations to pi-durable and pi-ai 1.0: both optional peers are now `^1.0.0`. `PiHarness` changes with them:

- The `harness` factory receives `{ storage, context }`. Build the registry, models and pi's `settings` yourself and pass them to `Harness.open`.
- `defaults` is `model` and `thinkingLevel`. `defaults.model` and `session.setModel()` take a pi-ai `Model`, such as `createAI`'s `ai("@cf/…")`. Generation retries move to pi's `settings.retry`.
- `addSkills(registry, sources)` is replaced by `registry.install(await skills(sources))`.
- The `store` and `timing` options are removed.

See [Pi harness](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md).
