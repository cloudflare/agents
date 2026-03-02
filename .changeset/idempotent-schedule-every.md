---
"agents": patch
---

Make `scheduleEvery()` idempotent on callback name

`scheduleEvery()` now deduplicates by callback name: calling it multiple times with the same callback returns the existing schedule instead of creating a duplicate. If the interval or payload changed, the existing schedule is updated in place.

This fixes the common pattern of calling `scheduleEvery()` inside `onStart()`, which runs on every Durable Object wake. Previously each wake created a new interval schedule, leading to a thundering herd of duplicate executions.
