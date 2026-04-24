# Think Multi-Session WIP Plan

## Why this file exists

We recently landed and merged the sub-agent routing primitive into
`packages/agents`, and we also built `examples/multi-ai-chat` on top of it as
the first concrete proof that the routing model works in practice.

The next goal is to bring that same parent/child multi-session model to Think.
The original design direction for this work lives in
`design/rfc-think-multi-session.md`, but the repo has evolved since that RFC
was written:

- the routing primitive has already shipped
- the parent-side registry now exists
- `parentAgent(Cls)`, `useAgent({ sub })`, `onBeforeSubAgent`,
  `hasSubAgent`, and `listSubAgents` are all available
- `examples/multi-ai-chat` now shows the intended composition pattern in real
  code

This note captures the current working plan before we decide what, if
anything, should later move into a library API or a more permanent design
document.

## Current understanding

The current intended architecture is:

1. One chat conversation lives in one child Durable Object.
2. A parent Durable Object owns the directory/sidebar state and any
   user-scoped shared state.
3. Clients connect directly to the active child via nested sub-agent routing.
4. The parent uses the shipped registry and routing hooks rather than
   inventing its own routing layer.

`examples/multi-ai-chat` proves this already works with `AIChatAgent`:

- parent DO for list + metadata + shared memory
- child DO per conversation
- parent-side strict registry gate via `onBeforeSubAgent`
- child reaches parent with `parentAgent(Cls)`
- client reaches the active child using `useAgent({ sub: [...] })`

That means Think does not need a new routing mechanism. The work now is to
adapt the pattern for Think, validate the UX, and decide which pieces deserve
to become framework primitives.

## Important conclusions so far

### 1. Do not redesign the routing layer

The routing primitive is already shipped and should be treated as the
foundation:

- `subAgent(Cls, name)`
- `deleteSubAgent(Cls, name)`
- `parentAgent(Cls)`
- `onBeforeSubAgent`
- `hasSubAgent`
- `listSubAgents`
- `useAgent({ sub: [...] })`

Any Think-side work should build directly on those APIs.

### 2. Do not rewrite `examples/multi-ai-chat`

`examples/multi-ai-chat` should remain the minimal proof of the primitive.
It is valuable precisely because it is small and explicit.

Instead, the main place to exercise the Think-side multi-session story should
be `examples/assistant`, since it is the kitchen-sink Think example and the
best place to stress real feature interactions.

### 3. Do not ship a library `Chats` abstraction yet — still holds after #1384

There was an initial instinct to promote the pattern into a reusable `Chats`
base class immediately. Holding off, with one consumer (`AssistantDirectory`
in `examples/assistant`) now built. See PR 4 below — the decision is
deferred until we have a second consumer or external pull.

The same logic applies to `useChats()`, `SharedWorkspace`, and
`SharedMCPClient`: example-local prototypes today, promotion candidates
later if a pattern emerges from a second consumer.

What _did_ get promoted to the library: the proxy-substitution _typing_,
not the proxy classes themselves. `WorkspaceLike` (in `@cloudflare/think`)
and `WorkspaceFsLike` (in `@cloudflare/shell`) make it possible to
substitute a workspace without casts; that benefits anyone building a
shared-resource-via-DO-RPC pattern, even if their proxy class looks
nothing like ours.

### 4. Hoisting chat React primitives into `agents` is worth exploring

Today Think consumers still reach into `@cloudflare/ai-chat/react` for
`useAgentChat`, even though the underlying wire protocol and chat primitives
already mostly live in `agents/chat`.

That package boundary feels wrong. A likely follow-up is:

- move or hoist the shared React chat hook implementation into `agents`
- keep a compatibility re-export from `@cloudflare/ai-chat/react`
- use that as the place to add Think-oriented behavior later

This is a separate concern from multi-session itself and should likely happen
in a dedicated PR after the assistant prototype is working.

### 5. Add GitHub auth to the assistant example — landed (#1374, #1384)

GitHub OAuth lifted from `examples/auth-agent` into `examples/assistant`,
the Worker owns DO naming, and the per-user-directory pattern is now the
real default for the multi-session work. Validated the user-scoped parent
assumption — works cleanly.

## What ended up in the example

