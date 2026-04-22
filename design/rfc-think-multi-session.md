# RFC: Think Multi-Session via Composition

Status: proposed

Supersedes the "Multi-Session Support" section of [`think-sessions.md`](./think-sessions.md) (the unimplemented `SessionManager`-inside-Think plan).

## Summary

Make "multi-session" in Think a **composition pattern** rather than an internal feature:

1. One Think DO = one conversation. This is already how Think is built.
2. Ship a small `Chats` parent Agent for listing/creating/deleting chats and holding shared state. Child chats are sub-agents of the `Chats` DO; clients reach them via the sub-agent routing primitive that shipped in [`rfc-sub-agent-routing.md`](./rfc-sub-agent-routing.md).
3. Ship generic `RemoteContextProvider` / `RemoteSearchProvider` so a Session on one DO can read/write a context block on another DO over RPC.
4. Ship a React hook `useChats()` that wraps "connect to directory + connect to active chat" around the shipped `useAgent({ sub: [...] })` primitive.
5. Kill the `_sessionId()` stub and the `session_id` column in `assistant_config`.

`SessionManager` stays in `agents/experimental/memory/session` as an advanced primitive for people who really want many `Session`s inside one DO. Think does not use it.

## Problem

Today:

- Think has a stubbed-out `_sessionId()` that returns `""` and an `assistant_config` table keyed on `(session_id, key)` that never keys on anything. The scaffolding suggests "top-level multi-session inside one Think DO" but the feature was never built.
- Users who want ChatGPT-like "list of my chats, shared memory, cross-chat search" have to hand-roll every part: the directory, the shared memory wiring, the search aggregation, the client UI.
- The older [`think-sessions.md`](./think-sessions.md) design proposed adding `SessionManager` to Think (Option A below). That would force all of a user's conversations to serialize onto a single Durable Object — Durable Objects are single-threaded.

## Proposal

### Mental model

```
User / tenant agent                ◄── optional: your existing auth entity
    │
    └─ Chats  (one DO per "workspace"/"user")
         │  — chat index (id, title, timestamps, last message preview)
         │  — shared memory (RemoteContextProvider source via @callable)
         │
         ├─ Think child "chat-abc"   ◄── one DO per conversation
         ├─ Think child "chat-def"
         └─ Think child "chat-ghi"
```

WebSocket connections go **directly to the child** for chat. The directory is only used for metadata, shared state, and list-level operations. Parent ↔ child communication is DO RPC via `subAgent()`.

Key point: **`Chats` is just an `Agent`.** It happens to maintain a table of child chat ids and exposes some helpers. There is no special "chat child" role at runtime — if `Chats` needs its own utility sub-agents for other work (search indexer, background summarizer, whatever), it uses `subAgent()` normally, just with class names distinct from the chat child class.

### Cleanups in Think core (breaking — we haven't released)

Drop the unused `session_id` scaffolding. It misleads contributors.

- Remove `_sessionId()` from `Think`.
- Drop `session_id` from the `assistant_config` schema; `(key)` becomes the PK.
- Internal `_configGet` / `_configSet` / `_configDelete` simplify accordingly.

No user-facing API changes; only the internal table shape.

### New: `Chats` base class

Shipped as part of `@cloudflare/think` (the RPC shapes are shaped for chat: titles, last-message previews, fork-at-message later). Not in `agents/` because its vocabulary is chat-specific.

