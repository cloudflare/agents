# AGENTS.md — packages/partyserver

PartyServer is the Durable Object lifecycle substrate used by `agents`. It is
published as the existing `partyserver` npm package and re-exported from
`agents/lifecycle`.

## Provenance

`UPSTREAM.md` records the exact `cloudflare/partykit` commit initially vendored
into this repository and every intentional local divergence. Keep it current.
The original ISC license must remain in `LICENSE` and the root third-party
license records.

## Source

- `src/index.ts` — routing helpers and `Server` Durable Object base class
- `src/durable-object-lifecycle.ts` — ordered reusable component lifecycle
- `src/connection.ts` — hibernating and in-memory connection management
- `src/types.ts` — public connection types
- `src/transport-errors.ts` — WebSocket teardown error classification
- `src/tests/` — upstream compatibility tests plus lifecycle integration tests

## Commands

Run from this directory or with `pnpm --filter partyserver`:

```bash
pnpm build
pnpm test
pnpm test:compat
```

## Boundaries

- Preserve all existing PartyServer exports and runtime behavior unless a
  deliberate semver change is documented in a changeset.
- `Server` and PartyServer helper types are nominally significant. `Agent` and
  external callers must resolve the same package instance.
- For named Durable Objects, `ctx.id.name` is authoritative. Keep legacy
  `__ps_name`, `setName`, and `x-partykit-room` compatibility paths until an
  explicit major-version migration removes them.
- Components receive explicit dependencies. Do not introduce an Agent import or
  a hidden host registry into this package.
- The host owns physical alarm arbitration; lifecycle components only react to
  an alarm.
- `onDispose` is explicit cleanup, not an eviction hook. Workers provide no
  eviction callback.
