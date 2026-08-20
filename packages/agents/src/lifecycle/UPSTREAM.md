# Lifecycle substrate provenance

The Durable Object routing and WebSocket substrate in this directory was
initially vendored from
[`cloudflare/partykit@f0a2e97d233f24545b2648aec2ed6a191e11074e`](https://github.com/cloudflare/partykit/commit/f0a2e97d233f24545b2648aec2ed6a191e11074e),
which contains `partyserver@0.5.10`.

PartyServer is ISC licensed. Its copyright and license text are preserved in
[`../../../../licenses/isc-partyserver.txt`](../../../../licenses/isc-partyserver.txt),
the repository `NOTICE`, and `THIRD_PARTY_LICENSES.md`.

## Intentional divergences

- The code is part of `agents/lifecycle`; there is no separate `partyserver`
  package or second `Server` class.
- `DurableObjectLifecycle` is composed with a class that directly extends the
  platform `DurableObject`. `DurableObjectLifecycle.install(this)` constructs
  and installs fetch, alarm, and hibernating WebSocket entry points; an expanded
  `new ...` plus `installHandlers()` form is also available.
- WebSocket hibernation is mandatory. The in-memory connection-manager branch
  and its configuration option were removed.
- Native `ctx.id.name` is authoritative. Deprecated naming headers, bootstrap
  RPCs, and fallback writes were removed. Existing `__ps_name` records remain
  readable solely to migrate objects created by older releases.
- Deprecated route and connection fields were removed.
- Workers Types v5 compatibility uses `WebSocket.OPEN`, an explicit connection
  iterator, mutable `new Request(request)` copies, and Event-typed WebSocket
  error listeners.
