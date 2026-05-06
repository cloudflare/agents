---
"@cloudflare/think": minor
---

Stop applying `pruneMessages({ toolCalls: "before-last-2-messages" })` to the model context by default. The previous default silently stripped client-side tool results (no `execute`, output supplied via `addToolOutput`) from any turn beyond the second, breaking multi-turn flows where the user's choices live in those tool results (see #1455). `truncateOlderMessages` still runs as before, so context cost stays bounded.

This is a behavior change. Subclasses that relied on the old aggressive pruning can opt back in from `beforeTurn`:

```typescript
import { pruneMessages } from "ai";

beforeTurn(ctx) {
  return {
    messages: pruneMessages({
      messages: ctx.messages,
      toolCalls: "before-last-2-messages"
    })
  };
}
```
