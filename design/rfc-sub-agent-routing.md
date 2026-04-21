# RFC: External addressability for sub-agents

Status: proposed

Related:

- [`rfc-think-multi-session.md`](./rfc-think-multi-session.md) — proposes a `Chats` base class + per-chat DOs. Depends on this primitive to make the composition story honest.
- [`rfc-ai-chat-maintenance.md`](./rfc-ai-chat-maintenance.md) — maintenance stance for `AIChatAgent`. Independent.
- **Spike**: [`packages/agents/src/tests/spike-sub-agent-routing.ts`](../packages/agents/src/tests/agents/spike-sub-agent-routing.ts) + [`spike-sub-agent-routing.test.ts`](../packages/agents/src/tests/spike-sub-agent-routing.test.ts) — confirms WS/HTTP work through the two-hop `fetch()` chain.

## Summary

Let a client reach a sub-agent (a facet created by `Agent#subAgent()`) directly over WebSocket or HTTP via a nested URL:

```
/agents/{parent-class}/{parent-name}/sub/{child-class}/{child-name}[/...]
```

Implemented by extending `routeAgentRequest`, with two new composable primitives for custom routing: `routeSubAgentRequest(req, parent)` (the sub-agent analog of `routeAgentRequest`) and `getSubAgentByName(parent, Cls, name)` (the sub-agent analog of `getAgentByName`). The parent DO stays on the path for the initial request, where an overridable `onBeforeSubAgent(req, { class, name })` hook can authorize, mutate the request, or short-circuit with a response — mirroring `onBeforeConnect` / `onBeforeRequest`. If the hook doesn't return a Response, the parent resolves the facet and forwards. For WebSocket upgrades, after the 101 flows back the parent drops out of the hot path — frames route directly to the child.

This is the primitive `rfc-think-multi-session.md`'s `Chats.getChat()` will use. It's designed to be recursive (sub-sub-agents work by induction) and composable with the existing `onBeforeConnect` / `onBeforeRequest` / `basePath` options.

## Problem

Today, facets have two properties that together make them useless for "per-chat DO" patterns:

1. `ctx.facets.get(…)` returns a `Fetcher` — so the parent can RPC/fetch the child.
2. The underlying DurableObjectId is not exposed, and `routeAgentRequest` only knows about top-level DO bindings, so **clients can't connect to a facet from the network**.

So if you want per-chat DOs so conversations run in parallel (the whole point of the multi-session design), the client has to connect to a regular top-level-bound DO — which means facets aren't helping, you're reinventing the parent/child relationship with a naming convention, and there's no structural place for the parent to mediate auth.

The spike (committed in `97e814d4`) confirms the building block: a parent can forward an incoming WS/HTTP request into a facet via `ctx.facets.get(...).fetch(req)`, the upgrade response propagates back up the chain, and after upgrade the WS frames go direct to the child. The parent's `fetch()` counter stays at 1 regardless of how many messages the client sends. That's the green light to design the rest of this properly.

## Decisions

These are the answers from the design discussion, baked in.

### D1. URL shape: `/sub/{class}/{name}`, configurable prefix

The top-level routing prefix stays configurable (`routeAgentRequest(req, env, { prefix: "…" })` — defaults to `"agents"`). The `sub` segment is also a configurable knob, defaulting to `"sub"`:

```ts
routeAgentRequest(req, env, { prefix: "agents", subPrefix: "sub" });
// → /agents/inbox/alice/sub/chat/abc
```

Recursive nesting:

```
/agents/inbox/alice/sub/chat/abc/sub/researcher/r-1
```

Each `sub` marker separates one parent↔child hop. The `/sub/` separator is unambiguous for parsing and visually signals the structural relationship.

### D2. Parent-side middleware hook: `onBeforeSubAgent`

The parent DO gets a middleware hook that mirrors the existing `onBeforeConnect` / `onBeforeRequest` pair — same prefix, same lifecycle role, same return-type shape. Auth is one use case; request mutation, short-circuit responses, logging, rate limiting, and redirects are others.

| Tier            | Where                                                               | Configured by       | DO awake?    | Typical concern                                                             |
| --------------- | ------------------------------------------------------------------- | ------------------- | ------------ | --------------------------------------------------------------------------- |
| Cross-cutting   | `routeAgentRequest` options (`onBeforeConnect` / `onBeforeRequest`) | Worker entry        | No           | "Is this request authenticated at all?"                                     |
| Parent-specific | `onBeforeSubAgent` on the parent Agent subclass                     | Parent class author | Yes (parent) | "Should this request reach the child? Mutate it? Short-circuit a response?" |
| Child-specific  | child's own handlers                                                | Child class author  | Yes (child)  | "Can this caller do X here?"                                                |