```ts
// packages/think/src/chats.ts

import { Agent, callable } from "agents";
import type { SubAgentClass, SubAgentStub } from "agents";

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
}

export interface ChatListOptions {
  limit?: number;
  before?: number;        // cursor: updatedAt
  search?: string;        // directory-local search over titles
}

export interface ChatHit {
  chatId: string;
  messageId: string;
  snippet: string;
}

export interface ChatsState {
  chats: ChatSummary[];
}

/**
 * Parent agent that owns a list of chat sub-agents and their shared
 * state. One instance per user / tenant / workspace.
 *
 * The child class does not have to be a `Think` — any `Agent` that
 * `subAgent()` can spawn is fine. In practice it's usually `Think`.
 */
export abstract class Chats<
  Env extends Cloudflare.Env = Cloudflare.Env,
  ChildClass extends SubAgentClass<Agent<Env>> = SubAgentClass<Agent<Env>>,
  State extends ChatsState = ChatsState,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  /** Must return the Agent subclass used for chats (usually a `Think` subclass). */
  abstract getChildClass(): ChildClass;

  /** Optional: override to supply chat ids (default: crypto.randomUUID()). */
  protected createChatId(): string {
    return crypto.randomUUID();
  }

  /**
   * Optional: override to generate a title.
   * Default: "Chat — {isoDate}". No LLM call, no side effects.
   */
  protected async generateTitle(_firstMessage?: string): Promise<string> {
    return `Chat — ${new Date().toISOString().slice(0, 10)}`;
  }

  // ── SQLite schema (managed internally) ──────────────────────────
  //
  // CREATE TABLE chats_index (
  //   id TEXT PRIMARY KEY,
  //   title TEXT NOT NULL,
  //   created_at INTEGER NOT NULL,
  //   updated_at INTEGER NOT NULL,
  //   last_message_preview TEXT,
  //   deleted_at INTEGER    -- soft delete, cleaned up lazily
  // );
  // CREATE VIRTUAL TABLE chats_fts USING fts5(title, ...);

  @callable()
  async createChat(opts?: { title?: string }): Promise<ChatSummary>;

  @callable()
  async listChats(opts?: ChatListOptions): Promise<ChatSummary[]>;

  @callable()
  async deleteChat(id: string): Promise<void>;

  @callable()
  async renameChat(id: string, title: string): Promise<void>;

  /** Local FTS over chat titles. */
  @callable()
  async searchChats(query: string): Promise<ChatSummary[]>;

  /**
   * FTS across the message content of *all* chats in this directory.
   * Fanout: calls each child's `session.searchMessages(query)` over RPC
   * and merges by rank. Fine up to ~50 active chats; beyond that,
   * see followups.
   */
  @callable()
  async searchMessages(
    query: string,
    opts?: { limit?: number }
  ): Promise<ChatHit[]>;

  /**
   * Shared context block storage. Children hold `RemoteContextProvider`
   * instances that call these methods.
   *
   * Writes are last-writer-wins. For additive memory (the common
   * case), children should use `appendSharedContext` instead.
   */
  @callable()
  async getSharedContext(label: string): Promise<string | null>;

  @callable()
  async setSharedContext(label: string, content: string): Promise<void>;

  @callable()
  async appendSharedContext(label: string, delta: string): Promise<void>;

  // ── Search-provider hooks (for RemoteSearchProvider) ────────────

  @callable()
  async searchShared(label: string, query: string): Promise<string | null>;

  @callable()
  async indexShared(
    label: string,
    key: string,
    content: string
  ): Promise<void>;

  // ── Spawning chats ──────────────────────────────────────────────

  /** Typed stub for one chat. Idempotent — creates lazily via `subAgent`. */
  async getChat(id: string): Promise<SubAgentStub<InstanceType<ChildClass>>> {
    return this.subAgent(this.getChildClass(), id);
  }
}
```

All `@callable()` methods stream through the normal agents-RPC path and are reachable from the client via `useChats()` or a bare `useAgent()` call.

### New: Remote context / search providers

Lives in `agents/experimental/memory/session/providers/remote.ts`. Generic — no knowledge of `Think` or `Chats`. Pairs with the existing `AgentContextProvider` (which is a "local SQLite" provider; see follow-ups for renaming that to `SqliteContextProvider` for clarity).

