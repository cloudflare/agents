---
"agents": minor
---

feat: idempotent `schedule()` to prevent row accumulation across DO restarts

`schedule()` now supports an `idempotent` option that deduplicates by `(type, callback, payload)`, preventing duplicate rows from accumulating when called repeatedly (e.g., in `onStart()`).

**Cron schedules are idempotent by default.** Calling `schedule("0 * * * *", "tick")` multiple times with the same callback, cron expression, and payload returns the existing schedule instead of creating a duplicate. Set `{ idempotent: false }` to override.

**Delayed and scheduled (Date) types support opt-in idempotency:**

```typescript
async onStart() {
  // Safe across restarts — only one row exists at a time
  await this.schedule(60, "maintenance", undefined, { idempotent: true });
}
```

**New warnings for common foot-guns:**

- `schedule()` called inside `onStart()` without `{ idempotent: true }` now emits a `console.warn` with actionable guidance (once per callback, skipped for cron and when `idempotent` is explicitly set)
- `alarm()` processing ≥10 stale one-shot rows for the same callback emits a `console.warn` and a `schedule:duplicate_warning` diagnostics channel event
