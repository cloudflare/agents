---
"agents": patch
---

Make `scheduleEvery()` idempotent

`scheduleEvery()` now deduplicates by the combination of callback name, interval, and payload: calling it multiple times with the same arguments returns the existing schedule instead of creating a duplicate. A different interval or payload creates a separate, independent schedule.

This fixes the common pattern of calling `scheduleEvery()` inside `onStart()`, which runs on every Durable Object wake. Previously each wake created a new interval schedule, leading to a thundering herd of duplicate executions.
