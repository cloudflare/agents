---
"agents": patch
---

Stream forwarded request bodies into sub-agents instead of buffering them in the parent Durable Object.

`Agent._cf_forwardToFacet` and `routeSubAgentRequest` both did `forwardInit.body = await req.arrayBuffer()` before dispatching to a child facet, materialising the entire request body in the parent's isolate. Two consequences:

- The read sat **in front of** application-level validation. `Agent.fetch` returns before `onRequest` whenever the path matches `/sub/{class}/{name}`, so an app that carefully bounded request bodies in `onRequest` still had an unbounded read ahead of it — and no way to bound it itself.
- The cost was **per hop**. A nested `/sub/.../sub/...` address re-materialised the same bytes at every level.

Both call sites now pass `req.body` through as a stream. Measured on `wrangler dev --local` with a handler that never reads the body, peak RSS across the `workerd` processes for a single POST:

| Request body | facet route, before | facet route, after | canonical route (control) |
| ------------ | ------------------- | ------------------ | ------------------------- |
| 16 MB        | +75 MB              | +4 MB              | +2 MB                     |
| 64 MB        | +268 MB             | +4 MB              | +2 MB                     |
| 128 MB       | +546 MB             | +4 MB              | +2 MB                     |

This restores the behaviour from before #1443, which switched to an explicit `RequestInit` in order to set a header on WebSocket upgrades and re-attached the body with `arrayBuffer()` as a side effect. The `Upgrade` header handling from that fix is unchanged.

One behavioural note: backpressure now reaches the client. A child that returns without reading the body will cause the remainder of the upload to be cancelled, where previously the parent drained it in full. Existing handlers that require the complete upload must consume or stream `request.body` before returning.
