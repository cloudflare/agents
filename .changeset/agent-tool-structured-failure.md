---
"agents": minor
---

`agentTool()` now returns a structured failure envelope instead of an opaque error string, so a parent agent can tell a transient interruption apart from a terminal failure.

Previously every non-completed sub-agent run collapsed to `{ ok: false, error: string }`. A child that was reset/superseded by a deploy or parent recovery (`interrupted`) looked identical to a genuine failure or an intentional cancellation, so the parent model would often parrot the interruption text back to the user as if the work had permanently failed.

The failure value is now `AgentToolFailure`:

```ts
type AgentToolFailure = {
  ok: false;
  status: "error" | "aborted" | "interrupted";
  error: string; // still human-readable
  retryable: boolean;
};
```

- `interrupted` → `retryable: true` (the run never reached a logical outcome; re-dispatching can succeed), and now surfaces the underlying interruption reason via `error`.
- `aborted` (intentional cancellation) and `error` (genuine failure) → `retryable: false`.

This is backward compatible for consumers that read `ok`/`error`; the new `status` and `retryable` fields let an orchestration harness (or a parent prompt convention) re-run an interrupted sub-agent automatically rather than reporting it as final. `AgentToolFailure` is exported from `agents`.
