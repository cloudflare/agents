# RFC: User hub with one Durable Object per chat

Status: proposed

Proposes replacing the facet-backed chat topology in
[`rfc-think-multi-session.md`](./rfc-think-multi-session.md). If accepted, that
RFC should be marked rejected and point here as its replacement.

Related:

- [`rfc-ai-chat-maintenance.md`](./rfc-ai-chat-maintenance.md) records that
  `AIChatAgent` and `Think` are both supported chat bases.
- [`sub-agent-routing.md`](./sub-agent-routing.md) describes the current
  facet-backed routing mechanics.
- [`examples/next/chats`](../examples/next/chats) demonstrates the basic
  two-object shape: a per-user index and independent chat Durable Objects.
- [`examples/assistant`](../examples/assistant) shows the user-scoped services
  that must remain shared across chats: workspace, MCP connections, OAuth, and
  cross-chat scheduling.

## Summary

Model a multi-chat product with two top-level Durable Object roles:

1. One **User agent** per user. It is the user-scoped hub, catalog, and shared
   service owner.
2. One **Chat agent** per conversation. It owns that conversation's transcript,
   inference, streaming, recovery, and chat-local work.

A browser normally keeps two WebSockets open:

- one to the User agent for the sidebar and shared user services;
- one to the active Chat agent for the conversation.

Changing the active chat closes or detaches the old chat connection and opens a
connection to the newly selected Chat agent. The User connection stays open.
There is no new multiplexed chat protocol.

The User agent remains the authority through which a client resolves a chat.
After it checks the catalog and forwards the WebSocket upgrade, the Chat agent
owns the upgraded socket. Ordinary chat frames do not wake or serialize through
the User agent.

Chat agents call the User agent over ordinary Durable Object RPC for shared
workspace and memory access, MCP discovery and invocation, and catalog updates.
Facet-backed dynamic agents remain appropriate inside either object for
parent-supervised work such as generated code, codemode runtimes, researchers,
and agent-tool runs.

This RFC does not propose a framework `Chats` base class or a generic
`useChats()` package export. The catalog schema, shared services, deletion
policy, and permissions are application policy. We should first ship the hard
routing and consistency rules through examples and small reusable adapters.

## Terminology

**User agent**
: A top-level Durable Object keyed by the application's stable user identity.
It owns the chat catalog and services shared by that user's chats.

**Chat agent**
: A top-level Durable Object for one user-visible conversation. It can extend
either `AIChatAgent` or `Think`.

**Chat id**
: The application-visible identifier stored in the User agent's catalog and
used in URLs. It is not required to equal the physical Durable Object name.

**Chat generation**
: An immutable token allocated when a catalog entry is created. Metadata writes
from a Chat agent must include it, preventing delayed writes from an old or
deleted Chat agent from changing a newer catalog entry with the same chat id.

**Think Session**
: Think's in-process conversation and context model inside one Chat agent. It is
not the same thing as the Chat agent itself. This RFC intentionally uses
"Chat agent" rather than "session DO" where the distinction matters.

## Problem

Facet-backed chats have useful ergonomics: a parent registry, `parentAgent()`,
nested URLs, and a root-owned WebSocket bridge. They are still the wrong
lifecycle boundary for an open-ended set of independent conversations:

- the whole facet tree is colocated on one machine;
- facets do not own independent physical alarms;
- every facet WebSocket frame wakes the root parent and is forwarded over RPC;
- the facet databases belong to one logical root object;
- chat lifecycle becomes coupled to a parent whose real role is user-scoped
  shared state and services.

Putting every conversation directly in the User agent's SQLite avoids those
facet constraints but creates a different problem. All chat turns then run on
one single-threaded Durable Object and contend with the sidebar, shared
workspace, MCP calls, and every other conversation for that user.

We need independent chat execution without giving up a single user-scoped
catalog and shared-service owner.

## Proposed topology