```ts
// packages/agents/src/experimental/memory/session/providers/remote.ts

import type { WritableContextProvider } from "../context";
import type { SearchProvider } from "../search";

/**
 * A minimal RPC contract: any agent that exposes these four methods
 * (directly as DO RPC methods) can back a RemoteContextProvider.
 *
 * `Chats` implements this via its @callable methods, but any agent
 * with matching signatures works.
 */
export interface RemoteContextEndpoint {
  getSharedContext(label: string): Promise<string | null>;
  setSharedContext(label: string, content: string): Promise<void>;
  appendSharedContext?(label: string, delta: string): Promise<void>;
}

export interface RemoteSearchEndpoint {
  searchShared(label: string, query: string): Promise<string | null>;
  indexShared(label: string, key: string, content: string): Promise<void>;
}

/**
 * A context block backed by RPC to another agent.
 * `get()`/`set()` forward to the remote; the remote owns storage.
 */
export class RemoteContextProvider implements WritableContextProvider {
  private label = "";
  constructor(
    private remote: RemoteContextEndpoint,
    /** Optional — defaults to the block's own label. */
    private namespace?: string
  ) {}

  init(label: string) {
    this.label = this.namespace ?? label;
  }

  async get(): Promise<string | null> {
    try {
      return await this.remote.getSharedContext(this.label);
    } catch {
      // Fail-soft: remote unavailable → treat as empty this turn.
      return null;
    }
  }

  async set(content: string): Promise<void> {
    await this.remote.setSharedContext(this.label, content);
  }

  /** Optional convenience — lets callers append without a get+set round trip. */
  async append(delta: string): Promise<void> {
    if (this.remote.appendSharedContext) {
      await this.remote.appendSharedContext(this.label, delta);
    } else {
      const current = (await this.get()) ?? "";
      await this.set(current + delta);
    }
  }
}

export class RemoteSearchProvider implements SearchProvider {
  private label = "";
  constructor(
    private remote: RemoteSearchEndpoint & RemoteContextEndpoint,
    private namespace?: string
  ) {}

  init(label: string) {
    this.label = this.namespace ?? label;
  }

  async get(): Promise<string | null> {
    try {
      return await this.remote.getSharedContext(this.label);
    } catch {
      return null;
    }
  }

  async search(query: string): Promise<string | null> {
    try {
      return await this.remote.searchShared(this.label, query);
    } catch {
      return null;
    }
  }

  async set(key: string, content: string): Promise<void> {
    await this.remote.indexShared(this.label, key, content);
  }
}
```

Used inside a Think subclass like this:

```ts
class MyChat extends Think<Env> {
  configureSession(session: Session) {
    const dir = this.parentAgent(MyChats);
    return session
      .withContext("memory", {
        description: "Facts about the user",
        maxTokens: 2000,
        provider: new RemoteContextProvider(dir, "user_memory")
      })
      .withCachedPrompt();
  }
}
```

### Reaching the parent from a child

The sub-agent routing work now ships two complementary primitives on `Agent`:

- `this.parentPath` — the full root-first ancestor chain (`Array<{ className, name }>`), useful when you need to walk multiple levels up.
- `this.parentAgent(Cls)` — the ergonomic one-hop helper for the direct parent.

For the common case, use `parentAgent(Cls)`:

```ts
class MyChat extends Think<Env> {
  private getInbox() {
    return this.parentAgent(MyChats);
  }
}
```

For grandparents and further ancestors, use `this.parentPath[i]` plus the namespace lookup directly. `parentAgent()` is intentionally single-hop.

### New: `useChats()` React hook

Thin wrapper over the now-available `useAgent({ agent, name, sub: [{ agent, name }] })` primitive (shipped in the sub-agent routing RFC). This hook exists purely to bundle directory-state broadcasts + active-chat connection management into one ergonomic shape.

