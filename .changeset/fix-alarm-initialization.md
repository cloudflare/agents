---
"agents": patch
---

Fix Agent alarm() bypassing PartyServer's initialization

The Agent class defined `alarm` as a `public readonly` arrow function property, which completely shadowed PartyServer's `alarm()` prototype method. This meant `#ensureInitialized()` was never called when a Durable Object woke via alarm (e.g. from `scheduleEvery`), causing `this.name` to throw and `onStart` to never run.

Converted `alarm` from an arrow function property to a regular async method that calls `super.alarm()` before processing scheduled tasks. Also added an `onAlarm()` no-op override to suppress PartyServer's default warning log.