```text
browser tab
   │
   ├── WebSocket A ─────────────────────────────────────────┐
   │                                                        ▼
   │                                              User agent "alice"
   │                                              - chat catalog/index
   │                                              - shared memory/workspace
   │                                              - MCP registry/connections
   │                                              - OAuth callbacks
   │                                              - cross-chat schedules
   │
   └── WebSocket B ── user-gated upgrade ────────────────┐
                                                         ▼
                                               Chat agent "opaque-name"
                                               - transcript/session
                                               - inference and tools
                                               - resumable stream/recovery
                                               - chat-local schedules
                                               - child dynamic agents
                                                         │
                                                         └── RPC to User agent
                                                             for shared services
```

A second tab has its own pair of connections and can select another chat. A UI
that displays several live conversations can open several Chat connections.
Connection count follows visible chat panes, not the number of catalog rows.

## Responsibilities

### User agent

The User agent owns:

- the authoritative set of chats the user can address;
- application metadata such as title, preview, archived state, and activity
  order;
- any pushed search projection used for cross-chat search;
- shared memory, preferences, and workspace files;
- the user's MCP server registry, OAuth tokens, live MCP connections, and tool
  catalog;
- callbacks whose identity is user-scoped, including MCP OAuth callbacks;
- cross-chat scheduled work, such as selecting one chat for a daily summary;
- the long-lived client connection that broadcasts catalog, workspace, and MCP
  state changes.

The User agent does not own chat transcripts or run ordinary chat turns.

### Chat agent

Each Chat agent owns:

- one conversation's messages and branches;
- model-turn admission and concurrency policy;
- inference, tool execution, and client-tool continuation state;
- resumable stream buffers and recovery state;
- chat-local schedules and durable tasks;
- chat-local configuration and attachments;
- any facet-backed helpers whose lifecycle this chat supervises.

An `AIChatAgent` uses its existing flat message storage. A `Think` Chat agent
uses one normal Think `Session` inside the object. Neither chat base needs an
internal multi-chat mode.

## Creation and identity

The User agent creates chats. A concrete catalog row needs at least:

```ts
type ChatCatalogEntry = {
  chatId: string;
  generation: string;
  agentName: string;
  status: "creating" | "active" | "deleting";
  title: string | null;
  lastMessage: string | null;
  createdAt: number;
  updatedAt: number;
  activitySequence: number;
};
```

`agentName` is an opaque physical name for the Chat Durable Object. Clients use
`chatId`; only the User agent needs to know the mapping. This avoids baking a
user id delimiter or a future sharding scheme into public URLs.

Creation is a small state machine:

1. Allocate `chatId`, `generation`, and `agentName`.
2. Insert a `creating` catalog row before contacting the Chat agent.
3. Resolve the Chat agent and call an idempotent initialization method with its
   `chatId`, `generation`, and User agent identity.
4. Mark the row `active` and broadcast the catalog update.

The Chat agent persists that immutable owner record in its own storage. A
second initialization with different ownership data is an invariant violation.
Retries with the same values are no-ops.

The first implementation may use a deterministic composite `agentName` as
shown in `examples/next/chats`, but the catalog remains the abstraction. Client
code must not derive the physical name itself.

## Request and WebSocket routing

The Worker authenticates the request and resolves the User agent. Product URLs
stay user-relative:

```text
/chat                         -> User agent
/chat/{chatId}                -> Chat agent selected by the User catalog
/chat/{chatId}/...            -> same Chat agent, with the suffix preserved
/chat/mcp-callback            -> User agent MCP callback handler
```

For a chat request, the User agent:

1. Looks up an `active` catalog row.
2. Resolves `env.ChatAgent` by the row's `agentName`.
3. Rewrites the request to the Chat agent's expected path.
4. Returns `chat.fetch(request)`.

For a WebSocket upgrade, the response returned by `chat.fetch()` must carry the
Chat agent's accepted socket back through the User agent and Worker. Once the
upgrade succeeds, the Chat agent owns the native WebSocket and receives future
frames directly.

The first implementation phase must prove this with a deployed-runtime spike,
not only Miniflare:

- increment a User-agent counter for every request it handles;
- connect to a Chat through the User route;
- exchange several frames;
- verify the counter remains unchanged after the upgrade;
- evict both objects and verify Chat-socket hibernation and reconnection.

If the runtime cannot transfer a Chat-owned upgrade through a User DO fetch,
the fallback is for the Worker to ask the User agent to authorize and resolve
the chat, then have the Worker call `chat.fetch()` itself. The browser URL and
socket topology remain the same; only the composition-root hop changes.

