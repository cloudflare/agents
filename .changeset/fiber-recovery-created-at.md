---
"agents": minor
"@cloudflare/ai-chat": minor
"@cloudflare/think": minor
---

Expose `createdAt` on fiber and chat recovery contexts so apps can suppress continuations for stale, interrupted turns.

- `FiberRecoveryContext` (from `agents`) gains `createdAt: number` — epoch milliseconds when `runFiber` started, read from the `cf_agents_runs` row that was already tracked internally.
- `ChatRecoveryContext` (from `@cloudflare/ai-chat` and `@cloudflare/think`) gains the same `createdAt` field, threaded through from the underlying fiber.

With this, the stale-recovery guard pattern described in [#1324](https://github.com/cloudflare/agents/issues/1324) is a short override:

```typescript
override async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
  if (Date.now() - ctx.createdAt > 2 * 60 * 1000) return { continue: false };
  return {};
}
```

No behavior change for existing callers. See `docs/chat-agents.md` (new "Guarding against stale recoveries" section) for the full recipe, including a loop-protection pattern using `onChatResponse`.
