---
"agents": minor
---

Move agent state into the opt-in `State` Lifecycle capability.

State was one method doing four jobs inside `Agent` — validate,
persist, broadcast, notify. It moves wholesale into a `State`
capability that owns storage and change ordering, so any Lifecycle
host gets durable, validated state without inheriting `Agent`:

```ts
new State({
  initialState: { count: 0 },
  validateStateChange: (next, source) => validate(next, source),
  onChanged: (state, source) => notify(state, source)
});
```

The capability owns the `cf_agents_state` state row, lazy load with an
in-memory cache, initial-state seeding, and validated persistence. It
runs only the `onStart` hook (versioned schema init under its own
`cf_agents:state_schema_version` key) and reaches Lifecycle only for
`storage` — no alarm, no request path. It never touches connections.

Host-owned behavior is injected, not moved: `validateStateChange`
stays an overridable `Agent` method and the post-change `onChanged`
hook is passed into `State` as a plain option. Synchronous and
asynchronous notification hooks are both supported. `Agent` keeps its
`initialState` field and seeds it from the `state` getter (standalone
hosts pass `initialState` to `State` directly). Broadcast and the
notification hook stay on `Agent`, and the `onMessage` state branch
stays too; only its inner write delegates to the capability.

`State` is the only owner of `cf_agents_state`: it creates the table,
holds the state row, and runs the legacy `cf_state_was_changed`
cleanup in its own versioned migration. `Agent` used to keep its
global schema version as a row in that table; it now lives under the
`cf_agents:schema_version` KV key like every other capability's
version. A DO created under the old layout has the row read once,
moved to the key, and deleted on its next construction.

`Agent`'s public API and wire protocol are unchanged: `state`,
`setState()`, `onStateChanged`, and the `CF_AGENT_STATE` frames behave
identically.