## Client chat switching

The client keeps the User connection stable and keys the Chat connection by the
active chat id:

```tsx
const user = useAgent({ basePath: "chat", agent: "UserAgent" });

const chat = useAgent({
  basePath: `chat/${encodeURIComponent(activeChatId)}`,
  agent: "ChatAgent"
});

const conversation = useAgentChat({ agent: chat });
```

The exact hook composition stays app-local initially. `useChats()` in
`examples/assistant` already demonstrates why: that app combines catalog RPC,
workspace revision events, and MCP state, while a simpler app may need only a
list.

When `activeChatId` changes:

1. Locally detach from the previous Chat connection.
2. Do not cancel an active server turn unless the user explicitly chose
   cancellation.
3. Open the new Chat connection through the User-gated route.
4. Load the selected transcript and run the normal resumable-stream handshake.
5. If the user later returns to the old chat, replay its durable stream from the
   Chat agent.

`WebSocketChatTransport.setAgent()` and the existing `useAgentChat` generation
handling already settle state belonging to an obsolete socket. The migration
must retain tests for switching during a stream, reconnecting, and receiving no
late chunks from the previous chat in the newly selected pane.

## User services from Chat agents

A Chat agent replaces `parentAgent(UserAgent)` with an explicit lookup of the
owner recorded during initialization:

```ts
const user = await getAgentByName(this.env.UserAgent, this.ownerName);
```

Callers should depend on narrow application ports rather than the whole User
class. The useful boundaries are:

```ts
type ChatCatalogPort = {
  recordActivity(update: ChatActivityUpdate): Promise<boolean>;
};

type SharedWorkspacePort = {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  // Other application-selected filesystem operations.
};

type SharedMcpPort = {
  listMcpToolDescriptors(timeoutMs?: number): Promise<McpToolDescriptor[]>;
  callMcpTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult>;
};
```

`examples/assistant` already has `SharedWorkspace` and `SharedMCPClient`
adapters. Their RPC contracts remain valid. Only stub resolution changes from
`parentAgent(AssistantDirectory)` to `getAgentByName(env.UserAgent, ownerName)`.

MCP state remains on the User connection. A Chat connection carries transcript
and turn events only. A Chat turn asks the User agent for current MCP tool
descriptors and invokes selected tools back through the same User-owned MCP
manager.

## Catalog consistency

The User catalog is authoritative for existence and ownership. The Chat agent
is authoritative for conversation data. Chat metadata is a pushed projection.

### Never create catalog rows from Chat pushes

A Chat activity update includes `chatId` and `generation`. The User agent runs
an `UPDATE` constrained by both values and `status = 'active'`. It must not use
an unconstrained upsert. This prevents:

- a late response from recreating a deleted catalog row;
- an old Chat agent changing a replacement generation;
- an arbitrary Chat agent inventing a catalog entry.

The method returns whether it matched an active row. A `false` result tells the
Chat agent to stop retrying that projection.

### Order activity at the User agent

Chat clocks and delivery order are not catalog order. When the User agent
accepts an activity update, it allocates a per-user monotonic
`activitySequence` and records its own `updatedAt`. Listing orders by
`activitySequence DESC`, with `chatId` only as a deterministic final tie-breaker.

This handles two chats finishing in the same millisecond and delayed delivery
from independently executing Chat agents.

### Durable projection delivery

A committed Chat turn and its catalog projection cross two Durable Objects and
cannot share a transaction. The Chat agent writes a small durable outbox record
with the metadata projection in the same local transaction as its committed
turn. It retries delivery to the User agent until:

- the User agent accepts it; or
- the User agent reports that the catalog generation is no longer active.

An example may begin with best-effort push plus repair, but the reusable pattern
and production migration should use the outbox. The index is derived data, so a
repair path must also exist.

### Repair and search

Durable Object namespaces are not enumerable. Repair starts from User catalog
rows, never from a global Chat scan. The User agent visits active rows in
bounded batches and asks each Chat agent for projection events after the last
indexed cursor.

