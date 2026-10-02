---
"agents": patch
---

Add extensions to the experimental `agents/harness/pi`. An extension is a function that registers transforms on the harness's tools and system prompt. Pass extensions to `PiHarness` as `extensions`, and pass the `registry` the `harness` factory now receives to `Harness.open`. A tool's `execute(args, ctx)` gets its schema-typed arguments and `{ signal, api, context }`. `skills(sources)` replaces `addSkills(registry, sources)`. The shape every harness's extensions share is in the new `agents/harness`. See [Pi harness extensions](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi-extensions.md) for which pi-durable extension features are supported.
