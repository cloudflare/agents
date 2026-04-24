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

### 3. Do not ship a library `Chats` abstraction yet

There was an initial instinct to promote the pattern into a reusable `Chats`
base class immediately. Current thinking is to hold off.

Why delay it:

- the amount of boilerplate is not huge
- the remaining boilerplate is mostly opinionated policy, not raw plumbing
- we do not yet know the right long-term shape for metadata, shared memory,
  auth, or Think-specific UX
- the assistant example is a better place to validate the API before freezing
  it in a package

The same logic applies to `useChats()`: prototype it in the assistant example
first, then promote it only if the shape feels obviously right.

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

### 5. Add GitHub auth to the assistant example

The current assistant example is powerful but not team-friendly to deploy and
use together. Bringing over the GitHub auth layer from `examples/auth-agent`
would let us:

- deploy the assistant and use it as a team
- naturally scope one parent directory DO per authenticated user
- exercise the real user-boundary story rather than relying on a demo id

This change also helps validate whether the multi-session parent should really
be user-scoped, which is the current assumption.

## The proposed implementation direction

The next phase should be an example-first prototype inside
`examples/assistant`, not a library-first abstraction.

### High-level shape

Refactor the assistant into a parent/child structure:

- `AssistantDirectory` (parent)
  - one DO per authenticated GitHub user
  - owns the chat list/sidebar state
  - owns per-user shared state if we decide to keep any
  - gates access to children with `onBeforeSubAgent`
- `MyAssistant` (child)
  - one Think DO per conversation
  - keeps the existing Think-heavy features:
    - workspace tools
    - execute
    - extensions
    - compaction
    - search
    - config
    - MCP
    - recovery

Client shape:

- one connection to the parent for sidebar state
- one connection to the active child using `useAgent({ sub: [...] })`
- a local prototype of `useChats()` in the example to wrap the above

### Local prototype files to add in the example

Instead of shipping library APIs immediately, prototype them locally:

- `examples/assistant/src/chats.ts`
  - local helper or base class for parent directory behavior
- `examples/assistant/src/use-chats.ts`
  - local `useChats()` hook tuned to the assistant UI

These files are explicitly exploratory. If they turn out to be a great fit, we
can later promote them into `packages/agents` or `packages/think`.

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

## Open questions to validate in the assistant prototype

### 1. What should be shared across chats?

The assistant currently has a `memory` context block inside each Think
instance. Once we split into parent + child, we need to decide whether:

- memory remains per-chat for now
- some memory becomes shared across all chats under the parent

The likely answer is to start simple and avoid introducing remote context
providers until we know we need them.

### 2. What happens to scheduled work?

Sub-agents/facets currently do not support independent alarms in the same way
top-level agents do. The assistant currently uses scheduled work
(`dailySummary`), so we will need to decide whether that moves to the parent or
is temporarily disabled in multi-session mode.

Most likely answer:

- move schedule ownership to the parent
- let the parent fan out to the relevant child chat(s) if needed

### 3. Do extensions work correctly in a child Think DO?

The assistant uses extension loading. We need to verify that all of the
extension machinery behaves correctly when `MyAssistant` is a sub-agent rather
than a top-level DO.

This needs real testing in the example, not just design reasoning.

### 4. What should the eventual library boundary be?

Still unresolved:

- should a future `Chats` abstraction live in `agents` or `think`?
- should a future `useChats()` hook live in `agents/react` or `@cloudflare/think`?
- should the chat React hook itself move into `agents` first?

The prototype should help answer these.

## Proposed staged plan

### PR 1: Think cleanup — landed (#1372)

Think's private config now lives in `think_config`, legacy rows in
`assistant_config` are migrated on startup without clobbering newer values, and
the design docs + this plan were updated to match. This is the only piece of
this roadmap that has actually shipped.

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

### PR 2b: Assistant multi-session refactor (next)

Goal: the actual learning step — turn the auth-gated single-chat assistant
into a parent/child multi-session app, backed entirely by the shipped
sub-agent routing primitive. This is the piece that validates whether a
future `Chats` / `useChats()` library abstraction makes sense.

Scope:

- introduce `AssistantDirectory` (parent DO, one per authenticated GitHub user)
  - owns the chat list / sidebar state
  - gates access to children via `onBeforeSubAgent`
  - owns any per-user shared state we decide to keep
- keep `MyAssistant` as the child DO (one per conversation), still the place
  where all existing Think features live (workspace, execute, extensions,
  compaction, search, config, MCP, recovery)
- Worker stays as the single entry point; `/chat*` continues to require a
  valid GitHub session
  - sidebar connection resolves to `AssistantDirectory` by user login
  - active-chat connection uses nested sub-agent routing via
    `useAgent({ sub: [...] })`
- prototype `useChats()` and (optionally) a `Chats` helper locally in the
  example; no library changes yet
- UI: sidebar with chat list, new-chat action, active-chat view

This PR should prioritize real usability and learning over framework purity.
The whole point of doing it in the example first is to find out what the
right library shape is, not to ship one.

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
- `examples/multi-ai-chat` is the proof-of-value for the primitive
- the Think config cleanup landed in PR #1372
- GitHub auth + resume-stream stability landed in PR #1374
- the assistant is now deployable as a single-chat-per-user, auth-gated app
- mid-stream refresh now resumes correctly in both Think and `useAgentChat`
- `Chats` and `useChats()` are still example-local prototypes first
- issue #1378 tracks the `addMcpServer` enforcement ergonomics follow-up

## Likely next action

Start PR 2b: the parent/child refactor of `examples/assistant`. Introduce
`AssistantDirectory` as a per-user parent DO, keep `MyAssistant` as the
per-chat child, wire them together with the existing sub-agent routing
primitive, and prototype `useChats()` locally in the example before deciding
whether any of it graduates to the library.