Cross-chat search also reads a pushed projection rather than fanning out to all
Chat agents. The first useful projection can index title, preview, and final
user/assistant text in User-agent FTS5. Products that outgrow one user's SQLite
index can project the same event contract into a separate search service
without changing Chat ownership.

## Deletion

Deletion must close the race with active turns and delayed projections:

1. Atomically change the catalog row from `active` to `deleting`.
2. Broadcast the catalog removal so new panes stop selecting it.
3. Ask the Chat agent to reject new turns and abort or finish current work,
   according to application policy.
4. Destroy the Chat agent's storage.
5. Remove the catalog row or retain a tombstone for the product's restore
   window.

Because activity writes require an active matching generation, late outbox
retries cannot resurrect the row. Reusing a chat id allocates a new generation.
Deletion is idempotent and a failed destroy remains retryable from the
`deleting` state.

## Schedules and background work

Chat-local work belongs to the Chat agent and uses its own physical alarm. This
includes stream cleanup, recovery, reminders scoped to one conversation, and
chat-local durable tasks.

Cross-chat work belongs to the User agent. For example, a daily summary job
queries its catalog, resolves the selected top-level Chat agent, and invokes
`postDailySummaryPrompt()` over RPC. The job does not recreate the Chat as a
facet.

## Dynamic agents that remain

This topology does not remove facets from chat products. It narrows their role:

- a Researcher remains a dynamic agent supervised by one Chat agent;
- agent-tool children remain per-run dynamic agents;
- codemode and generated-code runtimes remain dynamic agents;
- sandboxed connectors may remain dynamic agents where colocation and
  supervised lifecycle are required.

The distinction is ownership: a user-visible chat is an independently named
peer. A generated helper whose code or lifecycle the Chat agent owns is a
child.

## Impact on `AIChatAgent` and `Think`

Neither package needs an internal multi-chat feature.

### `AIChatAgent`

A migrated chat becomes a normal top-level `AIChatAgent`. This changes recovery
selection: facet-hosted `AIChatAgent` turns currently use the legacy facet
recovery route, while a top-level Chat agent uses the normal Fibers-backed path.
Migration tests must cover interruption, replay, cancellation, and stream
cleanup on that path.

### `Think`

A migrated chat becomes a normal top-level `Think` object with one Think
`Session`. Chat-local schedules and recovery use the Chat object's own alarm.
If the subclass configures messenger integrations, moving it from a facet to a
top-level object may activate root-only messenger initialization that was
previously skipped for `parentPath.length > 0`; migration must test or disable
that behavior explicitly.

Shared Workspace and MCP adapters continue to use RPC to the User agent. No
`Chats` base class is required in `@cloudflare/think`.

## Migration of existing facet-backed apps

This RFC describes a future migration. It does not move
`examples/multi-ai-chat` or `examples/assistant` in the dynamic-agents PR.

The migration can roll out without a flag day:

1. Add the Chat Durable Object binding and User catalog fields for physical
   `agentName`, `generation`, and topology.
2. Route newly created chats to top-level Chat agents.
3. Keep existing facet rows readable through the old route.
4. Migrate old chats lazily on open or in bounded User-agent jobs:
   - export application-level transcript and chat-local state from the facet;
   - initialize a top-level Chat agent;
   - import and verify the exported state;
   - atomically switch the catalog row to the new physical target;
   - retain the old facet for a rollback window, then delete it.
5. Replace child calls to `parentAgent()` with explicit User-agent adapters.
6. Remove the legacy topology only after no catalog rows point at facets.

There is no generic runtime storage move between a facet database and an
independent Durable Object namespace. Migration is defined in terms of each chat
base's public persistence model. `AIChatAgent` and `Think` therefore need
separate export/import verification tests even though they share the same
catalog topology.

For `examples/assistant`, the User agent keeps its Workspace, MCP manager, OAuth
handler, and daily summary schedule throughout the migration. Only
`MyAssistant` storage and routing move. For `examples/multi-ai-chat`, the Inbox
keeps shared memory and the catalog; each `Chat` becomes a top-level
`AIChatAgent`; its nested Researcher remains a facet of that Chat.

## Implementation phases

### Phase 0: deployed routing spike

Prove Chat-owned WebSocket upgrade passthrough and hibernation through a
User-agent route. Record the result in a small design note before adding SDK
surface.