`onBeforeConnect` / `onBeforeRequest` are unchanged — they run at the top of the router, before anything wakes up. They see the full nested URL and can reject outright.

`onBeforeSubAgent` is new:

```ts
class Inbox extends Agent {
  /**
   * Called on the parent DO before it forwards a request into a
   * facet. Mirrors `onBeforeConnect` / `onBeforeRequest` — returning
   * a `Response` short-circuits, returning a `Request` forwards a
   * modified request, returning nothing forwards the original.
   *
   *   - return `void` (default) → forward the original request
   *   - return `Request`        → forward this (modified) request
   *   - return `Response`       → return this response to the
   *                               client; do not wake the child
   *
   * Default implementation: `return;` (forward unchanged).
   */
  async onBeforeSubAgent(
    req: Request,
    child: { class: string; name: string }
  ): Promise<Request | Response | void> {
    return;
  }
}
```

The return-type shape is deliberately identical to `onBeforeConnect` / `onBeforeRequest`, so users who know those hooks already know this one. One hook handles both WS and HTTP; differentiate via `req.headers.get("upgrade")` if needed.

**Typical uses:**

```ts
// Strict registry gate — reject if the chat doesn't exist.
async onBeforeSubAgent(req, { class: cls, name }) {
  if (cls !== "Chat") {
    return new Response("Unknown class", { status: 404 });
  }
  const rows = this.sql`SELECT 1 FROM inbox_chats WHERE id = ${name}`;
  if (rows.length === 0) {
    return new Response("Not found", { status: 404 });
  }
}

// Inject identity headers for the child to read.
async onBeforeSubAgent(req, _child) {
  const headers = new Headers(req.headers);
  headers.set("x-inbox-id", this.name);
  headers.set("x-request-id", crypto.randomUUID());
  return new Request(req, { headers });
}

// Cached short-circuit — don't wake the child for a known response.
async onBeforeSubAgent(req, { name }) {
  if (req.method === "GET" && this.isCacheable(req)) {
    const cached = this.getCache(name, req.url);
    if (cached) return cached;
  }
}
```

**Auth cost in practice:** the parent is on the path only at connect time (and per HTTP request). For a chat app with cookie-based auth, that's one lookup per new connection. Negligible. If real usage shows the parent becoming a bottleneck (e.g. high connection churn), the capability-token fast-path in the Follow-ups table skips the parent on subsequent connects.

### D3. Lazy creation via `onBeforeSubAgent` result

No separate "strict" toggle. If `onBeforeSubAgent` returns anything other than a `Response`, we `subAgent(ChildClass, name)` — which lazily creates on first access. Apps that want strict-exists-check return a `Response` from the hook. One mechanism, one API surface.

### D4. Client API: nested `sub`

```ts
// Simple
useAgent({
  agent: "inbox",
  name: userId,
  sub: { agent: "chat", name: chatId }
});

// Recursive
useAgent({
  agent: "inbox",
  name: userId,
  sub: {
    agent: "chat",
    name: chatId,
    sub: { agent: "researcher", name: rId }
  }
});

// Leaf-is-the-identity
const chat = useAgent({
  agent: "inbox",
  name: userId,
  sub: { agent: "chat", name: chatId }
});
chat.agent; // "chat"     ← leaf
chat.name; // chatId     ← leaf
chat.path; // [{agent: "inbox", name: userId}, {agent: "chat", name: chatId}]
```

- `.agent` / `.name` remain the leaf's identity — so downstream hooks like `useAgentChat(agent)` see the child they actually talk to.
- `.path` is new: the full chain for observability, reconnect keying, and UI.
- Reconnection keys on the full path (not just leaf) — two different deep chains with the same leaf name won't collide in the hook cache.
- `basePath` composes: `basePath: "api/v1"` + nested `sub` → `/api/v1/inbox/.../sub/chat/...`.

Identity protocol message extended so the server can tell the client what it's actually talking to:

```ts
{
  type: "cf_agent_identity",
  agent: "chat",
  name: chatId,
  // NEW — the full path back to the root. Optional; undefined
  // means "I'm top-level," which is backward-compatible.
  path?: [
    { agent: "inbox", name: userId },
    { agent: "chat", name: chatId }
  ]
}
```

### D5. HTTP and WS are symmetric

Same routing, same auth, same path rewriting. `@callable` HTTP, `onRequest` handlers, and WS upgrades all flow through the nested route without special cases.

### D6. Lifecycle — delete terminates connections

