# Issue 1410 Production Repro

This is a repo-local copy of the reporter's minimal public repro for
https://github.com/cloudflare/agents/issues/1410, based on
https://github.com/Gyges-Labs/cf-agents-1410-repro at commit
`807198c7664567c630b68fbd2651264360ac8dcb`.

It exists for two purposes:

- Reproduce the production-only failure where `subAgent()` throws a workerd
  Native cross-DO I/O error when called from a parent Agent WebSocket
  `onMessage()` turn.
- Provide a small fixture for validating the SDK mitigation and for filing a
  workerd local/prod parity issue.

## Shape

- `ParentAgent extends Agent`
- `ChildAgent extends Agent`
- `GET /http-spawn` calls `parent.spawnChild()` over HTTP/RPC as the control
  path.
- `WS /ws` calls the same `spawnChild()` from `ParentAgent.onMessage()`.
- The worker uses `compatibility_date = "2026-04-01"` and
  `compatibility_flags = ["nodejs_compat"]`.
- `ParentAgent` is bound as a top-level Durable Object. `ChildAgent` is only
  listed in `new_sqlite_classes` and is reached as a facet/sub-agent.

## Commands

Run locally from the repository root:

```bash
npx wrangler dev --config wip/issue-1410-reporter-repro/wrangler.jsonc
```

Deploy from the repository root:

```bash
npx wrangler deploy --config wip/issue-1410-reporter-repro/wrangler.jsonc
```

Check the HTTP control path. This path should succeed both locally and in
production:

```bash
curl "https://<your-worker>.<your-subdomain>.workers.dev/http-spawn?parent=http-control-$(date +%s)"
```

Check the WebSocket path:

```bash
node -e '
const ws = new WebSocket("wss://<your-worker>.<your-subdomain>.workers.dev/ws?parent=ws-repro-" + Date.now());
ws.onmessage = (event) => console.log(event.data);
ws.onopen = () => ws.send("spawn child from websocket onMessage");
setTimeout(() => ws.close(), 10_000);
'
```

## Observed Failure Before The SDK Fix

Local `wrangler dev` did not reproduce the failure. Deployed Workers did.

The HTTP control path returned `ok: true`.

The WebSocket path returned `ok: false` inside the `after-subAgent` payload:

```text
Cannot perform I/O on behalf of a different Durable Object. I/O objects
(such as streams, request/response bodies, and others) created in the context
of one Durable Object cannot be accessed from a different Durable Object in
the same isolate. ... (I/O type: Native)
```

The stack pointed at:

```text
ParentAgent._cf_resolveSubAgent
ParentAgent.subAgent
ParentAgent.spawnChild
ParentAgent.onMessage
ParentAgent._tryCatch
```

Additional diagnostics showed:

- The child facet could read `this.ctx.id.name`.
- The child facet could read `this.name`.
- The child facet could write to its own storage before `super._cf_initAsFacet()`.
- The failure occurred during `__unsafe_ensureInitialized()`.
- Inside Agent startup, `broadcastMcpServers()` called `_broadcastProtocol()`,
  which enumerated/sent through WebSocket connections. In production, when the
  child facet was spawned during the parent WebSocket message turn, that touched
  a parent-owned Native WebSocket handle from the child DO context.

## SDK Mitigation

The SDK fix validated against this deployed repro:

- Clear native `connection`, `request`, and `email` context fields when crossing
  Agent instances and during internal facet bootstrap.
- Suppress protocol broadcasts only during facet bootstrap, so child startup
  cannot enumerate or send through parent-owned WebSocket handles while normal
  post-bootstrap state sync to the facet's own WebSocket clients still works.

With the fix, both `/http-spawn` and `/ws` return `ok: true` in production.

## Workerd Follow-Up

The SDK should keep the mitigation because facets should not inherit or touch
parent connection handles during startup.

The runtime issue to file is about parity and isolation:

- Local `wrangler dev` did not reproduce the production Native I/O error.
- Production workerd exposed/rejected parent-owned WebSocket Native I/O during
  child facet initialization.
- Facet startup should either be isolated from parent WebSocket handles or local
  development should reproduce the same rejection as production.
