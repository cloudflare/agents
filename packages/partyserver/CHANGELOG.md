# partyflare

## 0.5.10

### Patch Changes

- [#417](https://github.com/cloudflare/partykit/pull/417) [`5ce45b7`](https://github.com/cloudflare/partykit/commit/5ce45b7df1e097e9b1f87ff547307de98af89184) Thanks [@threepointone](https://github.com/threepointone)! - Inherit hibernation settings when a Server subclass declares partial static options.

## 0.5.9

### Patch Changes

- [#415](https://github.com/cloudflare/partykit/pull/415) [`1eb112f`](https://github.com/cloudflare/partykit/commit/1eb112f376db2946a697f5101ec8978adbd815fa) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Allow `@cloudflare/workers-types` v5 as a peer dependency. PartyServer remains compatible with v4 while projects using Wrangler 4.108 and newer can install the v5 runtime types without a peer dependency conflict.

## 0.5.8

### Patch Changes

- [#407](https://github.com/cloudflare/partykit/pull/407) [`2be6104`](https://github.com/cloudflare/partykit/commit/2be61047ff6aff0a252bedfba8b0a3125960cf72) Thanks [@threepointone](https://github.com/threepointone)! - Encode the `x-partykit-props` header as base64 so props containing non-ASCII characters (e.g. accented names like "Usuário") no longer trigger workerd's "header value contains non-ASCII characters" warning, which would throw a `TypeError` in browser fetch implementations. The header is decoded back to the original Unicode payload on the server, and raw-JSON values from older callers are still accepted for backwards compatibility.

## 0.5.7

### Patch Changes

- [#405](https://github.com/cloudflare/partykit/pull/405) [`7dbf92c`](https://github.com/cloudflare/partykit/commit/7dbf92c32694e69d8fc57d73e5ce357fbcfd8f00) Thanks [@threepointone](https://github.com/threepointone)! - Accept non-hibernating WebSocket connections in half-open mode (`accept({ allowHalfOpen: true })`).

  On compatibility dates `>= 2026-04-07` the `web_socket_auto_reply_to_close` flag makes the runtime send a reciprocal Close frame and tear the socket down automatically. For a non-hibernating PartyServer (`hibernate: false`), the Durable Object sits on the server end of a connection that the runtime tunnels back to the client, so that auto-teardown could fire through an already-severed tunnel — surfacing as a spurious retryable `Network connection lost.` rejection (for example when a Durable Object is reset while a connection is still open). Half-open mode keeps PartyServer's existing close handling in control; it already reciprocates the peer's Close frame on every compatibility date, so client behavior is unchanged.

  Also in this release, two related WebSocket fixes that keep behavior consistent across all compatibility dates:
  - **Pin `binaryType` to `"arraybuffer"` for non-hibernating connections.** On compatibility dates `>= 2026-03-17` the `websocket_standard_binary_type` flag flips the default server-side `binaryType` from `"arraybuffer"` to `"blob"`, so binary frames arrived as `Blob` instead of `ArrayBuffer` on the in-memory path. PartyServer (and frameworks built on it, e.g. Cloudflare Agents) have always received `ArrayBuffer`, so it is now pinned back in `accept()`. This is a no-op on older dates and corrective on newer ones; the Hibernation API is unaffected (it always delivers `ArrayBuffer`).
  - **Stop reporting transport-teardown errors as `onError`.** A retryable `Network connection lost.` / `WebSocket peer disconnected` error that fires on an already closing/closed connection is the socket going away during the close handshake, not an application error. It is now suppressed when the connection is `CLOSING`/`CLOSED` (detected via the structured `retryable` flag, with a message fallback), so it no longer spams logs on abrupt client disconnects. Genuine mid-connection (`OPEN`) errors still reach `onError`.

## 0.5.6

### Patch Changes

- [#399](https://github.com/cloudflare/partykit/pull/399) [`f772382`](https://github.com/cloudflare/partykit/commit/f77238296054bbfa3368dd7c6f39296d8593f06b) Thanks [@threepointone](https://github.com/threepointone)! - Retry transient Durable Object routing errors from `routePartykitRequest` and `getServerByName`, and expose route-level retry configuration.

## 0.5.5

### Patch Changes

- [#394](https://github.com/cloudflare/partykit/pull/394) [`9a927a3`](https://github.com/cloudflare/partykit/commit/9a927a342f26a4c229d2f8fae6793d608c8d724c) Thanks [@threepointone](https://github.com/threepointone)! - Don't reciprocate the WebSocket close handshake when the runtime delivers a reserved close code (`1005`, `1006`, `1015`). These codes are synthesized by the runtime when the peer didn't actually send a Close frame — there is no handshake to complete. The earlier `0.5.4` change (`[#393](https://github.com/cloudflare/partykit/issues/393)`) normalized these to `1000` and tried to send a reciprocating Close frame anyway; in cross-isolate transports (notably WebSocket pairs that flow back through Durable Object RPC, e.g. Cloudflare Agents sub-agents) the reciprocation would succeed synchronously but schedule an outbound write on a transport whose peer was already gone. The runtime then rejected that write asynchronously with `Network connection lost`, escaping `closeQuietly`'s synchronous `try`/`catch` and surfacing as an unhandled promise rejection in tests and production logs. The fix is to skip the reciprocation for reserved codes — there's nothing to acknowledge to a peer that didn't speak. The narrow user-visible behavior change: a client that calls `ws.close()` with no code on compat dates `< 2026-04-07` (no auto-reply) will now observe a non-clean close instead of a clean `1000` close, because the framework no longer fabricates a reciprocation. Clients that pass an explicit close code are unaffected.

## 0.5.4

### Patch Changes

- [#391](https://github.com/cloudflare/partykit/pull/391) [`6273c96`](https://github.com/cloudflare/partykit/commit/6273c96ca1886d4ce2f5c710fdf2c407a827bb03) Thanks [@threepointone](https://github.com/threepointone)! - Persist a `__ps_name` fallback for name-based Durable Objects during initialization. This lets alarm handlers recover `this.name` even when firing on a stale on-disk alarm record that was scheduled by an older workerd version that didn't yet persist `name` into the alarm record. See cloudflare/partykit#390.

- [#393](https://github.com/cloudflare/partykit/pull/393) [`5335251`](https://github.com/cloudflare/partykit/commit/533525117ab7acbaebfa9b5c62e3821ce03be189) Thanks [@threepointone](https://github.com/threepointone)! - Complete the WebSocket close handshake when a client initiates the close. Previously, both the hibernating `webSocketClose` handler and the non-hibernating close-event listener forwarded to user `onClose` but never sent a reciprocal Close frame, leaving clients stuck in `CLOSING` until they timed out and reported `1006` (abnormal closure). The framework now reciprocates the peer's Close frame in a `finally` block on both paths — required by the Hibernation API on every compat date, and required by the standard `accept()` API on compat dates before `2026-04-07` (where the runtime's `web_socket_auto_reply_to_close` flag isn't yet active). Calling `close()` on an already-closed socket is a silent no-op, so user code that already calls `connection.close(...)` from `onClose` is unaffected. Reserved close codes (`1005`, `1006`, `1015`) are normalized to `1000` before reciprocation so they don't throw `InvalidAccessError`. See cloudflare/partykit#389.

## 0.5.3

### Patch Changes

- [#386](https://github.com/cloudflare/partykit/pull/386) [`8a3bc02`](https://github.com/cloudflare/partykit/commit/8a3bc02d805ab802dc80d4a2e14f2ee0d6ccda1a) Thanks [@threepointone](https://github.com/threepointone)! - Document and test the supported pattern for using PartyServer with [Durable Object Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/). No runtime behavior change.

  **Background.** Facets spawned via `ctx.facets.get(name, factory)` _without_ an explicit `id` in `FacetStartupOptions` inherit the parent DO's `ctx.id` — including `ctx.id.name`. PartyServer's `name` getter reads `ctx.id.name` straight through, so on an implicit-id facet `this.name` returns the _parent's_ name rather than the facet's logical name. This is a faithful reflection of the workerd contract, but it's almost never what framework authors expect.

  The fix is at the call site, not in PartyServer: pass `id: someBoundDONamespace.idFromName(facetName)` to `ctx.facets.get(...)`. The facet then gets its own native `ctx.id.name === facetName` and PartyServer's `name` getter does the right thing automatically. No `setName()` is required, no `__ps_name` storage record is written, and cold-wake recovery happens for free because the factory re-runs and `idFromName` is deterministic.

  This release adds:
  - **A "Using PartyServer with Durable Object Facets" section in the README** that walks through the recommended pattern with a code example, calls out the implicit-id footgun explicitly, and documents that plain-string `id` values are not a substitute for `idFromName(facetName)` (workerd treats string ids as `idFromString`-like, so the resulting facet has no `ctx.id.name`).
  - **`setName()` docstring updated** to clarify that facets are NOT a `setName()` use case — point to the explicit-`id` pattern instead. The original `setName()` `ctx.id.name` mismatch throw is preserved as a typo guard for the `idFromName` happy path.
  - **End-to-end facet test coverage** against the real workerd `ctx.facets.get(...)` API. A `FacetParent` / `FacetChild` fixture exercises both the implicit-id path (pinning the runtime contract that `this.name` returns the parent's name in that flow — i.e., behavior-as-documentation so framework authors are unsurprised) and the explicit-id path (recommended; verifies that all reasonable id-construction strategies work and that cold wake recovers without any storage record). Plain-string `id` is also tested; the test asserts it does NOT carry a name, pinning the contract so callers don't get tempted by the type signature.

  The runtime behavior of `Server` (the `name` getter, `setName()`, the legacy `__ps_name` hydrate inside `#ensureInitialized()`) is unchanged from 0.5.2.

## 0.5.2

### Patch Changes

- [#383](https://github.com/cloudflare/partykit/pull/383) [`fe030f6`](https://github.com/cloudflare/partykit/commit/fe030f62348c7556a57132a4d135a31e71ba21c1) Thanks [@threepointone](https://github.com/threepointone)! - `setName()` is now the sanctioned bootstrap API for non-`idFromName` DOs.

  When `ctx.id.name` is undefined (e.g. Cloudflare Agents facets, which are spawned via `ctx.facets.get(...)` rather than `idFromName()`), `setName(name)` now persists the name to the legacy `__ps_name` storage key in addition to stashing it in memory. This means cold-wake invocations of the DO recover the name through `#ensureInitialized()`'s legacy storage fallback without the framework having to reach into PartyServer's private storage layout.

  Frameworks that previously did:

  ```ts
  await this.ctx.storage.put("__ps_name", name);
  await this.__unsafe_ensureInitialized();
  ```

  can now do:

  ```ts
  await this.setName(name);
  ```

  Backward compatible:
  - For DOs addressed via `idFromName()` / `getByName()` (the happy path), `setName()` continues to NOT write storage — `ctx.id.name` is the source of truth and `setName()` is just a no-op-plus-onStart.
  - The pre-existing direct-storage-write pattern keeps working — the storage write becomes idempotent with what `setName()` would do.

  `setName()`'s `@deprecated` docblock has been clarified: it remains the supported API for framework-level bootstrap of non-`idFromName` DOs and for delivering initial `props` to `onStart()`. The deprecation only applies to redundant calls on DOs that were addressed via `idFromName()`.

## 0.5.1

### Patch Changes

- [#381](https://github.com/cloudflare/partykit/pull/381) [`0274658`](https://github.com/cloudflare/partykit/commit/027465890fe35366587e2e2b09005c4f04ce25f2) Thanks [@threepointone](https://github.com/threepointone)! - Fix: restore legacy `__ps_name` storage fallback for framework bootstrap patterns.

  0.5.0 moved the legacy storage hydrate into `alarm()` only, breaking Cloudflare Agents facets and any other framework that writes `__ps_name` directly before calling `__unsafe_ensureInitialized()`. Facet DOs are spawned via `ctx.facets.get(...)` rather than `idFromName()` and therefore have `ctx.id.name === undefined`; they relied on PartyServer reading the storage record back to populate `this.name` before `onStart()`.

  Changes:
  - Move the legacy `__ps_name` hydrate from `alarm()` into `#ensureInitialized()`, still gated on `!ctx.id.name && !#_name` so it costs nothing on the happy path (normal `idFromName()`/`getByName()` DOs skip the storage read entirely).
  - `Server.fetch()` now delegates to `#ensureInitialized()` for the hydrate instead of doing its own. The `x-partykit-room` header fallback remains as a last resort when neither `ctx.id.name` nor a legacy storage record is available.
  - `Server.alarm()` is simplified — it no longer needs its own hydrate call since `#ensureInitialized()` handles it.
  - `setName()`'s `@deprecated` docblock is softened to clarify that it remains appropriate for framework-level bootstrap of non-`idFromName` DOs (e.g. Agents facets), not just a deprecated compatibility shim.

## 0.5.0

### Minor Changes

- [#378](https://github.com/cloudflare/partykit/pull/378) [`f3ab44f`](https://github.com/cloudflare/partykit/commit/f3ab44f7c095a68df909911b2430eac9cf48229c) Thanks [@threepointone](https://github.com/threepointone)! - Use native `ctx.id.name` to populate `this.name`.

  Durable Objects now expose `ctx.id.name` on every entry point (constructor, fetch, alarm, hibernating websocket handlers) when the DO is addressed via `idFromName()`/`getByName()`. PartyServer now uses this as the primary source of `this.name`, which simplifies routing, eliminates storage writes, and makes `this.name` available inside the constructor.

  Changes in `partyserver`:
  - `this.name` resolves from `this.ctx.id.name`. The apologetic `workerd#2240` error message is gone.
  - `this.name` is now available **inside the constructor** and from class field initializers, not just after `setName()`/`fetch()` has run.
  - `routePartykitRequest` no longer issues a `setName()`/`_initAndFetch()` RPC before `fetch()`. The WebSocket path goes from 2 RPCs to 1; the HTTP path remains 1 RPC. Props, when supplied, are delivered to the DO via the `x-partykit-props` request header, set after `onBeforeConnect`/`onBeforeRequest` hooks run.
  - `getServerByName` continues to perform a single RPC to ensure `onStart()` has completed before returning, so user-defined RPC methods on the returned stub can rely on initialization being done. That RPC is now cheaper internally (no storage write; name is read from `ctx.id.name`).
  - `Server` no longer writes the `__ps_name` record to storage. Existing records remain on disk for backward compatibility and are only read inside `alarm()` as a fallback for alarms that were scheduled before 2026-03-15 (where `ctx.id.name` is not carried into the alarm handler — see the [Durable Objects ID docs](https://developers.cloudflare.com/durable-objects/api/id/#name)).
  - `setName()` and `_initAndFetch()` are marked `@deprecated`. They continue to work for backward compatibility. `setName(name)` now throws if `name` does not match `ctx.id.name`.
  - The `x-partykit-room` header is still accepted as a fallback when `ctx.id.name` is not available.
  - Error message when the name cannot be resolved has been rewritten to list the three real causes (unsupported addressing via `idFromString()`/`newUniqueId()`, runtime too old to expose `ctx.id.name`, or direct `stub.fetch()` without `routePartykitRequest`/`getServerByName`).
  - When reading `this.name` throws, it is because `ctx.id.name` is undefined and no legacy fallback has populated the name: the DO was addressed via `idFromString()` or `newUniqueId()` (both unsupported), the runtime is too old to expose `ctx.id.name`, or a pre-2026-03-15 alarm fired before the legacy storage fallback ran.

  Changes in all affected packages (`partyserver`, `partysub`, `partysync`, `y-partyserver`, `hono-party`):
  - `@cloudflare/workers-types` peer dependency bumped from `^4.20240729.0` to `^4.20260424.1`. The old range predates `ctx.id.name` in the type surface.

  Not supported: addressing PartyServer DOs via `idFromString()` or `newUniqueId()`. These paths return `ctx.id.name === undefined` inside the DO and will surface as a clear error from `this.name`. PartyServer has always assumed name-based addressing via `getServerByName` / `routePartykitRequest`; this release makes that assumption explicit.

## 0.4.1

### Patch Changes

- [#365](https://github.com/cloudflare/partykit/pull/365) [`3fba690`](https://github.com/cloudflare/partykit/commit/3fba6903ec67cf902841fdd8080139cb0c26ada8) Thanks [@threepointone](https://github.com/threepointone)! - Use RPC instead of HTTP headers to pass room name and props to Durable Objects, preventing sensitive information from appearing in logs.
  - `getServerByName` now calls `stub.setName()` via RPC instead of sending a dummy fetch request with headers.
  - `routePartykitRequest` uses a new internal `_initAndFetch` RPC method for HTTP requests (single round trip), and `setName` + `fetch` for WebSocket upgrades.
  - `setName` accepts an optional `props` parameter and short-circuits when the name is already set.
  - Removed the `/cdn-cgi/partyserver/set-name/` internal endpoint (no longer needed).

## 0.4.0

### Minor Changes

- [#360](https://github.com/cloudflare/partykit/pull/360) [`852e900`](https://github.com/cloudflare/partykit/commit/852e900bc89a6975b0a385bc5fbea1abe65157a1) Thanks [@threepointone](https://github.com/threepointone)! - Add `uri` property to `Connection` that captures the original WebSocket upgrade request URL

  `WebSocketPair` doesn't accept a URL parameter, so the originating URL was previously lost after the handshake. The `uri` is now persisted in the WebSocket attachment alongside `id` and `tags`, so it survives hibernation. Returns `null` for connections established before this change.

### Patch Changes

- [#358](https://github.com/cloudflare/partykit/pull/358) [`7172dd1`](https://github.com/cloudflare/partykit/commit/7172dd1bd59ad0f691a5fbaa72ecdda3a387a904) Thanks [@threepointone](https://github.com/threepointone)! - Add `configurable: true` to `id`, `tags`, and `socket` property descriptors in `createLazyConnection` to fix Vite HMR compatibility

  When using PartyServer with Vite's Cloudflare Workers dev mode, HMR reloads recreate the module-scoped `WeakSet` used to track wrapped sockets, while the underlying WebSocket instances survive. This caused `Object.defineProperties` to throw `TypeError: Cannot redefine property` on properties that were missing the `configurable` flag.

## 0.3.3

### Patch Changes

- [`4e315b4`](https://github.com/cloudflare/partykit/commit/4e315b45e1c8f8d60ccfd2c348a8401086f71e26) Thanks [@threepointone](https://github.com/threepointone)! - Add `__unsafe_ensureInitialized()` method to `Server` for frameworks that receive calls via native DO RPC, bypassing the standard fetch/alarm/webSocket entry points where name hydration and `onStart()` normally happen.

## 0.3.2

### Patch Changes

- [#352](https://github.com/cloudflare/partykit/pull/352) [`b033ae1`](https://github.com/cloudflare/partykit/commit/b033ae1132b105c81566440e94d5913c4772e5da) Thanks [@threepointone](https://github.com/threepointone)! - Remove default console.log/console.info calls from `onConnect` and `onMessage` base methods in `Server`

## 0.3.1

### Patch Changes

- [#343](https://github.com/cloudflare/partykit/pull/343) [`c59d33d`](https://github.com/cloudflare/partykit/commit/c59d33d3296983e94a51126cf5bdb650679bb002) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.3.0

### Minor Changes

- [#337](https://github.com/cloudflare/partykit/pull/337) [`67685b9`](https://github.com/cloudflare/partykit/commit/67685b92b01c0b541c530b9f6d5e9b0f730e186c) Thanks [@threepointone](https://github.com/threepointone)! - Persist `Server.name` to durable storage so it survives cold starts without an HTTP request. Fixes `this.name` throwing inside `onAlarm()` and scheduled callbacks (cloudflare/agents#933).

### Patch Changes

- [`eec6607`](https://github.com/cloudflare/partykit/commit/eec6607d99f36eda773d028ac365e42c36f99761) Thanks [@threepointone](https://github.com/threepointone)! - Switch name persistence from sync `ctx.storage.kv` to async `ctx.storage.get/put`, removing the requirement for SQLite-backed Durable Objects.

## 0.2.0

### Minor Changes

- [#327](https://github.com/cloudflare/partykit/pull/327) [`eef891a`](https://github.com/cloudflare/partykit/commit/eef891aae465d93b61b6ba36278115c41b3e1b11) Thanks [@threepointone](https://github.com/threepointone)! - Add `connection.tags` property to read back tags assigned via `getConnectionTags()`. Works in both hibernating and in-memory modes. Tags are validated and always include the connection id as the first tag.

### Patch Changes

- [#325](https://github.com/cloudflare/partykit/pull/325) [`c15e9d9`](https://github.com/cloudflare/partykit/commit/c15e9d9f85a7dbb9b640a46580d934b9b430a694) Thanks [@threepointone](https://github.com/threepointone)! - Add `lobby.className` to `onBeforeConnect`/`onBeforeRequest` callbacks, providing the Durable Object class name (e.g. `"MyAgent"`). The existing `lobby.party` field is now deprecated (it returns the kebab-case URL namespace) and will be changed to return the class name in the next major version.

## 0.1.5

### Patch Changes

- [#323](https://github.com/cloudflare/partykit/pull/323) [`353da20`](https://github.com/cloudflare/partykit/commit/353da207f8d31ef406374159ee345292616ec1ca) Thanks [@threepointone](https://github.com/threepointone)! - Fix initialization race conditions and improve error resilience.
  - `getServerByName` now propagates errors from the internal `set-name` request instead of silently swallowing them.
  - `onStart` failures no longer permanently brick the Durable Object. Errors are caught inside `blockConcurrencyWhile` (preserving the input gate) and the status is reset, allowing subsequent requests to retry initialization.
  - `fetch()` now retries initialization when a previous `onStart` attempt failed, instead of skipping it because the name was already set.
  - Errors in `fetch()` (including `onStart` failures and malformed props) are now caught and returned as proper 500 responses instead of crashing as unhandled exceptions.
  - WebSocket handlers (`webSocketMessage`, `webSocketClose`, `webSocketError`) are now wrapped in try/catch so that transient `onStart` failures don't kill the connection — the next message will retry.

## 0.1.4

### Patch Changes

- [#320](https://github.com/cloudflare/partykit/pull/320) [`9bd3f56`](https://github.com/cloudflare/partykit/commit/9bd3f5672eea27cb259f77fb3cf2444da5921803) Thanks [@threepointone](https://github.com/threepointone)! - Add CORS support to `routePartykitRequest`.

  Pass `cors: true` for permissive defaults or `cors: { ...headers }` for custom CORS headers. Preflight (OPTIONS) requests are handled automatically for matched routes, and CORS headers are appended to all non-WebSocket responses — including responses returned by `onBeforeRequest`.

- [#260](https://github.com/cloudflare/partykit/pull/260) [`84fe996`](https://github.com/cloudflare/partykit/commit/84fe9965cecbff3cf4f2f280c27d8f2d88909613) Thanks [@BlankParticle](https://github.com/BlankParticle)! - remove redundant initialize code as setName takes care of it, along with the nested blockConcurrencyWhile call

## 0.1.3

### Patch Changes

- [#319](https://github.com/cloudflare/partykit/pull/319) [`15a4157`](https://github.com/cloudflare/partykit/commit/15a41572a778526b496de94d5ef0909226c56e72) Thanks [@threepointone](https://github.com/threepointone)! - Add `configurable: true` to the `state`, `setState`, `serializeAttachment`, and `deserializeAttachment` property descriptors on connection objects. This allows downstream consumers (like the Cloudflare Agents SDK) to redefine these properties with `Object.defineProperty` for namespacing or wrapping internal state storage. Default behavior is unchanged.

## 0.1.2

### Patch Changes

- [`d73d17c`](https://github.com/cloudflare/partykit/commit/d73d17cb5d3b20f27a3d75b62760d5df08e5c3d5) Thanks [@threepointone](https://github.com/threepointone)! - make hibernate optional in options

## 0.1.1

### Patch Changes

- [#312](https://github.com/cloudflare/partykit/pull/312) [`a936079`](https://github.com/cloudflare/partykit/commit/a936079c1fc045301d55061b872236ed8189506d) Thanks [@francescov1](https://github.com/francescov1)! - Check for hibernated websocket connections

## 0.1.0

### Minor Changes

- [#302](https://github.com/cloudflare/partykit/pull/302) [`88474b1`](https://github.com/cloudflare/partykit/commit/88474b1fda322b13aebd543ea4a0638ae87aad32) Thanks [@threepointone](https://github.com/threepointone)! - change Env types to default to Cloudflare.Env

### Patch Changes

- [`3ec313e`](https://github.com/cloudflare/partykit/commit/3ec313ee4d737cbc33be3621178f002435f2fa2b) Thanks [@threepointone](https://github.com/threepointone)! - don't throw when a request doesn't match a namespace

## 0.0.78

### Patch Changes

- [`7360225`](https://github.com/cloudflare/partykit/commit/7360225fc92978f38edce71f54afb84b25b7bdcb) Thanks [@threepointone](https://github.com/threepointone)! - fix publishes

## 0.0.77

### Patch Changes

- [#298](https://github.com/cloudflare/partykit/pull/298) [`43bd6cc`](https://github.com/cloudflare/partykit/commit/43bd6ccbf7a94484b1f377c3df0cf26ce8792669) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.76

### Patch Changes

- [#296](https://github.com/cloudflare/partykit/pull/296) [`3a48ec9`](https://github.com/cloudflare/partykit/commit/3a48ec97f64885fcd8860b1d9f228bb250789862) Thanks [@threepointone](https://github.com/threepointone)! - Add experimental waitUntil API for long-running tasks

  Introduces an internal keep-alive WebSocket endpoint and the experimental_waitUntil method to allow Durable Objects to remain alive while executing long-running async functions. This mechanism uses a self-connecting WebSocket with periodic pings and requires the 'enable_ctx_exports' compatibility flag. Additional handling is added to ignore keep-alive sockets in WebSocket event methods.

  Based on @eastlondoner's https://github.com/eastlondoner/better-wait-until

## 0.0.75

### Patch Changes

- [#280](https://github.com/cloudflare/partykit/pull/280) [`501370d`](https://github.com/cloudflare/partykit/commit/501370d4ed5976a073aa96f9eaeea23224053093) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.74

### Patch Changes

- [`537714c`](https://github.com/cloudflare/partykit/commit/537714c8a6d70abcac13710e357ce9a953c7d0d3) Thanks [@threepointone](https://github.com/threepointone)! - drain body on /set-name

## 0.0.73

### Patch Changes

- [`3014f9f`](https://github.com/cloudflare/partykit/commit/3014f9fdb00bcfa6b27f61aa18630c5ba7b3932c) Thanks [@threepointone](https://github.com/threepointone)! - Allow routing ctx props to Server

## 0.0.72

### Patch Changes

- [#246](https://github.com/cloudflare/partykit/pull/246) [`a462739`](https://github.com/cloudflare/partykit/commit/a4627392628058702dcbb8c5d5acbea35b95be09) Thanks [@threepointone](https://github.com/threepointone)! - add .sql helper

## 0.0.71

### Patch Changes

- [#221](https://github.com/cloudflare/partykit/pull/221) [`20a68a8`](https://github.com/cloudflare/partykit/commit/20a68a841ef67464a41b55d500114cec6a8c6a6e) Thanks [@threepointone](https://github.com/threepointone)! - add homepage in package.jsons

## 0.0.70

### Patch Changes

- [`3f900b5`](https://github.com/cloudflare/partykit/commit/3f900b5f631ea3f8b8a70197890d1d551be3951d) Thanks [@threepointone](https://github.com/threepointone)! - trigger another release

## 0.0.69

### Patch Changes

- [`b0bc59c`](https://github.com/cloudflare/partykit/commit/b0bc59c017484c02b4d9cb9313c92fb66b36941f) Thanks [@threepointone](https://github.com/threepointone)! - trigger a release

- [`7ec1568`](https://github.com/cloudflare/partykit/commit/7ec15680fd1dcb257263d52d2c9cd5088e2f7c0a) Thanks [@threepointone](https://github.com/threepointone)! - replace url in package.json to point to cloudflare/partykit

## 0.0.68

### Patch Changes

- [#217](https://github.com/threepointone/partyserver/pull/217) [`a5d2dde`](https://github.com/threepointone/partyserver/commit/a5d2dde164bd9d38e1bac87b2d32d24c06742d2f) Thanks [@threepointone](https://github.com/threepointone)! - await the call that sets a party's name inside getServerByName

## 0.0.67

### Patch Changes

- [#205](https://github.com/threepointone/partyserver/pull/205) [`b1baf6c`](https://github.com/threepointone/partyserver/commit/b1baf6cdda4c7684a4663a1281070ab1762670fd) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.66

### Patch Changes

- [#199](https://github.com/threepointone/partyserver/pull/199) [`c41057b`](https://github.com/threepointone/partyserver/commit/c41057ba5c738496bc7e2a4968357f1f5b65707b) Thanks [@threepointone](https://github.com/threepointone)! - convert UPPERCASE bindings to lowercase as expected

- [#199](https://github.com/threepointone/partyserver/pull/199) [`b3701a5`](https://github.com/threepointone/partyserver/commit/b3701a5f5eee278c96587d9e29e42992806733ac) Thanks [@threepointone](https://github.com/threepointone)! - allow for sub/path/like prefixes on the server

## 0.0.65

### Patch Changes

- [#181](https://github.com/threepointone/partyserver/pull/181) [`3e56cce`](https://github.com/threepointone/partyserver/commit/3e56cceca2c253d7b4368299e018b73af6deb42b) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.64

### Patch Changes

- [`a240942`](https://github.com/threepointone/partyserver/commit/a240942d20540d70fc0076edb779302e6d621c65) Thanks [@threepointone](https://github.com/threepointone)! - update deps, use vite for one fixture

## 0.0.63

### Patch Changes

- [#157](https://github.com/threepointone/partyserver/pull/157) [`7710635`](https://github.com/threepointone/partyserver/commit/7710635d7fd0ca68047d966e0d1640a9fd3c09bc) Thanks [@aulneau](https://github.com/aulneau)! - Extract and export PartyServerOptions interface for use in other packages.

## 0.0.62

### Patch Changes

- [`2e3a8b0`](https://github.com/threepointone/partyserver/commit/2e3a8b0fe7e701a505ddee54e4bd1e1215bf7c3e) Thanks [@threepointone](https://github.com/threepointone)! - fix readme

## 0.0.61

### Patch Changes

- [#152](https://github.com/threepointone/partyserver/pull/152) [`b1307d2`](https://github.com/threepointone/partyserver/commit/b1307d286272140bb905ae6315c9a69ecbd136c1) Thanks [@threepointone](https://github.com/threepointone)! - implement onBeforeConnect/onBeforeRequest

## 0.0.60

### Patch Changes

- [`ce768f7`](https://github.com/threepointone/partyserver/commit/ce768f757c881461d0e2c7f64dacc2685340c4fb) Thanks [@threepointone](https://github.com/threepointone)! - update dependencies

## 0.0.59

### Patch Changes

- [`b5acc8e`](https://github.com/threepointone/partyserver/commit/b5acc8ebd55830239d5188bb114b718019e850b1) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

## 0.0.58

### Patch Changes

- [#95](https://github.com/threepointone/partyserver/pull/95) [`071b3d6`](https://github.com/threepointone/partyserver/commit/071b3d6a0d00d9388880eaa8c1bbdf1ab812227a) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

## 0.0.57

### Patch Changes

- [#93](https://github.com/threepointone/partyserver/pull/93) [`d429303`](https://github.com/threepointone/partyserver/commit/d42930390514b0b60d9ef0da6337af754df5447e) Thanks [@third774](https://github.com/third774)! - Filter `.getConnections()` to only include ready connections when in non-hibernating mode

## 0.0.56

### Patch Changes

- [#88](https://github.com/threepointone/partyserver/pull/88) [`ec7a698`](https://github.com/threepointone/partyserver/commit/ec7a698510f1d4810db923656c7e6ab90cb83165) Thanks [@aryasaatvik](https://github.com/aryasaatvik)! - update @cloudflare/workers-types

## 0.0.55

### Patch Changes

- [`d58418c`](https://github.com/threepointone/partyserver/commit/d58418c5aeb1795b17ce2994b7ae51994abf428b) Thanks [@threepointone](https://github.com/threepointone)! - remove the scary warning from the readme

## 0.0.54

### Patch Changes

- [#85](https://github.com/threepointone/partyserver/pull/85) [`5a744fb`](https://github.com/threepointone/partyserver/commit/5a744fbdfd074fce49daaf6a3b8315a6f6588560) Thanks [@threepointone](https://github.com/threepointone)! - Update dependencies

## 0.0.53

### Patch Changes

- [#83](https://github.com/threepointone/partyserver/pull/83) [`ca4a8c5`](https://github.com/threepointone/partyserver/commit/ca4a8c57bc0f15e115ba19cefa52d4ba013ea901) Thanks [@threepointone](https://github.com/threepointone)! - fix: .name available in onStart, faster getServerByName

## 0.0.52

### Patch Changes

- [#81](https://github.com/threepointone/partyserver/pull/81) [`42e6502`](https://github.com/threepointone/partyserver/commit/42e65020dd96c424f98d19977739cef3d06ca3d4) Thanks [@threepointone](https://github.com/threepointone)! - implement onAlarm

## 0.0.51

### Patch Changes

- [`81b2511`](https://github.com/threepointone/partyserver/commit/81b2511e88a7f8d28ba8027a98ced813281bf784) Thanks [@threepointone](https://github.com/threepointone)! - fix readme

## 0.0.50

### Patch Changes

- [`c662425`](https://github.com/threepointone/partyserver/commit/c662425f24b7dcc1ae1f8dbf81def474ffad9261) Thanks [@threepointone](https://github.com/threepointone)! - use kebabcase when converting binding name to a party name

## 0.0.49

### Patch Changes

- [`af89974`](https://github.com/threepointone/partyserver/commit/af89974fea9bcd8d6bbbc31f5d308d9558885211) Thanks [@threepointone](https://github.com/threepointone)! - fix CI failure, run gen-ids tests, tweak warning on "main" party access

## 0.0.48

### Patch Changes

- [`2530531`](https://github.com/threepointone/partyserver/commit/25305313cd2e3901800232ce01e5a144075bb9e4) Thanks [@threepointone](https://github.com/threepointone)! - partyserver: update deps, author email

## 0.0.47

### Patch Changes

- [`6993aec`](https://github.com/threepointone/partyserver/commit/6993aece9de79d8855de8079d27bdebe4b96f3ce) Thanks [@threepointone](https://github.com/threepointone)! - partyserver: better docs

## 0.0.46

### Patch Changes

- [`528adea`](https://github.com/threepointone/partyserver/commit/528adeaced6dce6e888d2f54cc75c3569bf2c277) Thanks [@threepointone](https://github.com/threepointone)! - some fixes and tweaks
  - getServerByName was throwing on all requests
  - `Env` is now an optional arg when defining `Server`
  - `y-partyserver/provider` can now take an optional `prefix` arg to use a custom url to connect
  - `routePartyKitRequest`/`getServerByName` now accepts `jurisdiction`

  bonus:
  - added a bunch of fixtures
  - added stubs for docs

## 0.0.45

### Patch Changes

- [#62](https://github.com/threepointone/partyserver/pull/62) [`f9a0047`](https://github.com/threepointone/partyserver/commit/f9a0047fbcb561a20c9cf001c9808023d0b60288) Thanks [@threepointone](https://github.com/threepointone)! - close connection if sending broadcast message fails

- [#60](https://github.com/threepointone/partyserver/pull/60) [`50883c9`](https://github.com/threepointone/partyserver/commit/50883c9e3715e3a54806d2ba0c514d72bf9fb5d3) Thanks [@threepointone](https://github.com/threepointone)! - feat: catch errors in DO's fetch

  Catch errors in a DO's fetch. Basic.
  We log the error stack right now which isn't a great thing, we'll revisit that later.

## 0.0.44

### Patch Changes

- [`cb884ea`](https://github.com/threepointone/partyserver/commit/cb884ea811e4dcbb2d3056c0c4077b13adc59e21) Thanks [@threepointone](https://github.com/threepointone)! - don't fail when string bindings are in env

## 0.0.43

### Patch Changes

- [`6edd35e`](https://github.com/threepointone/partyserver/commit/6edd35e3f489d047867d3f8097b54566882a9173) Thanks [@threepointone](https://github.com/threepointone)! - A better error when trying to read .name before it's set

## 0.0.42

### Patch Changes

- [`ba68c03`](https://github.com/threepointone/partyserver/commit/ba68c036dc7edf4b7ae355e5570c6831a064a98c) Thanks [@threepointone](https://github.com/threepointone)! - fix: workaround for https://github.com/cloudflare/workerd/issues/2240

  While waiting for https://github.com/cloudflare/workerd/issues/2240 to be fixed, let's instead send the namespace/room name ahead in the first request. This should be fine for all our websocket usecases for now

## 0.0.41

### Patch Changes

- [`fa89266`](https://github.com/threepointone/partyserver/commit/fa89266ccc817a43e0a0274646a9f7265bf46320) Thanks [@threepointone](https://github.com/threepointone)! - update deps

## 0.0.40

### Patch Changes

- [`b54093e`](https://github.com/threepointone/partyserver/commit/b54093e9964ddf2457e9204d809f243c8b5ad808) Thanks [@threepointone](https://github.com/threepointone)! - nope

## 0.0.39

### Patch Changes

- [`2a254db`](https://github.com/threepointone/partyserver/commit/2a254dba427aa509c2fddc26be0ef3bbec881afc) Thanks [@threepointone](https://github.com/threepointone)! - trigger build

## 0.0.38

### Patch Changes

- [`74d7911`](https://github.com/threepointone/partyserver/commit/74d7911174dbb5f0a9a6f6925e9c615a19dbed74) Thanks [@threepointone](https://github.com/threepointone)! - s/Server.partyFetch/routePartyKitRequest

## 0.0.37

### Patch Changes

- [`5b91153`](https://github.com/threepointone/partyserver/commit/5b91153bceef64079eb5e3d86900fa916fbf2cf5) Thanks [@threepointone](https://github.com/threepointone)! - try another release

## 0.0.36

### Patch Changes

- [`eb347bc`](https://github.com/threepointone/partyserver/commit/eb347bc1da9bf4c1a6499b716ab4b33050afec00) Thanks [@threepointone](https://github.com/threepointone)! - trigger a build

## 0.0.35

### Patch Changes

- [`ecec09d`](https://github.com/threepointone/partyserver/commit/ecec09dc329eeeb8789c969135812f7d55e9b8cb) Thanks [@threepointone](https://github.com/threepointone)! - use ts for workflow scripts, add y-partyserver to version-script

## 0.0.34

### Patch Changes

- [`c480e92`](https://github.com/threepointone/partyserver/commit/c480e925647c3634d7ae50232fcdddf3dd7e4ad4) Thanks [@threepointone](https://github.com/threepointone)! - use blockConcurrencyWhile for onStart

## 0.0.33

### Patch Changes

- [`edb1a5a`](https://github.com/threepointone/partyserver/commit/edb1a5a461f58c3aacf240b75fbc7bc7a13db3b3) Thanks [@threepointone](https://github.com/threepointone)! - trigger a release

## 0.0.32

### Patch Changes

- [`41927c4`](https://github.com/threepointone/partyflare/commit/41927c43e032db30adb186787e5838df2005f08f) Thanks [@threepointone](https://github.com/threepointone)! - avoid string drama

## 0.0.31

### Patch Changes

- [`f877021`](https://github.com/threepointone/partyflare/commit/f8770218e04f93a45a81d182f6f4d89aaa4ac6b2) Thanks [@threepointone](https://github.com/threepointone)! - configurable prefix for .partyFetch

## 0.0.30

### Patch Changes

- [`96d153c`](https://github.com/threepointone/partyflare/commit/96d153c090d2c5ffde5c7fa2196c46136304ee85) Thanks [@threepointone](https://github.com/threepointone)! - bump

## 0.0.29

### Patch Changes

- [`df3f51a`](https://github.com/threepointone/partyflare/commit/df3f51a18ffbe0599090db870fe77e97c81fc80d) Thanks [@threepointone](https://github.com/threepointone)! - add some more docs

## 0.0.28

### Patch Changes

- [`d1da6d7`](https://github.com/threepointone/partyflare/commit/d1da6d74b16f3905ba9797f471de53d237f855b9) Thanks [@threepointone](https://github.com/threepointone)! - fix: rehydrate server name on websocket based hydration

## 0.0.27

### Patch Changes

- [`246ccc5`](https://github.com/threepointone/partyflare/commit/246ccc51a00e9fdfe8767a0793aa4221550fa49f) Thanks [@threepointone](https://github.com/threepointone)! - more doc stuff

## 0.0.26

### Patch Changes

- [`5494f87`](https://github.com/threepointone/partyflare/commit/5494f870bfbb1c102359fcfb383750b0b08828bd) Thanks [@threepointone](https://github.com/threepointone)! - s/Server.withName/getServerByName, s/Server.fetchServerForRequest/Server.partyFetch

## 0.0.25

### Patch Changes

- [`4010235`](https://github.com/threepointone/partyflare/commit/4010235412711aa08511f7115611544a62a737c0) Thanks [@threepointone](https://github.com/threepointone)! - rename a bunch of things
  - Party -> Server
  - .room -> .name
  - withRoom -> withName
  - fetchRoomForRequest -> fetchServerForRequest

## 0.0.24

### Patch Changes

- [`5126257`](https://github.com/threepointone/partyflare/commit/51262570bc94456651abd5a5b17056204bc0052a) Thanks [@threepointone](https://github.com/threepointone)! - tweak some more warnings

## 0.0.23

### Patch Changes

- [`3e33acf`](https://github.com/threepointone/partyflare/commit/3e33acfe34ed42622ade605899a576b4b2ce0ba2) Thanks [@threepointone](https://github.com/threepointone)! - chatgpt readme

## 0.0.22

### Patch Changes

- [`569fa76`](https://github.com/threepointone/partyflare/commit/569fa7648f82f6f80b4b5b701eff1e95e04ebd95) Thanks [@threepointone](https://github.com/threepointone)! - more stuff in readme

## 0.0.21

### Patch Changes

- [`f328fcb`](https://github.com/threepointone/partyflare/commit/f328fcba8bbd541fa12af08bbbd6d99c9b815fdb) Thanks [@threepointone](https://github.com/threepointone)! - tweak some error messages

## 0.0.20

### Patch Changes

- [`1e61151`](https://github.com/threepointone/partyflare/commit/1e6115113667e1c6e78fbbf01a22d1e2a95d6a37) Thanks [@threepointone](https://github.com/threepointone)! - tighter deps

- [`48ed3df`](https://github.com/threepointone/partyflare/commit/48ed3dfde6bf03055c2f8df371a4560bc78dbaeb) Thanks [@threepointone](https://github.com/threepointone)! - nanoid should be a regular dep

## 0.0.19

### Patch Changes

- [`1be87b0`](https://github.com/threepointone/partyflare/commit/1be87b022f7daa1d8337bc7bae3b7d43d927c04d) Thanks [@threepointone](https://github.com/threepointone)! - remove legacy\_ methods

- [`32f8b08`](https://github.com/threepointone/partyflare/commit/32f8b084eb1f37583e5627fc875dc54589a8f31d) Thanks [@threepointone](https://github.com/threepointone)! - add locationHint, make remix work inside a party, add a workaround for the ordering issue, adds loggin for some unimplemented methods

## 0.0.18

### Patch Changes

- [`b519e51`](https://github.com/threepointone/partyflare/commit/b519e51d747bad1925db28c27709ebb9e30f9e77) Thanks [@threepointone](https://github.com/threepointone)! - s/ Party.match/Party.fetchRoomForRequest

## 0.0.17

### Patch Changes

- [`6e253c8`](https://github.com/threepointone/partyflare/commit/6e253c84f83ac9ce9e26d980606d8edbcbecdb58) Thanks [@threepointone](https://github.com/threepointone)! - Update package.json details

## 0.0.16

### Patch Changes

- [`bc6711e`](https://github.com/threepointone/partyflare/commit/bc6711ea2ea1e410bb57b591eb77fd01cfc7bdd8) Thanks [@threepointone](https://github.com/threepointone)! - Decouples URL and Party identity, Introduce Party.withRoom().

## 0.0.15

### Patch Changes

- [`fdbf419`](https://github.com/threepointone/partyflare/commit/fdbf4196e5e36e249480f337c32ce89fe672cfda) Thanks [@threepointone](https://github.com/threepointone)! - mark public/private methods, add some inline docs

## 0.0.14

### Patch Changes

- [`cf62851`](https://github.com/threepointone/partyflare/commit/cf62851789cf164c1f707e377238d45f35f11b08) Thanks [@threepointone](https://github.com/threepointone)! - Add docs for other methods

## 0.0.13

### Patch Changes

- [`054ff57`](https://github.com/threepointone/partyflare/commit/054ff570fe86fc034cc93c0ade2ba0a267b1ee40) Thanks [@threepointone](https://github.com/threepointone)! - strict lints

## 0.0.12

### Patch Changes

- [`6f52478`](https://github.com/threepointone/partyflare/commit/6f52478d1f52e2c904663324457a36482a21c1fe) Thanks [@threepointone](https://github.com/threepointone)! - call onStart only once

## 0.0.11

### Patch Changes

- [`c6f3dfe`](https://github.com/threepointone/partyflare/commit/c6f3dfefaf58bd4938ab3eab9400c9ae66576260) Thanks [@threepointone](https://github.com/threepointone)! - actually share repo url

## 0.0.10

### Patch Changes

- [`4189013`](https://github.com/threepointone/partyflare/commit/4189013b2151354fbe99dced3c853e2a41437098) Thanks [@threepointone](https://github.com/threepointone)! - Fix default URL parsing

## 0.0.9

### Patch Changes

- [`5c97caf`](https://github.com/threepointone/partyflare/commit/5c97cafd88004b20d44b07118fa8616cc9d7a8fe) Thanks [@threepointone](https://github.com/threepointone)! - Better errors when onRequest hasn't been implemented or connection.room isn't available

## 0.0.8

### Patch Changes

- [`c1b8460`](https://github.com/threepointone/partyflare/commit/c1b846009e5f41caa9a00b4f16c36b96bc8ed9b8) Thanks [@threepointone](https://github.com/threepointone)! - Add proper repo to package.json

## 0.0.7

### Patch Changes

- [`24f08ce`](https://github.com/threepointone/partyflare/commit/24f08ce8fb4854d2793c4c3bff267b0a107ef956) Thanks [@threepointone](https://github.com/threepointone)! - Test changeset release

## 0.0.6

### Patch Changes

- [`64be210`](https://github.com/threepointone/partyflare/commit/64be210f388866ec6bb63920c05fda4507dab7a9) Thanks [@threepointone](https://github.com/threepointone)! - Add a note about hibernation

## 0.0.5

### Patch Changes

- [`7f86d79`](https://github.com/threepointone/partyflare/commit/7f86d79daf2a3305682f1f64214d60d9d7f4da14) Thanks [@threepointone](https://github.com/threepointone)! - s/this.id/this.room, added some docs

## 0.0.4

### Patch Changes

- [#3](https://github.com/threepointone/partyflare/pull/3) [`3ee6b5c`](https://github.com/threepointone/partyflare/commit/3ee6b5c608c37bef888a8c7714a3255984644814) Thanks [@threepointone](https://github.com/threepointone)! - fix url parsing

## 0.0.3

### Patch Changes

- [#1](https://github.com/threepointone/partyflare/pull/1) [`e38f6ab`](https://github.com/threepointone/partyflare/commit/e38f6ab4ebaa689c3d900c5cf5eb45a57992dca7) Thanks [@threepointone](https://github.com/threepointone)! - fix builds