### Phase 1: harden the reference pattern

Evolve `examples/next/chats` to demonstrate:

- opaque physical Chat names resolved by the User catalog;
- User-gated Chat fetch and WebSocket routing;
- generation-checked metadata updates;
- User-assigned monotonic activity order;
- deletion that cannot be undone by delayed activity;
- repair from catalog rows.

Keep the code application-local.

### Phase 2: migrate `examples/multi-ai-chat`

Move its `AIChatAgent` Chat to a top-level binding, retain shared Inbox memory,
and keep Researcher as a Chat-owned dynamic agent. Add deployed interruption
coverage for the top-level recovery path.

### Phase 3: migrate `examples/assistant`

Move `MyAssistant` to a top-level binding. Retarget `SharedWorkspace` and
`SharedMCPClient` to explicit User-agent lookup. Preserve User-owned OAuth, MCP
state, workspace broadcasts, and daily summary scheduling.

### Phase 4: extract only proven helpers

After both migrations, compare their duplicated code. Candidate reusable pieces
are narrow adapters or routing helpers, not a fixed `Chats` superclass. Any new
public SDK API gets its own proposal and changeset.

## Acceptance tests

The implementation is not complete without tests for:

- two Chat agents for one user running turns concurrently;
- the User agent not waking for post-upgrade Chat frames;
- switching active chats during a stream without displaying late chunks in the
  new pane;
- returning to the old chat and resuming its durable stream;
- two tabs selecting different chats while sharing live User catalog, workspace,
  and MCP state;
- activity events accepted in User-observed order even with equal wall-clock
  timestamps;
- delayed activity after deletion not recreating the catalog row;
- a failed projection push recovering from the Chat outbox;
- repair rebuilding projections from catalog rows without global enumeration;
- Chat-local alarms firing independently;
- User-owned cross-chat scheduling invoking the intended Chat;
- `AIChatAgent` top-level interruption and recovery;
- `Think` top-level interruption, recovery, and messenger initialization policy;
- Researcher, agent-tool, and codemode facets continuing to work under a
  top-level Chat agent.

## Alternatives

### Keep chats as facets of the User agent

This is the topology proposed by `rfc-think-multi-session.md`. It gives
convenient parent identity and a registry, but couples placement, alarms,
storage lifecycle, and every chat frame to one root object.

### Keep all conversations as rows in the User agent

Simple listing and search, but all turns and shared services execute on one
single-threaded object. Suitable for small products that deliberately choose
that tradeoff, not the default SDK guidance.

### One browser WebSocket multiplexed across User and Chat agents

Not proposed. It requires a new logical-channel protocol, virtual connections,
stream generation fencing, and User-agent forwarding on every chat frame. The
existing two-socket client model is simpler and already supported by
`useAgent` plus `useAgentChat`.

### Browser connects directly to a derivable Chat DO name

Avoids an initial User hop but leaks physical naming into clients and bypasses
the catalog authority. The User-gated route preserves freedom to migrate,
archive, or redirect a chat later.

### Ship `Chats` in `@cloudflare/think`

Not proposed. `AIChatAgent` needs the same topology, and real User agents own
product-specific data such as repositories, workspaces, MCP state, or support
case fields. A fixed base class would standardize the least stable part while
leaving the routing and consistency rules implicit.

## Open questions

- Should the User DO itself call `chat.fetch()` for the upgrade, or should it
  return an authorization/routing result so the Worker performs the final
  `chat.fetch()`? Phase 0 decides this from deployed behavior and wake metrics.
- What is the smallest projection event shared by `AIChatAgent` and `Think`
  without freezing a product-specific catalog schema?
- Should durable projection delivery use the existing Tasks capability, a
  small chat-local outbox, or both?
- How long should migrated facet storage and deletion tombstones remain for
  rollback?

## Non-goals

- Implementing this migration in the dynamic-agents extraction PR.
- Removing dynamic agents or sub-agent routing.
- Adding multi-session storage inside `AIChatAgent` or `Think`.
- Standardizing authentication or authorization policy.
- Defining branches, forks, exports, or retention for every chat product.
- Shipping a public `Chats` class or `useChats()` hook before two independent
  applications validate the same abstraction.
