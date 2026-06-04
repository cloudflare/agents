# issue-1677-minimal — raw workerd facet + WebSocket repro

Dependency-free reproduction of #1677
(`Cannot perform I/O on behalf of a different Durable Object … (I/O type: Native)`).
**No `agents` dependency** — just `cloudflare:workers` Durable Objects + facets.
This is the tightest, pure-workerd artifact for the runtime team.

## The bug in one sentence

On a **facet**, `this.ctx.getWebSockets()` returns the **host (parent) DO's**
hibernatable WebSockets, and reading `readyState` on one of those host-owned
sockets from the facet's I/O context aborts with `Cannot perform I/O … (Native)`.

## ⚠️ Production only — does NOT reproduce in local dev

This bug **only manifests on deployed Workers**. The divergence is in what a
facet's `ctx.getWebSockets()` returns:

| environment                          | facet `getWebSockets()` (parent socket held) | `/spawn` result           |
| ------------------------------------ | -------------------------------------------- | ------------------------- |
| **local** (`wrangler dev`/miniflare) | `[]` — `count=0` (host sockets not exposed)  | **200**, no crash         |
| **production** (deployed)            | the host's socket — `count=1`                | **500**, Native I/O abort |

So in `wrangler dev` the facet never sees the parent's sockets, there is nothing
to read `readyState` on, and everything returns `200` — the bug is invisible
locally. You **must deploy** to reproduce. (Both behaviors verified empirically
against this repro.)

## Exactly which call throws (isolated)

With the parent holding a live WebSocket, from inside the `Child` facet:

| operation on a host-owned socket                              | result                  |
| ------------------------------------------------------------- | ----------------------- |
| `ctx.getWebSockets()` (returns the host's sockets, count = 1) | ok                      |
| `ws.deserializeAttachment()`                                  | ok                      |
| **`ws.readyState`**                                           | **throws (Native I/O)** |

`getWebSockets()` and `deserializeAttachment()` are fine; only `readyState` (a
native getter) trips workerd's cross-DO ownership check.

## Trigger (remove any → clean 200)

1. The `Parent` DO holds a live (hibernatable) WebSocket (`ctx.acceptWebSocket`).
2. The `Child` **facet** is **freshly bootstrapped while the parent already
   holds that socket** — a facet bootstrapped earlier sees `[]` from
   `getWebSockets()`, so reuse does NOT reproduce (each `/spawn` uses a fresh
   facet name for this reason).
3. The facet reads `readyState` on the parent's socket via
   `this.ctx.getWebSockets()`.

(Production only — see the section above for local-dev behavior.)

## Run

```bash
npx wrangler deploy --config wip/issue-1677-minimal/wrangler.jsonc
```

```bash
node -e '
const BASE="https://<worker>.<subdomain>.workers.dev", WS=BASE.replace("https://","wss://");
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const spawn=(p)=>fetch(`${BASE}/spawn?parent=${p}`).then(r=>r.status);
(async()=>{
  // baseline: parent has no socket -> facet sees 0 sockets -> 200
  console.log("no socket:", await spawn("p-"+Date.now()));
  // hold a parent socket open, then bootstrap a facet that reads readyState
  const p="p-"+crypto.randomUUID().slice(0,8);
  const ws=new WebSocket(`${WS}/ws?parent=${p}`);
  ws.onopen=async()=>{ await sleep(1200); console.log("with socket:", await spawn(p)); process.exit(0); };
})();'
```

Expected:

```
no socket:  200   (count=0 readyStates=[])
with socket: 500  (Cannot perform I/O … Native)
```

## Relationship to the Agents SDK (#1677)

The Agents SDK hit this because a facet sub-agent's `getConnections()` fell
through to `super.getConnections()` → `ctx.getWebSockets()`, and the connection
machinery reads `readyState`. `setState()`/`broadcast()` reached it via
`_broadcastProtocol()`, which enumerates connections before sending. Fixed in
`packages/agents/src/index.ts` (a facet now returns only its virtual sub-agent
connections and never touches the host DO's sockets); see the changeset
`facet-getconnections-cross-do-io.md`.
