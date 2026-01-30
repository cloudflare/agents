---
"agents": patch
---

feat: Add `scheduleEvery` method for fixed-interval scheduling

Adds a new `scheduleEvery(intervalSeconds, callback, payload?)` method to the Agent class for scheduling recurring tasks at fixed intervals.

### Features

- **Fixed interval execution**: Schedule a callback to run every N seconds
- **Overlap prevention**: If a callback is still running when the next interval fires, the next execution is skipped
- **Error resilience**: If a callback throws, the schedule persists and continues on the next interval
- **Cancellable**: Use `cancelSchedule(id)` to stop the recurring schedule

### Usage

```typescript
class MyAgent extends Agent {
  async onStart() {
    // Run cleanup every 60 seconds
    await this.scheduleEvery(60, "cleanup");

    // With payload
    await this.scheduleEvery(300, "syncData", { source: "api" });
  }

  cleanup() {
    // Runs every 60 seconds
  }

  syncData(payload: { source: string }) {
    // Runs every 300 seconds with payload
  }
}
```

### Querying interval schedules

```typescript
// Get all interval schedules
const intervals = await this.getSchedules({ type: "interval" });
```

### Schema changes

Adds `intervalSeconds` and `running` columns to `cf_agents_schedules` table (auto-migrated for existing agents).