For posterity, the actual files in `examples/assistant/` after #1384:

- `src/server.ts` — `AssistantDirectory` (parent), `SharedWorkspace`,
  `SharedMCPClient`, `MyAssistant` (child facet). Plus the Worker that
  owns auth and routes `/chat*` to the directory. ~1200 lines, but the
  density is the point — it's the kitchen-sink reference.
- `src/use-chats.ts` — local `useChats()` hook exposing
  `{ directory, chats, workspaceRevision, mcpState, createChat,
renameChat, deleteChat, addMcpServer, removeMcpServer }`. Promotion
  candidate for `agents/react`.
- `src/client.tsx` — `MultiChatApp` shell with sidebar + active chat,
  per-chat `Chat` component receives shared state as props.

We did _not_ end up needing a separate `chats.ts` helper / base class.
The directory itself is just a regular `Agent` subclass that owns the
chat-meta SQLite table and a small RPC surface. Whether to extract that
into a `Chats` base class is PR 4's question.

## Cleanups landed so far

### Think config scaffolding — landed in PR #1372

- removed `_sessionId()`
- moved Think-private config into a dedicated `think_config(key, value)` table
- migrated legacy Think-owned keys (`_think_config`, `lastClientTools`,
  `lastBody`) out of `assistant_config(session_id, key, value)` when
  `session_id = ''`
- made the legacy copy insert-only so reruns on cold start cannot overwrite
  newer config
- updated current-state design docs to reflect the new storage layout

This cleanup removes the misleading impression that Think had a built-in
top-level multi-session model.

### Assistant GitHub auth + resume-stream stability — landed in PR #1374

The first half of "PR 2" from the original plan — auth + foundational
library fixes — has shipped. The multi-session parent/child refactor
(the second half, now tracked as PR 2b below) is still pending.

What landed:

- GitHub OAuth lifted from `examples/auth-agent` into `examples/assistant`;
  the Worker now owns DO naming via `getAgentByName(env.MyAssistant, user.login)`
- `run_worker_first` narrowed to `/auth/*` and `/chat*` (and the
  `routeAgentRequest` fallback removed) to close an auth-bypass where
  `/agents/my-assistant/<login>` was reachable unauthenticated
- `MyAssistant` set `sendIdentityOnConnect: true` so the client learns its
  server-assigned DO name
- `fix(think)`: Think's `onConnect` no longer broadcasts `CF_AGENT_CHAT_MESSAGES`
  while a resumable stream is in flight (matches `AIChatAgent`); unblocks
  mid-stream refresh without the assistant message disappearing
- `fix(ai-chat)`: `useAgentChat`'s `stableChatIdRef` is stable across in-place
  `agent.name` mutations, so `sendIdentityOnConnect: true` no longer orphans
  the AI SDK Chat instance and its in-flight `resumeStream()`