```ts
// packages/agents/src/react-chats.tsx (or similar)

export interface UseChatsOptions {
  /** Class name of the Chats subclass (kebab-case), e.g. "my-chats". */
  directory: string;
  /** Name of the Chats DO instance (usually a user id). */
  name: string;
  /** Class name of the chat child agent (usually your Think subclass). */
  chatAgent: string;
  /** The chat id to open. If omitted, no chat is active. */
  activeChatId?: string;
}

export interface UseChatsReturn {
  chats: ChatSummary[];
  createChat: (opts?: { title?: string }) => Promise<ChatSummary>;
  deleteChat: (id: string) => Promise<void>;
  renameChat: (id: string, title: string) => Promise<void>;
  searchChats: (q: string) => Promise<ChatSummary[]>;

  /** Live `useAgent` connection to `activeChatId`, or null. */
  chat: ReturnType<typeof useAgent> | null;
}

export function useChats(opts: UseChatsOptions): UseChatsReturn;
```

- `chats` comes from the directory's broadcast state (`state.chats`).
- `chat` is `useAgent({ agent: directory, name, sub: [{ agent: chatAgent, name: activeChatId }] })` — the actual framework primitive — that re-initializes when `activeChatId` changes. The child address goes into the `sub:` array; the top-level hook address is the Chats directory. Downstream consumers (`useAgentChat`, etc.) see `.agent` / `.name` pointing at the child leaf.
- `useAgentChat` hangs off `chat` and works unchanged.
- Active chat selection is _client-side_; the directory doesn't track it.

### Reference example

`examples/chats` — minimal ChatGPT-style app:

- `MyChats extends Chats<Env>` with a `user_memory` block stored locally (SQLite) in the parent.
- `MyChat extends Think<Env>` with a `RemoteContextProvider` pointing at `user_memory` via its parent.
- React UI: sidebar of chats (from directory state) + active chat (Think + `useAgentChat`).

## Alternatives considered

| Option                                                   | What it is                       | Why not                                                                                                                                                                                             |
| -------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — `SessionManager`-in-Think                            | One Think DO hosts many Sessions | Serializes inference across a user's chats (DO is single-threaded); massive internal refactor. `SessionManager` remains in `experimental/memory/session` for niche cases, but Think doesn't use it. |
| B — "Just use `subAgent` yourself" (no framework help)   | Status quo                       | Every app re-implements directory, memory, search, sidebar. We can do better.                                                                                                                       |
| C — Chats + per-chat DOs (this RFC)                      | Parent directory + per-chat DOs  | **Chosen.** Parallelism aligned with how Workers execute; composition-friendly; matches real product shapes.                                                                                        |
| D — Namespaced slice in one DO via `?session=` on WS URL | Middle ground                    | All the cons of A plus a more confusing protocol. Rejected.                                                                                                                                         |

## Edge cases

### Directory correctness

1. **Row without child DO.** A directory row can exist for a chat whose child DO has never actually been spoken to (user created then deleted, network error). `getChat()` tolerates this — `subAgent()` creates the DO lazily; if it's never spoken to, it never costs anything.
2. **Child DO without row.** If the directory is wiped but children remain: they'll be hibernated and eventually GC'd by the normal DO path. Repairing this is a follow-up, not v1.
3. **Delete during active use.** User has chat X open in tab A, deletes it in tab B. Directory marks row `deleted_at=now()`, broadcasts new `chats` state, the `useChats` hook sees X gone and drops the active connection. The child DO is left to hibernate and be deleted by TTL. Do **not** hard-delete immediately — in-flight writes may still be persisting.
4. **Soft delete window.** `deleteChat` is idempotent; re-creating the same id inside the soft-delete window purges the old row and starts fresh. A generation counter on the row prevents stale re-connects.
5. **Rename broadcast.** Directory renames, broadcasts new state, React re-renders. Children don't learn of the new title — they don't need to.

### Shared memory

