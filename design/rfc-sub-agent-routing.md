# RFC: External addressability for sub-agents

Status: proposed

Related:

- [`rfc-think-multi-session.md`](./rfc-think-multi-session.md) — proposes a `Chats` base class + per-chat DOs; depends on this primitive.
- `rfc-ai-chat-maintenance.md` (landing in [#1353](https://github.com/cloudflare/agents/pull/1353)) — `AIChatAgent` maintenance stance; independent.
- **Spike** — [`packages/agents/src/tests/agents/spike-sub-agent-routing.ts`](../packages/agents/src/tests/agents/spike-sub-agent-routing.ts) and its [test](../packages/agents/src/tests/spike-sub-agent-routing.test.ts). Confirmed: WS upgrade propagates through a two-hop `fetch()` chain (Worker → parent DO → facet Fetcher), and after upgrade the parent is out of the hot path. HTTP is symmetric. Stateless per-call bridge works for cross-DO typed RPC (documented in step 3 of the plan).

## Summary

Let a client reach a sub-agent (a facet created by `Agent#subAgent()`) directly over WebSocket or HTTP via a nested URL:

```
/agents/{parent-class}/{parent-name}/sub/{child-class}/{child-name}[/...]
```

Implemented by extending `routeAgentRequest` and adding three new framework primitives:

- `onBeforeSubAgent(req, { class, name })` — parent-side middleware hook, mirroring `onBeforeConnect` / `onBeforeRequest`.
- `routeSubAgentRequest(req, parent, options?)` — sub-agent analog of `routeAgentRequest` for custom-routing setups.
- `getSubAgentByName(parent, Cls, name)` — sub-agent analog of `getAgentByName`.

Plus three small reflection APIs on `Agent` that fall out for free: `this.parentPath` (ancestor chain), `this.parentAgent(Cls)` (direct-parent lookup), and `this.hasSubAgent(className, name)` / `this.listSubAgents()` (parent-side introspection over a framework-maintained registry).

The design is recursive (sub-sub-agents work by induction) and composable with existing `onBeforeConnect` / `onBeforeRequest` / `basePath` options. Migration for existing consumers is zero.

## Problem

Today, facets have two properties that together make them useless for "per-chat DO" patterns:

1. `ctx.facets.get(…)` returns a `Fetcher` — the parent can RPC/fetch the child.
2. The underlying `DurableObjectId` is not exposed, and `routeAgentRequest` only knows about top-level DO bindings, so **clients cannot connect to a facet from the network**.

So if you want per-chat DOs so conversations run in parallel, the client has to connect to a regular top-level-bound DO — which means facets don't help, you reinvent the parent/child relationship with a naming convention, and there's no structural place for the parent to mediate auth.

The spike confirmed the mechanic works end-to-end: a parent can forward an incoming WS/HTTP request into a facet via `ctx.facets.get(...).fetch(req)`, the 101 response propagates back up, and after upgrade frames route directly to the child. That's the green light to design the rest of this properly.

## Design

### D1. URL shape, name encoding, and reserved characters

Default shape:

```
/agents/{parent-class}/{parent-name}/sub/{child-class}/{child-name}[/...]
```

Recursive nesting is supported:

```
/agents/tenant/acme/sub/inbox/alice/sub/chat/abc
```

Each `/sub/` marker separates one parent↔child hop.

**Prefix is configurable; the `/sub/` separator is not:**

```ts
routeAgentRequest(req, env, {
  prefix: "agents" // default
});
```

The `sub` segment that separates parent↔child hops is hardcoded across the routing surface (server parse, client URL builder, helpers). We landed a `SUB_PREFIX` constant so symbolic URL construction is possible, but the value is not user-overridable — configurability added noise without buying anything real, and collisions with class names are rare and easy to fix with a rename.

**Names:**

- Are URL-encoded on the client by `useAgent` and URL-decoded on the server after the URL is split into segments. Names can safely contain `/`, spaces, Unicode, and other characters.
- The null character `\0` is reserved internally for facet composite keys and must not appear in names — enforced with a runtime check.

**Classes:**

- The CamelCase TypeScript class name is used in code paths (the hook, `hasSubAgent`, `listSubAgents`, `getSubAgentByName`). The URL uses the kebab-cased form, consistent with `routePartykitRequest`.
- A sub-agent class literally named `Sub` is rejected at spawn time (`/sub/sub/...` would be ambiguous). Rename it (e.g. `SubThing`).

**Note on class-name collision with top-level bindings.** If `Chat` is both a top-level binding in `wrangler.jsonc` **and** a facet child under `Inbox`, `/agents/chat/abc` and `/agents/inbox/alice/sub/chat/abc` resolve to _different_ DOs with different storage. This is a subtle footgun — if your class is used as a sub-agent, don't also expose it as a top-level binding.

### D2. Parent-side middleware hook: `onBeforeSubAgent`

A middleware hook that mirrors `onBeforeConnect` / `onBeforeRequest`: same prefix, same lifecycle role, same return-type shape. Auth is one use case; request mutation, short-circuit responses, logging, rate limiting, and redirects are first-class peers.

```ts
class Inbox extends Agent {
  /**
   * Called on the parent DO before it forwards a request into a
   * facet. Mirrors `onBeforeConnect` / `onBeforeRequest`:
   *
   *   - return `void` (default) → forward the original request
   *   - return `Request`        → forward this (modified) request
   *   - return `Response`       → return this response to the
   *                               client; do not wake the child
   *
   * Default implementation: return void. Permissive.
   */
  async onBeforeSubAgent(
    req: Request,
    child: { className: string; name: string }
  ): Promise<Request | Response | void> {}
}
```

One hook handles both WS and HTTP. Differentiate via `req.headers.get("upgrade")` if needed.

**Auth tiers** once this lands:

| Tier            | Where                                     | Configured by       | DO awake?    | Typical concern                                     |
| --------------- | ----------------------------------------- | ------------------- | ------------ | --------------------------------------------------- |
| Cross-cutting   | `onBeforeConnect` / `onBeforeRequest`     | Worker entry        | No           | Is this request authenticated at all?               |
| Parent-specific | `onBeforeSubAgent` on the parent subclass | Parent class author | Yes (parent) | Should this reach the child? Mutate? Short-circuit? |
| Child-specific  | child's own handlers                      | Child class author  | Yes (child)  | Can this caller do X here?                          |

**Typical uses:**

```ts
// Strict registry gate — reject if the chat doesn't exist.
async onBeforeSubAgent(req, { className, name }) {
  if (className !== "Chat") return new Response("Unknown class", { status: 404 });
  if (!this.hasSubAgent(className, name)) return new Response("Not found", { status: 404 });
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

**Auth cost in practice.** The parent is on the path only at connect time (and per HTTP request). For a chat app with cookie-based auth, that's one lookup per new connection. Negligible. If real usage shows the parent becoming a bottleneck (e.g. high connection churn), the capability-token fast-path in Follow-ups skips the parent on subsequent connects.

### D3. Lazy creation, with strict available on opt-in

If `onBeforeSubAgent` returns anything other than a `Response`, the framework calls `this.subAgent(ChildClass, name)`, which lazily creates the facet on first access. Permissive by default — matches today's `ctx.facets.get()` semantics.

Strict-registry access is a one-liner using `hasSubAgent` (see D7):

```ts
async onBeforeSubAgent(req, { className, name }) {
  if (!this.hasSubAgent(className, name)) return new Response("Not found", { status: 404 });
}
```

Why opt-in rather than default: permissive lets the routing layer stay dumb (no registry read per request). Apps that need strict access pay for the lookup only when they actually check.

### D4. Client API: flat `sub: [...]` array

```ts
// One hop
useAgent({
  agent: "inbox",
  name: userId,
  sub: [{ agent: "chat", name: chatId }]
});

// Recursive
useAgent({
  agent: "tenant",
  name: tenantId,
  sub: [
    { agent: "inbox", name: userId },
    { agent: "chat", name: chatId }
  ]
});

// Leaf is the identity
const chat = useAgent({
  agent: "inbox",
  name: userId,
  sub: [{ agent: "chat", name: chatId }]
});
chat.agent; // "chat"   ← leaf
chat.name; // chatId   ← leaf
chat.path; // [{agent:"inbox",name:userId}, {agent:"chat",name:chatId}]
```

Flat array beats nested objects: trivial dynamic construction (`[...prefix, leaf]`) and symmetric with `.path` on the return side.

**Hook return surface:**

- `.agent` / `.name` are the **leaf** — downstream hooks like `useAgentChat(agent)` see the child they talk to, unchanged.
- `.path` is new: the full chain for observability, reconnect keying, and UI.
- **Reconnect cache keys on the full path.** Two chains with the same leaf name no longer collide.
- `basePath` composes: `basePath: "api/v1"` + nested `sub` → `/api/v1/inbox/.../sub/chat/...`.

**Identity protocol — unchanged.** The existing `cf_agent_identity` message carries the leaf's `{ agent, name }`. We do **not** add a `path` field to the wire protocol: the client constructed the URL, so it already knows the chain locally. `.path` on the `useAgent` return is computed client-side from the input.

### D5. HTTP and WS are symmetric

Same routing, same hook, same path rewriting. `@callable` RPC, `onRequest` handlers, and WS upgrades all flow through the nested route without special cases.

### D6. Lifecycle and deletion

`deleteSubAgent(ChildClass, name)` destroys the facet DO and removes its entry from the parent's sub-agent registry (see D7). Open WS to that child terminate (normal DO shutdown). The client's `useAgent` sees a disconnect and attempts to reconnect.

On reconnect, `onBeforeSubAgent` runs again. If the app does `if (!this.hasSubAgent(cls, name)) return 404`, the reconnect gets a permanent 404 and — per the client hardening below — the hook surfaces this as a terminal error instead of infinite retry.

**Client retry hardening (ships with this feature).** `useAgent` today retries indiscriminately on disconnect. That's wrong now:

- **HTTP 4xx at connect** → terminal. Stop reconnecting; surface as `error` state.
- **HTTP 5xx or network disconnect** → transient. Reconnect with backoff as today.
- **WS close code 1008 (policy violation) or 4000–4999 (app-level permanent)** → terminal.
- **Other WS close codes** → transient.

This is independent utility beyond sub-agents (it was always a gap that `useAgent` retried on a 403), but the sub-agent case makes it necessary.

### D7. Parent-side introspection: `parentPath`, `hasSubAgent`, `listSubAgents`

The framework maintains a small registry inside each parent's SQLite as a side effect of `subAgent()` / `deleteSubAgent()`. This gives us three things in one shot:

**`this.parentPath` — the ancestor chain.**

```ts
class Chat extends Agent {
  onStart() {
    console.log(`Chat ${this.name} started under:`, this.parentPath);
    // → [{ className: "Inbox", name: "alice" }, { className: "Tenant", name: "acme" }]
    // root → direct parent
  }
}

// Convenience:
this.selfPath; // ancestors + self, root-first
```

Populated by extending `_cf_initAsFacet(name, parentPath)`. When `subAgent(Cls, name)` is called, the parent derives the child's `parentPath` from `[...this.parentPath, { className: this.constructor.name, name: this.name }]` and passes it to the child's init. Works recursively: Tenant→Inbox→Chat ends up with Chat seeing the full two-level chain.

**`this.parentAgent(Cls)` — direct-parent lookup.**

```ts
class Chat extends Agent {
  async getInbox() {
    return this.parentAgent(Inbox);
  }
}
```

Takes the direct parent's class reference (not the namespace binding), verifies it matches `parentPath[0].className` at runtime, and resolves the stub via the standard `env[Cls.name]` binding. This catches the "wrong binding / wrong class" mistake early instead of silently talking to the wrong DO. For grandparents and further ancestors, use `parentPath[i]` + `getAgentByName(...)` directly.

Top-level agents (instantiated outside a facet context) have `parentPath === []`. Changing a parent's `name` after spawning a child does **not** retroactively update the child — parent names are stable DO identities, so this is fine in practice.

**`this.hasSubAgent(className, name)` — existence check.**

```ts
class Inbox extends Agent {
  async onBeforeSubAgent(req, { className, name }) {
    if (!this.hasSubAgent(className, name)) {
      return new Response("Not found", { status: 404 });
    }
  }
}
```

Signature: `hasSubAgent(className: string, name: string): boolean`, with an overload for `hasSubAgent(Cls, name)`. The hook form uses strings; internal code often uses the class reference directly.

**`this.listSubAgents(className?)` — enumeration.**

```ts
class Inbox extends Agent {
  @callable()
  async listChats() {
    return this.listSubAgents("Chat").map(({ name, createdAt }) => ({
      id: name,
      createdAt
    }));
  }
}
```

Returns `Array<{ className: string; name: string; createdAt: number }>`, optionally filtered by class. `listSubAgents(className?: string)` also has an overload for `listSubAgents(Cls)`. This collapses the former "parent-side enumeration API" follow-up into v1.

**Semantics.** These three APIs reflect the _registry_ — rows written by `subAgent()` / `deleteSubAgent()`. They are the framework's source of truth for "which children does this parent know about." If storage and registry ever drift (shouldn't happen, but runtime bugs exist), it's a framework bug; users can assume registry == truth.

### D8. Composable primitives for custom routing

Four public primitives, forming a symmetric table with the existing top-level APIs:

|               | Get a stub                             | Handle a full request                                                      |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| **Top-level** | `getAgentByName(namespace, name)`      | `routeAgentRequest(req, env)` — runs `onBeforeConnect` / `onBeforeRequest` |
| **Sub-agent** | `getSubAgentByName(parent, Cls, name)` | `routeSubAgentRequest(req, parent, opts)` — runs `onBeforeSubAgent`        |

Same mental model at both levels. Only the hooks that fire differ.

#### `routeSubAgentRequest(req, parent, options?)`

For users whose outer URL doesn't match `routeAgentRequest`'s default shape:

```ts
import { routeSubAgentRequest, getAgentByName } from "agents";

export default {
  async fetch(req, env) {
    const { parentName, subPath } = myCustomParse(new URL(req.url).pathname);
    const parent = await getAgentByName(env.Inbox, parentName);
    return routeSubAgentRequest(req, parent, { fromPath: subPath });
  }
};
```

Options:

- `fromPath?: string` — the path to route on (e.g. `"/sub/chat/abc"`). If omitted, the request's own pathname is used.

Runs `onBeforeSubAgent`. Returns the Response. `routeAgentRequest` uses it internally after extracting the parent.

#### `getSubAgentByName(parent, Cls, name)`

For callers who have a parent stub and want a typed sub-agent stub — to make an RPC call, not to forward a request:

```ts
import { getAgentByName, getSubAgentByName } from "agents";
import { MyInbox, MyChat } from "./agents";

const inbox = await getAgentByName(env.MyInbox, userId);
const chat = await getSubAgentByName(inbox, MyChat, chatId);

await chat.addMessage({ role: "user", content: "hi" });
const history = await chat.getHistory();
```

- **Does not run `onBeforeSubAgent`** — same rationale as `getAgentByName` not running `onBeforeConnect`. If you already have the parent stub, you cleared whatever access checks your app cares about. The hook is for external routing, not in-Worker RPC.
- **RPC methods only, no `.fetch()`.** The returned stub proxies typed RPC method calls through the parent. External HTTP/WS routing goes through `routeSubAgentRequest`. See step 3 of the implementation plan for why — briefly: DO stubs can't cross RPC return values; RpcTarget references don't survive across separate calls; the only robust pattern is a stateless per-call bridge, which doesn't readily support request forwarding.
- **One extra RPC hop per call** (caller → parent → facet). Acceptable for occasional cross-DO RPC; for hot paths, either run your code inside the parent (plain `this.subAgent(...)`) or use `routeSubAgentRequest` for HTTP/WS.
- Errors clearly if the child class isn't exported from the worker.

Side-by-side with `this.subAgent(...)`: inside a parent DO, `this.subAgent(Cls, name)` is the direct path. `getSubAgentByName(parent, Cls, name)` is for callers _outside_ the parent DO that don't want to write an explicit bridge method for every child method they care about.

### D9. Implementation location — agents first, partyserver later

partyserver is Cloudflare-specific, so facet mechanics could live there. But:

- `ctx.facets` is already wired through agents' `FacetCapableCtx`.
- The "fetch an upgrade through a Fetcher" pattern has no generic partyserver abstraction yet.
- It's faster to iterate on the semantics in one package.

Ship in `agents` first, extract URL parsing and forwarding primitives to partyserver once the shape has stabilized.

## Edge cases and semantics

Consolidated list of corner cases and the answers we've committed to:

- **Hook throws.** Propagates. The DO runtime surfaces 500 to the client. Users who want custom error handling wrap in try/catch themselves — matches how `onChatMessage` errors behave today.
- **Hook ordering vs class-existence.** The hook runs _before_ the framework checks that the child class exists in `ctx.exports`. This lets users intercept with a custom response even for unknown classes. If the hook returns void and the class is missing, the framework returns a default 404 with a diagnostic body.
- **Request URL rewrites.** The hook receives the original request with its full URL intact — including the `/sub/{class}/{name}` segment — mirroring how partyserver's `onBeforeConnect` / `onBeforeRequest` pass through the un-stripped URL. The routing decision for which facet to wake is fixed at parse time; if the hook returns a modified `Request`, its headers, body, method, and query string flow to the child, but the **pathname** the child sees is always `match.remainingPath` (the tail after `/sub/{class}/{name}`). Customize via headers/body rather than URL-rewriting if the child's path needs to look different.
- **Header/auth propagation.** Headers flow through to the child verbatim unless the hook rewrites. Cookies, `Authorization`, custom headers — all visible to the child as sent by the client.
- **Reconnect terminal vs transient.** Documented in D6. `useAgent` stops on 4xx and WS codes 1008 / 4xxx; retries everything else.
- **Basepath composition.** Router strips `basePath` first, then parses `/{prefix}/{class}/{name}[/sub/...]`. Nothing special for sub-agents.
- **Recursive nesting auth.** Each hop's parent runs its own `onBeforeSubAgent` independently. No global traversal logic.
- **`this.name` in a facet.** Unchanged — it's the child's own name, not the chain. Observability code should use `selfPath` for the full chain.
- **Facet broadcasts.** Clients connect directly to facets once the nested route is upgraded, so `this.broadcast(...)` and `setState()` from inside a facet reach the facet's own WebSocket clients normally. The old \"facets are RPC-only\" assumption no longer holds after external addressability shipped.
- **`keepAlive()` inside a facet.** Safe but a no-op. workerd doesn't currently support independent alarms on SQLite-backed facets, so the helper returns an inert disposer instead of throwing. Active Promise chains / open WebSockets already keep the shared isolate alive for real work.
- **Class-name case.** The hook receives CamelCase class names. URLs use kebab-case. Framework handles the conversion.
- **Null-char in names.** Forbidden. Runtime check rejects with a clear error.

## Implementation plan

Five pieces; none large.

### 1. Routing primitives + `routeAgentRequest` extension

New file `packages/agents/src/sub-routing.ts` owns:

- `parseSubAgentPath(url, { knownClasses? })` — splits a URL into `{ childClass, childName, remainingPath }` or `null`. The `/sub/` marker is hardcoded.
- `routeSubAgentRequest(req, parent, options?)` — public helper (D8).
- `forwardToFacet(req, parent, { childClass, childName, remainingPath })` — internal; resolves via `ctx.facets.get(...)`, rewrites URL, returns `facetStub.fetch(...)`.

`routeAgentRequest` stays as-is on the outside — after resolving the top-level parent DO it forwards the full request into it, and the parent's base-class fetch does the next dispatch step.

### 2. Agent base class — parent-side dispatch + registry + `parentPath`

Three additions to the `Agent` base:

**Fetch dispatch arm (pseudocode):**

```ts
async fetch(req: Request): Promise<Response> {
  const subMatch = tryMatchSubAgentPath(req.url);
  if (subMatch) {
    const { childClass, childName, remainingPath } = subMatch;
    const decision = await this.onBeforeSubAgent(req, {
      className: childClass, name: childName
    });
    if (decision instanceof Response) return decision;
    const forwardReq = decision instanceof Request ? decision : req;
    return forwardToFacet(forwardReq, this, {
      childClass, childName, remainingPath
    });
  }
  return super.fetch(req);
}
```

**Registry maintenance inside `subAgent` / `deleteSubAgent`:**

```ts
private _ensureSubAgentIndex(): void {
  this.sql`CREATE TABLE IF NOT EXISTS cf_agents_sub_agents (
    class TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (class, name)
  )`;
}

async subAgent<T>(cls, name) {
  // ... existing facet resolution ...
  this._ensureSubAgentIndex();
  this.sql`INSERT OR IGNORE INTO cf_agents_sub_agents (class, name, created_at)
           VALUES (${cls.name}, ${name}, ${Date.now()})`;
  await stub._cf_initAsFacet(name, this.selfPath);
  return stub as SubAgentStub<T>;
}

async deleteSubAgent<T>(cls, name) {
  // ... existing delete ...
  this._ensureSubAgentIndex();
  this.sql`DELETE FROM cf_agents_sub_agents
           WHERE class = ${cls.name} AND name = ${name}`;
}

hasSubAgent(className: string, name: string): boolean { /* ... */ }
listSubAgents(className?: string): Array<{ className: string; name: string; createdAt: number }> { /* ... */ }
```

**`parentPath` + extended init:**

```ts
_cf_initAsFacet(
  name: string,
  parentPath: ReadonlyArray<{ className: string; name: string }>
): Promise<void>;

readonly parentPath: ReadonlyArray<{ className: string; name: string }> = [];
get selfPath(): ReadonlyArray<{ className: string; name: string }>;
```

### 3. `getSubAgentByName` — client-side Proxy over a per-call bridge

`ctx.facets.get(...)` only works inside the parent's isolate, so we need a bridge. Three candidate designs, exercised in the spike:

- **Return the facet stub directly from a parent RPC method.** Fails — DO stubs (facet _and_ top-level) aren't structured-cloneable. `DataCloneError` at RPC return.
- **Wrap in an `RpcTarget` that holds the facet stub and proxies `invoke(method, args)`.** RpcTarget _can_ cross the boundary, but its lifetime is scoped to the RPC call that returned it. Works once, breaks on reuse. Unsuitable.
- **Stateless per-call bridge — one RPC method that resolves the facet fresh each call.** Works. One extra hop per call; no reference lifetimes.

Going with the third. Implementation:

```ts
// On the Agent base — internal bridge method. One RPC per outside-
// facet-method-call; the parent resolves the facet (idempotent) and
// dispatches.
async _cf_invokeSubAgent(
  className: string,
  name: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  const ctx = this.ctx as FacetCapableCtx;
  const Cls = ctx.exports[className] as SubAgentClass;
  if (!Cls) {
    throw new Error(`Sub-agent class "${className}" not exported.`);
  }
  const stub = await this.subAgent(Cls, name);

  // Must use `handle[method](...)` in one expression — extracting
  // via `const fn = handle[method]` and then `fn.apply(handle, args)`
  // detaches the workerd RpcProperty binding and fails with an
  // internal error. (Confirmed by the spike.)
  const handle = stub as unknown as Record<
    string,
    (...a: unknown[]) => Promise<unknown>
  >;
  if (typeof handle[method] !== "function") {
    throw new Error(`Method "${method}" not found on ${className}.`);
  }
  return await handle[method](...args);
}

// Public helper — caller-side Proxy that looks like a typed stub.
export async function getSubAgentByName<T extends Agent>(
  parent: DurableObjectStub<Agent>,
  cls: SubAgentClass<T>,
  name: string
): Promise<SubAgentStub<T>> {
  const handle = parent as unknown as {
    _cf_invokeSubAgent(
      c: string,
      n: string,
      m: string,
      a: unknown[]
    ): Promise<unknown>;
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        // Thenable guard: `await getSubAgentByName(...)` would
        // otherwise trigger a ghost .then call on the returned Proxy.
        if (prop === "then") return undefined;
        return async (...args: unknown[]) =>
          handle._cf_invokeSubAgent(cls.name, name, prop, args);
      }
    }
  ) as SubAgentStub<T>;
}
```

**Cost and limits, documented in the JSDoc on `getSubAgentByName`:**

- Each call is a double hop (caller → parent → facet). Acceptable for occasional cross-DO RPC; for hot paths, put your code inside the parent or use `routeSubAgentRequest` for HTTP/WS.
- `.fetch()` is _not_ supported on the returned stub — external HTTP/WS routing goes through `routeSubAgentRequest`. Attempting `.fetch()` surfaces a clear error.
- Arguments and return values must be structured-cloneable (same rule as any DO RPC call).
- `getSubAgentByName` does not fire `onBeforeSubAgent` — consistent with `getAgentByName` not firing `onBeforeConnect`.

### 4. Client — nested `useAgent` + retry hardening

In `packages/agents/src/react.tsx`:

- Extend `UseAgentOptions` with `sub?: Array<{ agent: string; name: string }>` (flat array).
- URL construction walks the array, appending `/sub/{class}/{name}` per entry.
- Cache key includes the full chain (`agent`, `name`, serialized `sub`).
- Reconnect handling:
  - 4xx on HTTP or upgrade → set terminal error, stop retries.
  - WS close codes 1008 and 4000–4999 → terminal.
  - Everything else → retry with backoff.
- Return surface: `.agent` / `.name` are the leaf; add `.path` (root-first array).

### 5. Tests

Extend the committed spike with:

- Default `/agents/` prefix + default `/sub/` separator.
- Custom top-level prefix and `basePath`.
- Recursive (two-level-deep) dispatch end-to-end.
- `onBeforeSubAgent` returning a `Response` → passed through verbatim.
- `onBeforeSubAgent` returning a `Request` → forwarded (mutated) request is what the child sees.
- `onBeforeSubAgent` returning nothing → original request forwarded.
- `routeSubAgentRequest` from a custom fetch handler — parses, authorizes, forwards.
- `getSubAgentByName` returns a Proxy stub; typed method calls dispatch to the right facet and round-trip via the `_cf_invokeSubAgent` bridge.
- `getSubAgentByName` does **not** run `onBeforeSubAgent`.
- `getSubAgentByName` returned stub refuses `.fetch()` with a clear error (pointing at `routeSubAgentRequest`).
- `this.parentPath` / `selfPath` correct at every level of nesting.
- `hasSubAgent` / `listSubAgents` reflect `subAgent` / `deleteSubAgent` mutations.
- Names with `/`, spaces, Unicode, and URL-reserved characters round-trip correctly.
- Null-char in a child name rejected at registration.
- 4xx reconnect → client surfaces terminal error, stops retrying.
- WS close code 1008 → terminal.
- Deletion of a child while a WS is open — client sees disconnect, reconnect hits the permissive hook which lazy-recreates (default) or 404s (strict registry).

## Migration

Zero for existing consumers:

- `routeAgentRequest` behavior is unchanged when URLs don't contain `/sub/`.
- `onBeforeSubAgent` has a permissive default (forward unchanged).
- `useAgent` without `sub` is unchanged.
- `subAgent` / `deleteSubAgent` gain registry-maintenance side effects but preserve existing return types and failure modes.

Downstream consumers:

- **[`rfc-think-multi-session.md`](./rfc-think-multi-session.md)** — already updated to build on the now-landed primitive. `Chats.getChat(id)` returns `await this.subAgent(...)`, client uses nested `useAgent({ sub: [...] })`. The `Chats` base class itself still needs to be implemented (tracked in that RFC).
- **`examples/multi-ai-chat`** (lives on [#1353](https://github.com/cloudflare/agents/pull/1353)) — rebased onto this primitive in that PR's migration. The example server collapses from hand-rolled namespace RPC + `/agents/inbox/...` routing to native `onBeforeSubAgent` gating + `sub:` on the client.
- **Docs page `docs/sub-agent-routing.md`** — the user-facing write-up with end-to-end examples. Follow-up PR after this lands.

## Follow-ups (intentionally out of v1)

| Item                                                                                                       | Why deferred                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability-token fast path (short-lived signed token from parent; subsequent connects skip parent wake-up) | Cross-domain scenarios and high-connection-rate apps may want this. Not needed for cookie-auth single-domain apps, which is the dominant case. Ship when real usage pushes for it. |
| Partyserver backport of URL parsing + forwarder                                                            | Once stable in agents.                                                                                                                                                             |
| Broadcast parent → child disconnect signal (server-initiated "your chat was deleted")                      | Parent can already use `broadcast()`. A small helper once patterns emerge.                                                                                                         |
| `useAgent({ sub: [...] })` React Router integration sugar                                                  | `useParams()` + manual wiring works today. Sugar when adoption is clearer.                                                                                                         |
| `sub` deep-linking helper (parse/serialize a chain to/from a URL string)                                   | Small utility; add when the UI patterns demand it.                                                                                                                                 |
| Cross-DO ancestor RPC helper (child → grandparent)                                                         | `parentPath` exposes the ancestor identity; reaching up-tree via RPC is use-case-specific. Users bridge through explicit parent methods when needed.                               |
| TypeScript generics for the hook's `{ className, name }`                                                   | Today the hook is stringly typed. Generic narrowing (e.g. mapping class names to `SubAgentClass<T>`) could come later if the pattern is worth it.                                  |

## Decided

- **Hook name — `onBeforeSubAgent`.** Matches the existing `onBeforeConnect` / `onBeforeRequest` pattern and the `SubAgent*` naming cluster (`subAgent`, `SubAgentStub`, `deleteSubAgent`, `getSubAgentByName`, `routeSubAgentRequest`). Consistency with the namespace outweighs the minor grammatical imperfection of a noun after `onBefore`. Return shape: `Request | Response | void`, identical to the existing hooks. Use cases covered in D2.
- **Routing helper name — `routeSubAgentRequest`** (was `forwardToSubAgent`). Symmetric with `routeAgentRequest`.
- **Sub-agent stub getter — `getSubAgentByName`.** Symmetric with `getAgentByName`. Does **not** run `onBeforeSubAgent` (same rationale as `getAgentByName` not running `onBeforeConnect`).

- **`getSubAgentByName` implementation — stateless per-call bridge, not direct stub return.** The spike (`spike-sub-agent-routing.test.ts`) confirmed that DO stubs (facet and top-level) can't be returned from RPC methods (`DataCloneError`), and that `RpcTarget`-wrapped stubs don't survive across separate RPC calls. The working pattern is a single `_cf_invokeSubAgent(class, name, method, args)` method on the parent, with a JS Proxy on the caller side that translates typed method calls into that one RPC. Cost: one extra hop per call. The Proxy supports only RPC method calls — not `.fetch()`. External HTTP/WS routing goes through `routeSubAgentRequest`.
- **Client `sub` shape — flat array.** `sub: [{agent, name}, ...]` beats nested objects: trivial dynamic construction, symmetric with `.path` output.
- **Identity protocol — unchanged.** The `cf_agent_identity` message continues to carry just the leaf. The client computes `.path` locally from its `sub` input, avoiding a breaking wire change.
- **Permissive lazy-create by default.** Strict registry is one `hasSubAgent` line in the hook.
- **Parent-side introspection shipped with v1** (`parentPath`, `selfPath`, `hasSubAgent`, `listSubAgents`). Falls out of the registry we need to maintain anyway; collapses a planned follow-up into the primitive.
- **Client retry hardens on 4xx and terminal WS codes.** Needed for sane UX when the parent rejects or deletes a child.

## Non-goals

- A general-purpose DO proxy mechanism. This is specifically for parent↔child facet topology.
- Cross-Worker routing. Sub-agents live in the same Worker as their parent.
- Replacing `subAgent()` with a new primitive. This builds on it.
- Authentication by the child (the child trusts its parent's decision). If the child wants to double-check, it's just application code.
