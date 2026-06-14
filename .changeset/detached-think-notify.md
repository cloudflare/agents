---
"@cloudflare/think": minor
---

Add `detached: { notify: true }` support for `runAgentTool` on Think agents
(cloudflare/agents#1752).

When a detached sub-agent run finishes, Think can inject a message back into the
chat so the model reacts to the result — without you wiring `onFinish` by hand:

```ts
await this.runAgentTool(ResearchAgent, {
  input,
  detached: { notify: true }
});
```

The injected turn is idempotent per run + terminal status (built on
`submitMessages`), so an exactly-once finish never duplicates, while a soft
give-up followed by a real late completion surfaces as two distinct turns.
Override `formatDetachedCompletion(run, result)` to customize (or suppress) the
injected text.
