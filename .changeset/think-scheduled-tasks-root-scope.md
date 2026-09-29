---
"@cloudflare/think": minor
---

Arm declared scheduled tasks on the root agent only, so a Think agent that also has sub-agents no longer runs each occurrence once per live sub-agent.

`_reconcileDeclaredScheduledTasks()` ran on every instance of the class with no root/facet guard. It resolves tasks from `getScheduledTasks()` — normally a static code declaration, so it returns the _same_ tasks on every instance — and keyed the arming on `stableHash(this.selfPath)`, which is the instance's own owner. Every live facet therefore armed a full private copy of the schedule, and each slot dispatched once per facet on top of the root:

```sql
SELECT owner_path, COUNT(*) FROM cf_agents_schedules
WHERE callback = '_runDeclaredScheduledTask' GROUP BY owner_path;
-- one full set for the root, plus one per sub-agent
```

Nothing surfaced this. The write-time duplicate warning only fires for non-idempotent `schedule()` calls in `onStart`, and declared tasks always pass `idempotent: true`; the alarm-time warning needs ten one-shot rows for a single callback, and these are spread across distinct owners. The docs made it worse — the "Scheduled responses" section of the sub-agents guide showed a static `getScheduledTasks()` on an agent with sub-agents, which is exactly the multiplying shape.

Declared tasks now arm on the root only. A new `getScheduledTasksScope()` hook returns `"root"` by default; return `"all"` to restore per-facet arming:

```typescript
export class PerUserAgent extends Think<Env> {
  getScheduledTasksScope() {
    return "all" as const;
  }

  async getScheduledTasks() {
    const reminder = await this.getReminderForThisUser();
    return reminder ? { reminder } : {};
  }
}
```

That opt-in is the right choice only when `getScheduledTasks()` genuinely varies per sub-agent, since each one then owns an independent schedule.

**Migration.** Nothing to do for sub-agents that already armed rows.

Duplicate _executions_ stop immediately. `_runDeclaredScheduledTask` carries the same guard, so a dispatch into a root-scoped sub-agent returns before it runs the action and before the `finally` that arms the next occurrence. Declared tasks are armed as one-shot schedules, so the pending occurrence is consumed and deleted by the alarm loop and the recurrence dies out — no restart required.

The leftover rows are then cleaned up whenever the sub-agent next starts: a root-scoped facet reconciles against an empty task set, so the existing prune pass cancels each underlying Agent schedule and deletes the ledger row. Note this is keyed on the _sub-agent_ starting, not the root — evicting a parent does not evict its facets, and `subAgent()` only replays `onStart` for a facet that is not already running.

A one-time warning naming `getScheduledTasksScope()` is logged whenever a sub-agent declares tasks it will not arm. That covers both populations: agents upgrading with rows to prune, and agents declaring a sub-agent task for the first time under the new default, which would otherwise be inert with nothing in the ledger to notice.
