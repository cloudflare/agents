---
"agents": minor
---

Move agent state into the opt-in `StateManager` Lifecycle capability.

State was one method doing four jobs inside `Agent` — validate,
persist, broadcast, notify. It moves wholesale into a `StateManager`
capability that owns storage and change ordering, so any Lifecycle
host gets durable, validated state without inheriting `Agent`:

```ts
new StateManager({
  initialState: { count: 0 },
  validateStateChange: (next, source) => validate(next, source),
  onChanged: (state, source) => notify(state, source)
});
```

The capability owns the `cf_agents_state` state row, lazy load with an
in-memory cache, initial-state seeding, and validated persistence. It
runs only the `onStart` hook (versioned schema init under its own
`cf_agents:state_schema_version` key) and reaches Lifecycle only for
storage — no alarm, no request path. It never touches connections.

Host-owned behavior is injected, not moved: `validateStateChange`
stays an overridable `Agent` method, while `initialState` and the
post-change `onChanged` hook are passed into `StateManager`. Synchronous and
asynchronous notification hooks are both supported. Broadcast
and the notification hook stay on `Agent`, and the `onMessage` state
branch stays too; only its inner write delegates to the capability.

The `cf_agents_state` table is shared: `StateManager` ensures it in
`onStart` and owns the state row, while `Agent` keeps its global
schema-version row in `_ensureSchema` and ensures the table there too
— each side idempotent, each tracking its own version, the same
pattern as Scheduler's `ensureScheduleTable`.

`Agent`'s public API and wire protocol are unchanged: `state`,
`setState()`, `onStateChanged`, and the `CF_AGENT_STATE` frames behave
identically.