6. **Concurrency.** The directory DO is single-threaded; two child writes can't actually interleave. What you still need to guard against is **lost updates from read-modify-write**: child A reads memory, child B writes, child A writes back, B's update is gone. Mitigation: prefer `appendSharedContext(label, delta)` for the common additive case; reserve `setSharedContext` for full replacement. Document it.
7. **Stale frozen snapshot.** Child freezes the system prompt (including `user_memory`). Parent memory updates from another chat mid-turn. Accept staleness for the current turn; `session.refreshSystemPrompt()` pulls fresh content on the next turn boundary.
8. **Parent cold start.** First call to `getSharedContext()` in a turn wakes the parent. Adds RPC latency. Usually once per turn (Session's `withCachedPrompt()` caches the frozen prompt).
9. **Parent RPC failure.** `RemoteContextProvider.get()` returns `null` instead of throwing — chat must keep working even if shared memory is briefly unreachable. Inference continues with an empty memory block; next turn it'll retry.
10. **Parent deletion with live children.** Same fail-soft path: each turn `RemoteContextProvider.get()` returns `null`, so the child keeps working in a memoryless mode. No cascade failures.

### Search

11. **Fanout cost.** `searchMessages` across N chats is N parallel RPCs. Bounded by `opts.limit` globally; fine for N up to ~50. Beyond that, see follow-ups for an indexed path.
12. **Auth / tenancy.** The directory's DO id is the tenant boundary — one directory per user. Multi-tenant in one directory is out of scope.

### Lifecycle

13. **Title on first message.** v1 uses the default ("Chat — date"). A child that wants nicer titles can override its own `onChatResponse` and call `await this.parentAgent(MyChats).renameChat(this.name, title)` after the first user message. No framework-level "auto-title" machinery.
14. **Per-connection active chat.** Different tabs / devices can have different active chats. This is handled entirely client-side by `useChats()`. The directory has no `activeChatId` field.

### Sub-agents inside chats

15. **Chats can have their own sub-agents.** A `Think` chat that uses a `Researcher` sub-agent for tool execution is normal `subAgent()` usage; nothing in this RFC changes. Facet keys are `${className}\0${name}`, so naming collisions between your chat class and a utility sub-agent are impossible as long as the class names differ.
16. **`parentAgent()` is single-hop.** A Researcher inside a Think chat inside `Chats` gets back the Think as its parent, not `Chats`. If you want the Researcher to write to shared memory, pass the `Chats` stub into the Researcher explicitly — don't assume global context.
17. **`Chats` can have its own sub-agents too.** If the directory needs a background `SearchAggregator` or similar, use `subAgent(SearchAggregator, "idx")`. Pick class names that don't collide with the chat child class.

### Protocol and client

18. **Switching active chat mid-stream.** Closing the previous WS (code 1000) is fine — Think's resumable streams replay buffered chunks when the user returns. Tabs that want to keep multiple streams live can hold multiple WS connections open.
19. **Optimistic create.** `createChat()` is a directory DO write: authoritative, broadcasts state, returns a full `ChatSummary`. No client-side temp ids needed.
20. **Leak risk.** `ChatsState.chats` is broadcast to clients. Don't put anything sensitive in `ChatSummary`; use a separate `@callable` for privileged reads.

### Typing

21. **`Chats` is not Think-bound.** `ChildClass extends SubAgentClass<Agent<Env>>`. If users want a `Think`-specific directory they can narrow: `extends Chats<Env, SubAgentClass<MyThink>>`.
22. **Shared memory is stringly-typed** by design — it's `WritableContextProvider`. Structured shared state goes through dedicated `@callable` methods on the directory (e.g., `getPreferences()`), not through memory blocks.

## Migration / rollout

The routing primitive (`onBeforeSubAgent`, `routeSubAgentRequest`, `getSubAgentByName`, `parentPath`, `useAgent({ sub })`, registry + introspection) has landed — see [`rfc-sub-agent-routing.md`](./rfc-sub-agent-routing.md). This RFC now builds directly on top.

Since Think hasn't been released (`0.x`, no `1.0` yet):

1. Cut a small breaking change: remove `_sessionId()` + `session_id` column from Think's `assistant_config` table. Minor-bump changeset.
2. Land `Chats` in `@cloudflare/think` alongside the existing exports. Its `getChat(id)` returns `await this.subAgent(this.getChildClass(), id)`, and `deleteChat(id)` does `this.deleteSubAgent(this.getChildClass(), id)` — both rely on the already-shipped registry.
3. Land `RemoteContextProvider` / `RemoteSearchProvider` in `agents/experimental/memory/session/providers/remote.ts`.
4. Land `useChats()` React hook — thin wrapper over `useAgent({ agent, name, sub: [{ agent, name }] })`.
5. Ship `examples/chats` + docs page `docs/think/multi-chat.md`.
6. Cross-link from `docs/think/index.md` and remove the `SessionManager`-flavored section in `think-sessions.md`.
7. Keep `SessionManager` in `experimental/memory/session` with a README note pointing at this RFC for the common case.

## Follow-ups (intentionally out of v1)

These are features we explicitly decided not to build in v1 to keep the surface small. All can land later without breaking v1 users.

| Follow-up                                               | Why deferred                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forkChat(id, atMessageId, title)`                      | Has its own design space (message copy vs link, branch propagation, compactions pointing at ancestor messages). Adds enough complexity to deserve its own RFC.                                                                        |
| Indexed cross-chat search                               | Fanout scales to ~50 chats. Past that, we'd maintain a parent-side FTS index populated by child `onChatResponse` hooks. Build when someone hits the wall.                                                                             |
| Cross-tab shared-memory sync                            | `_notifySharedChange` broadcast so tabs see memory updates without a reload. The directory already re-broadcasts its own state on its own writes; memory writes from a child are a distinct event. Easy to add, nothing blocks on it. |
| LLM-generated titles                                    | Core stays side-effect-free. Users who want this override `generateTitle()` and call their own LLM. We could ship a `withLLMTitles(model)` mixin later if patterns converge.                                                          |
| Session archive / GC                                    | Auto-delete chats older than N days. Nice to have, not essential.                                                                                                                                                                     |
| Session export / import                                 | For backups and portability. Small RPC surface, can add later.                                                                                                                                                                        |
| Multi-tenant within one directory                       | Current design is "one directory per tenant." Multi-tenant would need row-level auth and filtered callables. Deliberately out of scope.                                                                                               |
| Shared `Workspace` across chats                         | Plausible but adds scope (R2 spillover, concurrency on the same files). Better to learn from real usage before committing to a shape.                                                                                                 |
| `repair()` admin method                                 | For orphan detection / index reconciliation. Defer until we actually observe orphans.                                                                                                                                                 |
| Rename `AgentContextProvider` → `SqliteContextProvider` | Clarifies the existing naming (paired with `RemoteContextProvider`). Not strictly required for this RFC; do it as a follow-up cleanup.                                                                                                |
| Protocol message: `chat-deleted`                        | So a chat client knows its chat was deleted and can redirect. Currently the sidebar-side signal (state broadcast) is enough; add a dedicated event if UX needs it.                                                                    |

## Open questions

- **`Chats` in `@cloudflare/think` vs a new `@cloudflare/chats`.** I lean Think: chat vocabulary is baked into the RPC shapes (titles, previews). Easier DX in one package.
- **Should shared-context writes go through a lock?** Answer (in v1): no — DO is single-threaded, and we document `appendSharedContext` as the safe additive primitive. Revisit if we see lost updates in practice.
- **Should `RemoteContextProvider` live in `agents/` or `think/`?** Leaning `agents/experimental/memory/session/providers` — it's Session-generic and has no Think dependency.

## Non-goals

- Multi-user _within_ a chat (shared rooms). Already works via Think's WS broadcast; orthogonal.
- Branches inside a chat. Already works via Session's tree storage.
- End-to-end encryption of messages.
- A general-purpose "agent supervisor" base class. `Chats` is chat-specific; we're not building a universal directory.