- `fix(example)`: `addMcpServer` callback routed via `callbackPath:
"chat/mcp-callback"` so MCP OAuth works without re-introducing `/agents/*`
  to the Worker (see follow-up issue #1378)

Both library fixes shipped with changesets and regression tests covering the
specific mid-stream refresh scenarios.

### Follow-ups queued from PR 2a

- **#1378** — `addMcpServer`'s existing `callbackPath` enforcement gets
  bypassed when `sendIdentityOnConnect: true`. The default callback URL
  (`/agents/<kebab-parent>/<instance>/callback`) then fails silently in any
  Worker that doesn't route `/agents/*` to `routeAgentRequest`. Candidate
  fix: always warn/throw on the default URL regardless of
  `sendIdentityOnConnect`, or require an explicit opt-in.

### Assistant multi-session + shared workspace + shared MCP — landed in PR #1384

The big one. Ten commits, ended up substantially broader than the original
PR 2b scope because the obvious next questions ("what's actually shared?")
kept getting good answers.

What landed:

- **Multi-session refactor.** `AssistantDirectory` is the per-user parent DO;
  each chat is a `MyAssistant` facet. Strict-registry `onBeforeSubAgent`
  gate, parent-owned `dailySummary` cron (facets can't `schedule()`),
  client-side `useChats()` hook and a sidebar UI in the example.
- **Shared workspace.** `AssistantDirectory.workspace` is the single
  `Workspace` instance for the user's files. Each child overrides
  `this.workspace` with a `SharedWorkspace` proxy that forwards to the
  parent over one DO RPC hop. Builtin tools, lifecycle hooks, the
  `listWorkspaceFiles`/`readWorkspaceFile` RPCs, and codemode's `state.*`
  sandbox API all route through it.
- **Shared MCP.** Same pattern, second pass — server registry, OAuth
  credentials, live connections, and tool descriptors live on the
  directory. Each child carries a `SharedMCPClient` proxy that builds the
  per-turn MCP ToolSet via one `parent.listMcpToolDescriptors` call and
  forwards each tool execute through `parent.callMcpTool`. OAuth callback
  is a single `/chat/mcp-callback` URL across every server in every chat.
  Auth once, tools available everywhere.
- **Live cross-tab/chat updates.** Workspace `onChange` →
  `directory.broadcast`; client's `useChats()` exposes a `workspaceRevision`
  counter that the file-browser `useEffect` keys on. MCP state is also a
  reactive value via the standard `CF_AGENT_MCP_SERVERS` broadcast.
- **Two non-breaking library typing improvements (also shipped in #1384):**
  - `@cloudflare/think`: `WorkspaceLike` (`Pick<Workspace, …>` of the 7
    methods Think calls). `Think.workspace` retyped to it; subclasses can
    swap in any conforming implementation. Default behavior unchanged.
  - `@cloudflare/shell`: `WorkspaceFsLike` (the wider 16-method surface
    `WorkspaceFileSystem` needs). `WorkspaceFileSystem` and
    `createWorkspaceStateBackend` accept it. Drops `as never` casts in
    existing tests; adds two substitutability tests including an async
    proxy driving a multi-file `planEdits`.
- **Security tightening.** `@callable()` audit caught two server-internal
  RPCs (`recordChatTurn`, `postDailySummaryPrompt`) that had been
  accidentally exposed to the browser. Dropped the decorator; both are
  now DO-RPC-only.
- **Auth bypass closed (carried from PR #1374).** `wrangler.jsonc`
  narrowed; `routeAgentRequest` fallback removed.

Per-chat state explicitly preserved: extensions, messages, Think config,
branch history. The README spells out the boundary.

Architectural decisions worth referencing later:

- **Option B.1 (parallel field) over B.2 (framework `MCPClientManagerLike`).**
  Each child has its own dead-but-present `this.mcp`; a parallel
  `sharedMcp` field carries the proxy. Avoids redoing the whole MCP
  surface as an interface and lets the framework's internal `this.mcp.*`
  calls continue resolving against an empty client.
- **Tool injection via `beforeTurn`.** Returning `{ tools }` from
  `beforeTurn` merges additively over the base tool set, so we never
  needed to touch the `this.mcp.getAITools()` call site in `_runInferenceLoop`.
- **Two cached parent stubs per child** (one in `SharedWorkspace`, one in
  `SharedMCPClient`). Acceptable duplication; consolidating costs more
  than it saves.

### Follow-ups queued from PR 2b

- **Test infrastructure for the example.** `examples/assistant` has no
  vitest setup, so none of the multi-chat wiring (parent state broadcast,
  child proxy round-trips, OAuth callback dispatch) has automated
  coverage. We've been leaning on the framework's own tests for the
  primitives we use, plus manual verification. Worth standing up a
  vitest+workers harness once we know the patterns are stable enough to
  pin.
- **Connection-count and isolate-serialization observations.** The shared
  MCP design puts every user's MCP connections on one DO isolate and
  serializes their tool calls through it. Fine at demo scale; if real
  users register dozens of servers and fire many concurrent tools, worth
  measuring before promoting.
- **MCP cross-child server-side fan-out.** No tool in this example reacts
  server-side to another chat's events (workspace or MCP). Easy
  parent → child RPC if a use case shows up.
- **Per-chat MCP filter.** `SharedMCPClient.getAITools(filter?)` is a
  natural extension point if "this chat shouldn't see server X" becomes a
  want.

## Open questions — answered by the assistant prototype

### 1. What should be shared across chats? — answered

PR #1384 settled this for the assistant example: **workspace and MCP shared,
everything else per-chat.** The deciding criterion turned out to be "does
this represent the user, or does it represent the chat?":

- Files are about the user's project state → shared. (Plus codemode's
  `state.*` editing only makes sense if multi-file plans see one source
  of truth.)
- MCP servers are about the user's external integrations → shared. Auth
  cost dominates, server lists drift if per-chat.
- Memory, messages, branch history → per-chat. They _are_ the chat.
- Extensions → per-chat. Custom tools authored by the model in this
  chat's flow shouldn't haunt unrelated chats. (Easy to flip if a fork
  wants the opposite — move `ExtensionManager`'s storage to the parent.)

### 2. What happens to scheduled work? — answered

`dailySummary` lives on `AssistantDirectory` and fans out to the
most-recently-active child via `subAgent(MyAssistant, id).postDailySummaryPrompt()`.
Idempotent schedule via `{ idempotent: true }`. Per-chat alarms remain
unsupported on facets — this is a workable workaround, not a permanent fix.

### 3. Do extensions work correctly in a child Think DO? — answered

Yes, no special handling needed. `ExtensionManager` reads `this.ctx.storage`
which works identically on facets and top-level DOs. Extensions persist
per-chat, exactly where they're loaded and used.

### 4. What should the eventual library boundary be? — partially answered

We now have a working prototype to compare against. Honest take after
shipping #1384:

- A `Chats` base class would shrink `AssistantDirectory` by maybe ~100
  lines (the `chat_meta` table, `_refreshState`, `onBeforeSubAgent` gate,
  `recordChatTurn`). Nontrivial but not enormous. Worth doing once we
  have one more consumer with the same shape.
- `useChats()` is small and the surface (chats list + CRUD + reactive
  state for whatever's shared) is generic. Prime promotion candidate.
- `SharedWorkspace` / `SharedMCPClient` are the surprise candidates: not
  a `Chats` thing, but a "shared parent-owned resource via DO RPC proxy"
  pattern. If we get a third instance of it, the proxy plumbing might
  be worth a generic helper. Not yet.
- Where to put any of this if/when we promote it: `agents` (multi-session
  / Chats is generic to any agent shape), `agents/react` (`useChats`),
  and library-level proxy types in `@cloudflare/shell` /
  `@cloudflare/think`.

PR 4 below is where the actual decision gets made.

## Open questions surfaced by PR #1384

### 5. Test coverage for example wiring

`examples/assistant` has no test setup. The shared-workspace and
shared-MCP wiring is exercised manually but not by CI. Stand up a
vitest+workers harness, even a minimal one, before the next major
refactor. Until then, every change has to be sanity-checked by hand.

### 6. Resource limits at scale

One DO per user means: one isolate hosts every workspace write, every
MCP tool invocation, every change broadcast. Fine at demo scale. Worth
measuring before recommending the pattern as a production reference for
users with many chats / many MCP servers / heavy concurrent tool use.

### 7. Graceful chat termination

`deleteSubAgent` is forceful — aborts the child immediately. If a chat
is mid-stream, the user's last LLM message is truncated. Two-phase
delete (mark as archived, drain, then wipe via `deleteSubAgent`) would
be nicer UX but adds real complexity. Park for a real product need.

## Proposed staged plan

### PR 1: Think cleanup — landed (#1372)

Think's private config now lives in `think_config`, legacy rows in
`assistant_config` are migrated on startup without clobbering newer
values, and the design docs + this plan were updated to match.

### PR 2a: GitHub auth + resume-stream stability — landed (#1374)

Scope that shipped:

- GitHub auth lifted from `examples/auth-agent` into `examples/assistant`
- `/chat*`-only Worker routing; `/agents/*` auth bypass closed
- Two library fixes unblocking mid-stream refresh (Think `onConnect` + ai-chat
  `stableChatIdRef`)
- MCP OAuth callback re-routed through the authenticated `/chat*` path

The original plan bundled the multi-session refactor into the same PR. We
deliberately split it so the auth-gated single-chat experience could land
quickly, unblock team-wide deployment, and give us a stable foundation to
iterate the parent/child refactor against. Multi-session work is now PR 2b
below.

### PR 2b: Assistant multi-session + shared workspace + shared MCP — landed (#1384)

The actual learning step shipped, scope-wider-than-planned-but-the-extras-felt-right:

- multi-session `AssistantDirectory` + `MyAssistant` facets + `useChats()`
- shared workspace via `SharedWorkspace` proxy (+ `WorkspaceLike` /
  `WorkspaceFsLike` library typing)
- live workspace change-event broadcast → reactive `workspaceRevision`
- shared MCP via `SharedMCPClient` proxy + parent-owned MCP state +
  single `/chat/mcp-callback` URL
- `@callable()` audit, security hardening, README + boundary docs

See "Cleanups landed so far" above for the full breakdown.

### PR 3: Hoist chat React hook(s) into `agents`

Goal: fix the current package boundary where Think consumers import the main
chat hook from `@cloudflare/ai-chat/react`.

Scope:

- move the shared hook implementation into `agents`
- keep back-compat re-exports from `@cloudflare/ai-chat/react`
- update Think-oriented examples to import from the new home

This should happen after the assistant prototype so we know what new hook
surface we actually want.

Known wart worth fixing in this PR: `useAgentChat` always issues an HTTP
`GET /get-messages` on the second render (once the socket URL resolves)
and uses `use()` to suspend during that fetch. AIChatAgent needs this,
because its `onConnect` does not broadcast message history. Think does
broadcast the full history on WebSocket connect, so the HTTP fetch is
technically redundant and causes a transient Suspense flash between the
initial WS-seeded render and the fetch resolving. A Think-native chat
hook can skip the HTTP fetch entirely and drive initial state from the
WebSocket, eliminating the flash.

(Historical note: two earlier resume bugs that caused the in-progress
assistant to stay hidden after a mid-stream refresh — Think's
`onConnect` broadcasting `CF_AGENT_CHAT_MESSAGES` mid-stream, and
`useAgentChat` recreating the AI SDK Chat instance on in-place
`agent.name` transitions — are now fixed in `@cloudflare/think` and
`@cloudflare/ai-chat` respectively. `getInitialMessages: null` is safe
to use for Think consumers once those fixes are released, so the
Think-native hook can default-disable the HTTP fetch.)

### PR 4: Decide what to promote into the library

Only after the prototype settles:

- decide whether to promote `Chats`
- decide whether to promote `useChats()`
- decide which package should own each abstraction
- write the more permanent design/docs updates

## What this plan is optimizing for

This approach is deliberately opinionated:

- optimize for learning from a real example before freezing APIs
- keep the shipped routing primitive as the foundation
- avoid inventing another routing layer
- avoid overfitting early abstractions
- improve the assistant example so the team can actually deploy and use it
- clean up stale Think internals now, even if higher-level APIs come later

## Current status

- the sub-agent routing primitive is shipped
- `examples/multi-ai-chat` is the minimal proof of the primitive
- the Think config cleanup landed in PR #1372
- GitHub auth + resume-stream stability landed in PR #1374
- multi-session refactor + shared workspace + shared MCP landed in PR #1384
  - `examples/assistant` is the kitchen-sink Think reference for the
    multi-session pattern
  - `WorkspaceLike` (`@cloudflare/think`) and `WorkspaceFsLike`
    (`@cloudflare/shell`) are exported types that make substitute
    workspaces a first-class library concept
  - `Chats` and `useChats()` are still example-local prototypes
- issue #1378 tracks the `addMcpServer` enforcement ergonomics follow-up

## Likely next action

PR 3: hoist `useAgentChat` (and any companion chat React primitives) from
`@cloudflare/ai-chat` into `agents`, with back-compat re-exports from
`@cloudflare/ai-chat/react`. The known wart on `useAgentChat`'s
`getInitialMessages` HTTP fetch is now safe to address (the resume-stream
fixes from #1374 have been released), and Think consumers will stop having
to reach into `ai-chat` for the core hook.

PR 4 follows once PR 3 settles: decide whether `Chats` / `useChats()` /
`SharedWorkspace` / `SharedMCPClient` patterns from `examples/assistant`
deserve to be promoted into framework primitives, and which package owns
each. With one full consumer in hand and the proxy/`*Like` patterns
proving useful at the library level, the answer should be clearer.