`deleteSubAgent(ChildClass, name)` destroys the facet DO. Open WS to that child terminate (normal DO shutdown). Client `useAgent` sees a disconnect; reconnect attempts go back through the parent, which can now reject via `onBeforeSubAgent` (returning a 404 Response if the parent's registry no longer lists the chat) or lazily recreate (permissive default). Documented behavior; the app decides which semantic it wants via the hook.

### D7. Implementation location — agents first, partyserver later

partyserver is Cloudflare-specific (confirmed), so the facet-specific bits fit there too in principle. But:

- `ctx.facets` is wired through agents' `FacetCapableCtx` already.
- The Cloudflare-specific "fetch an upgrade through a Fetcher" piece has no generic partyserver-shaped abstraction yet.
- Quicker to iterate on the semantics here, in one package.

So: ship in `agents` first, extract the URL-parsing and forwarding primitives to partyserver later when the shape has stabilized.

### D8. Composable primitives for custom routing

Two new exports, forming a symmetric four-quadrant surface with the existing top-level primitives:

|               | Get a stub                             | Handle a full request                                                      |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| **Top-level** | `getAgentByName(namespace, name)`      | `routeAgentRequest(req, env)` — runs `onBeforeConnect` / `onBeforeRequest` |
| **Sub-agent** | `getSubAgentByName(parent, Cls, name)` | `routeSubAgentRequest(req, parent)` — runs `onBeforeSubAgent`              |

Same mental model at both levels. Only the hooks that fire differ.

#### `routeSubAgentRequest(req, parent, options?)`

For users with non-default outer URL (a `basePath`, a custom prefix, a completely hand-rolled handler) who want the framework to do the sub-agent dispatch step on their behalf:

```ts
import { routeSubAgentRequest, getAgentByName } from "agents";

export default {
  async fetch(req, env) {
    // Your own URL parsing — routeAgentRequest doesn't match your shape.
    const { parentName, rest } = myCustomParse(new URL(req.url).pathname);
    const parent = await getAgentByName(env.Inbox, parentName);
    return routeSubAgentRequest(new Request(rest, req), parent);
  }
};
```

`routeSubAgentRequest`:

- Parses `/sub/{class}/{name}[/...]` from the request URL.
- Forwards into the parent DO's fetch handler, which runs `onBeforeSubAgent` and resolves the facet.
- Returns the Response.
- **Runs `onBeforeSubAgent`** — same authorization/mutation path as a request arriving via `routeAgentRequest`.

`routeAgentRequest` uses this internally; exposing it means users whose paths don't match the default can compose without re-implementing the dispatch dance.

#### `getSubAgentByName(parent, Cls, name)`

For users who already have a parent stub and want a typed sub-agent stub back — perhaps to make a single RPC call, not to forward an incoming request:

```ts
import { getAgentByName, getSubAgentByName } from "agents";
import { MyInbox, MyChat } from "./agents";

const inbox = await getAgentByName(env.MyInbox, userId);
const chat = await getSubAgentByName(inbox, MyChat, chatId);

// Use the stub as you would any SubAgentStub:
await chat.addMessage({ role: "user", content: "hi" });
const history = await chat.getHistory();
```

`getSubAgentByName`:

- Calls an internal RPC method on the parent that wraps `ctx.facets.get(...)` and returns the Fetcher.
- The returned stub is fully typed (`SubAgentStub<T>`).
- **Does not run `onBeforeSubAgent`** — same rationale as `getAgentByName` not running `onBeforeConnect`. If you already have the parent stub, you've presumably already cleared whatever access checks your app cares about. The hook is for external request routing, not in-Worker RPC.

Side-by-side with `this.subAgent(...)`: inside a parent DO, `this.subAgent(Cls, name)` is the more direct path; `getSubAgentByName(parent, Cls, name)` is for callers _outside_ the parent DO that don't want to round-trip through a custom bridge method.

## Implementation plan

Five substantive pieces; none large.

### 1. `routeAgentRequest` extension + routing primitives

New file in `packages/agents/src/`:

- `sub-routing.ts` — URL parser (`parseSubAgentPath`), the public `routeSubAgentRequest` helper, and an internal `forwardToFacet` function that wraps the raw `ctx.facets.get(...).fetch(req)` dance. No magic header needed: the parent's fetch-handler arm explicitly looks for `/sub/…` in the URL, and once it forwards, the child is just handling a normal HTTP request (with the prefix stripped).

- Updates to the top-level router in `index.ts`:

  ```ts
  export async function routeAgentRequest<Env>(
    request: Request,
    env: Env,
    options?: AgentOptions<Env> & { subPrefix?: string }
  ) { … }
  ```

  Parses `/agents/{class}/{name}/{subPrefix?}/...`. If the tail is non-empty, the handler sends the full request to the root DO (unchanged). The parent's base-class fetch does the next dispatch step.

### 2. Agent base class — parent-side dispatch

Inside `Agent`'s fetch handler (it already overrides for things like WS upgrades, `@callable` RPC, etc.), add a new arm:

```ts
// Pseudocode
async fetch(req: Request): Promise<Response> {
  const subMatch = tryMatchSubAgentPath(req.url);
  if (subMatch) {
    const { childClass, childName, remainingPath } = subMatch;
    const decision = await this.onBeforeSubAgent(req, {
      class: childClass,
      name: childName
    });
    if (decision instanceof Response) return decision;
    const forwardReq = decision instanceof Request ? decision : req;
    return forwardToFacet(forwardReq, this, {
      childClass,
      childName,
      remainingPath
    });
  }
  return super.fetch(req); // existing Server / Agent handling
}
```

`forwardToFacet` (internal) resolves `ctx.facets.get(...)` via the same mechanism `subAgent()` uses, rewrites the URL (strips the `/sub/{class}/{name}` segment), and returns `facetStub.fetch(newReq)`. It's also what `routeSubAgentRequest` calls under the hood after parsing.

### 3. `getSubAgentByName` + parent-side RPC bridge

The helper can't call `ctx.facets.get(...)` directly from outside the parent DO, so a small private bridge method lives on the `Agent` base:

```ts
// On Agent base — internal, prefixed to avoid colliding with user methods.
async _cf_getSubAgent(className: string, name: string): Promise<Fetcher> {
  const ctx = this.ctx as FacetCapableCtx;
  const facetKey = `${className}\0${name}`;
  const stub = ctx.facets.get(facetKey, () => ({
    class: ctx.exports[className]
  }));
  await (stub as unknown as { _cf_initAsFacet(n: string): Promise<void> })
    ._cf_initAsFacet(name);
  return stub;
}

// Public helper in sub-routing.ts:
export async function getSubAgentByName<T extends Agent>(
  parent: DurableObjectStub<Agent>,
  cls: SubAgentClass<T>,
  name: string
): Promise<SubAgentStub<T>> {
  const fetcher = await (parent as unknown as {
    _cf_getSubAgent(c: string, n: string): Promise<Fetcher>;
  })._cf_getSubAgent(cls.name, name);
  return fetcher as unknown as SubAgentStub<T>;
}
```

**Open implementation question — to validate before merging the feature PR:** the returned object needs to work not just for `.fetch()` but for typed RPC method calls (`await chat.addMessage(...)`). The spike only confirmed `.fetch()` across the chain; whether Cloudflare JS-RPC can pass a DO stub / Fetcher through an RPC return value and preserve full RPC semantics on the receiving side is something we'll verify with a small extension to the existing spike:

```ts
// Add to spike-sub-agent-routing.test.ts
it("returns a stub that supports both fetch and RPC calls across DO boundaries", async () => {
  const parent = await getAgentByName(env.SpikeSubParent, uniqueName());
  const child = await getSubAgentByName(parent, SpikeSubChild, uniqueName());
  expect(await child.getCount("anything")).toBe(0); // RPC method call
  // ...
});
```

If RPC doesn't pass through cleanly (runtime limitation), the fallback is: `getSubAgentByName` returns a `Fetcher`-only type, and users needing RPC either add explicit bridge methods on the parent (`async getChatHistory(name) { return (await this.subAgent(Chat, name)).getHistory(); }`) or call `this.subAgent(Chat, name)` from inside the parent. Document either outcome clearly in the API docs once we know.

### 4. Client — nested `useAgent` + URL construction

In `packages/agents/src/react.tsx`:

- Extend `UseAgentOptions` with `sub?: { agent: string; name: string; sub?: … }` (recursive).
- URL construction walks the chain, interspersing `/{subPrefix}/{class}/{name}` per level.
- Cache key uses the full chain.
- Identity-check on reconnect walks the full `path` from the server's identity message.
- `.agent` / `.name` return the leaf; `.path` is new.

### 5. Tests

Extend the committed spike with the full primitive-level coverage:

- Default prefix + default `subPrefix`.
- Custom prefix, custom `subPrefix`, custom basePath.
- Recursive (two-level-deep) dispatch.
- `onBeforeSubAgent` returning a `Response` → passed through verbatim to the client.
- `onBeforeSubAgent` returning a `Request` → forwarded request is the mutated one (new headers / URL / body).
- `onBeforeSubAgent` returning nothing → original request forwarded.
- `routeSubAgentRequest` from a custom fetch handler — parses, authorizes, forwards.
- `getSubAgentByName` returning a usable stub (see open question in step 3 re: cross-DO RPC).
- `getSubAgentByName` does _not_ run `onBeforeSubAgent` (explicit test to pin the semantic).
- Client `useAgent` with nested `sub` — identity check, state sync, `@callable` RPC, stream resume.
- Deletion of a child while a WS is open — client surfaces disconnect cleanly.

## Migration

Zero for existing consumers: `routeAgentRequest` behavior is unchanged when URLs don't contain `/sub/`. `onBeforeSubAgent` has a permissive default (forward the original request). `useAgent` without a `sub` option is unchanged.

Once this lands:

- `rfc-think-multi-session.md`'s `Chats.getChat(id)` returns a `SubAgentStub<Child>` obtained via the framework, and the client uses nested `useAgent` / `useChats`. The `examples/multi-ai-chat` reference example is updated to use the real primitive instead of hand-rolled namespace RPC.
- We document the two patterns: use `subAgent()` + the nested URL when you want the parent gatekeeping + structural hierarchy; use plain namespace DO lookup for utility children the parent owns exclusively (no client access).

## Follow-ups (intentionally out of v1)

| Item                                                                                                       | Why deferred                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability-token fast path (short-lived signed token from parent; subsequent connects skip parent wake-up) | Cross-domain scenarios and high-connection-rate apps may want this. Not needed for cookie-auth single-domain apps, which is the dominant case. Ship when real usage pushes for it. |
| Parent-side enumeration API (`listSubAgents()`)                                                            | The existing `ctx.facets` registry has this info internally. Exposing it cleanly is a small follow-up that doesn't affect the routing design.                                      |
| Partyserver backport of URL parsing + forwarder                                                            | Once stable in agents.                                                                                                                                                             |
| Broadcast parent → child disconnect signal (server-initiated "your chat was deleted")                      | Can be implemented via the existing `broadcast` mechanism from the parent. Worth a small helper once patterns emerge.                                                              |
| `useAgent({ sub: {...} })` React Router integration sugar                                                  | `useParams()` + manual wiring works today. Sugar when we see enough adoption.                                                                                                      |
| `sub` deep-linking helper (parse/serialize a chain to/from a URL string)                                   | Small utility; add when the UI patterns want it.                                                                                                                                   |
| Authorization on recursive sub-paths                                                                       | Each hop's parent authorizes independently. Nothing extra needed; noted so it's clear.                                                                                             |

## Open questions

- **Identity protocol change — version bump?** Adding `path` to `cf_agent_identity` is additive, old clients ignore it. No version bump needed. If we later need to change the _semantics_ of the field (e.g., encoding method), we use protocol versioning then.
- **`subPrefix` default value.** `"sub"` is short and clear. `"child"` was considered and rejected (less clearly "the next hop"). `"_"` or `"+"` felt too cryptic.

## Decided

Moved here from "Open questions" once we've locked the answer in:

- **Parent-side hook name — `onBeforeSubAgent`.** An earlier draft had `authorizeSubAgent(req, child) → boolean | Response`, which undersold the hook by framing it as auth-only. The real shape is a middleware: it can allow (default), mutate the request, short-circuit with a response, or reject. Matching the existing `onBeforeConnect` / `onBeforeRequest` pattern — same prefix, same return-type shape (`Request | Response | void`), same mental model — means zero new concepts to learn. Auth is one use case documented via example; request-injection, caching, logging, and rate limiting are first-class peers.

- **Routing helper name — `routeSubAgentRequest` (was `forwardToSubAgent`).** Symmetric with the existing `routeAgentRequest` — same verb, same noun, users who know the top-level router immediately know the sub-agent one. The earlier `forwardToSubAgent` was action-oriented and stood alone stylistically.

- **New primitive — `getSubAgentByName(parent, Cls, name)`.** The sub-agent analog of `getAgentByName`. Together with `routeSubAgentRequest`, the public surface now forms a clean four-quadrant table: top-level vs. sub-agent, "get a stub" vs. "handle a full request." `getSubAgentByName` does not run `onBeforeSubAgent` — same rationale as `getAgentByName` not running `onBeforeConnect`. The hook is for external request routing; in-Worker RPC trusts the caller.

## Non-goals

- A general-purpose "DO proxy" mechanism. This is specifically for parent↔child facet topology.
- Cross-Worker routing. Sub-agents live in the same Worker as their parent.
- Replacing `subAgent()` with a new primitive. This builds on it.
- Authentication by the child (the child trusts its parent's decision). If the child wants to double-check, it can — just application code.
