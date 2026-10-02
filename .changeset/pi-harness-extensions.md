---
"agents": patch
---

Add extensions to the experimental `agents/harness/pi`. An extension is a function that registers transforms on the harness's tools and system prompt. Pass extensions to `PiHarness` as `extensions`, and pass the `registry` the `harness` factory now receives to `Harness.open`. `skills(sources)` replaces `addSkills(registry, sources)`. See [Pi harness extensions](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi-extensions.md) for which pi-durable extension features are supported.
