# PartyServer provenance

This package was vendored from
[`cloudflare/partykit`](https://github.com/cloudflare/partykit/tree/f0a2e97d233f24545b2648aec2ed6a191e11074e/packages/partyserver/src)
at commit
[`f0a2e97d233f24545b2648aec2ed6a191e11074e`](https://github.com/cloudflare/partykit/commit/f0a2e97d233f24545b2648aec2ed6a191e11074e),
the latest upstream commit when vendoring began. That tree contains
`partyserver@0.5.10`.

PartyServer is licensed under the ISC license. The original copyright and
license text are preserved in [`LICENSE`](./LICENSE),
[`../../licenses/isc-partyserver.txt`](../../licenses/isc-partyserver.txt), and
the repository's root `NOTICE` and `THIRD_PARTY_LICENSES.md` files.

## Local changes

Keep this list current when the vendored implementation diverges from the
upstream commit.

- The vendored `Server` drives `DurableObjectLifecycle` startup, request,
  alarm, and explicit-disposal phases around its existing callbacks.
- Named Durable Objects no longer duplicate `ctx.id.name` into `__ps_name`.
  Legacy reads, raw-ID `setName()` bootstrap writes, and the deprecated
  `x-partykit-room` fallback remain for backward compatibility. This follows
  the validated direction of
  [cloudflare/partykit#413](https://github.com/cloudflare/partykit/pull/413).
- Workers Types v5 compatibility uses `WebSocket.OPEN`, an explicit connection
  iterator loop, a metadata-safe Request clone boundary, and an `Event`-typed
  WebSocket error listener.
- Package metadata, build scripts, TypeScript configuration, and tests follow
  this repository's workspace conventions and compatibility date.
