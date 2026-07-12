# 10 — Session: context blocks, system prompt, compaction

Original: `agents/experimental/memory/session` (~2.5k lines across session,
context, manager, providers) plus Think's `configureSession()` seam. The
session owns conversation history (tree-structured), context blocks injected
into the system prompt, AI-facing context tools, and compaction overlays.

The rebuild keeps the MessageStore (doc 03) as the flat persistence layer and
gives Session the *conversation semantics*: history reading (with compaction
overlay), context blocks, and prompt assembly. Tree branching is preserved in
simplified form (parentId chains).

---

## 1. `domain/session/session.ts`

### Context blocks

A block = `{ label, description?, maxTokens?, provider }`. Provider types are
duck-typed:

| type      | shape                            | tools generated |
| --------- | -------------------------------- | --------------- |
| read-only | `{ get() }`                      | — |
| writable  | `{ get(), set(content) }`        | `set_context` |
| skill     | `{ get(), load(key), set?() }`   | `load_context`, `unload_context` (+ `set_context` if set) |
| search    | `{ get(), search(q), set?() }`   | `search_context` (+ `set_context` if set) |

All support optional `init(label)`. Default provider (no explicit one) is a
KV-backed writable provider (`ctx:<sessionId>:<label>`).

### System prompt assembly
- Rendered from blocks in declaration order with a header per block:
  label (uppercased), description, `[readonly]` or a usage line
  `[NN% — used/max tokens]` when maxTokens set, then content.
- Token estimation: `Math.ceil(chars / 4)` unless a `tokenCounter` is
  injected.
- **Frozen prompt**: `freezeSystemPrompt()` renders once and persists; later
  calls return the cached value (LLM prefix-cache preservation). Writes to
  blocks do NOT refresh the frozen prompt. `refreshSystemPrompt()` re-renders
  and persists. Frozen prompt survives recreation over the same KV.

### Messages & history
- `appendMessage(msg, parentId?)`: auto-parents to the latest leaf; explicit
  parentId creates branches. `getHistory(leafId?)` walks root→leaf.
- `updateMessage`, `deleteMessages(ids)`, `clearMessages()` (also clears
  loaded-skill state), `getLatestLeaf()`, `getBranches(messageId)`,
  `getPathLength()`.
- After each append: auto-compaction check (below); then a status callback
  (Think broadcasts `cf_agent_session` `{ phase, tokenEstimate, tokenThreshold }`).

### Context tools (returned by `session.tools()`, merged as builtin tools)
- `set_context { label, content, action: "replace" | "append" }` — enforces
  maxTokens (reject with usage message when over); returns
  `"Written to <label>. Usage: NN% (used/max tokens)"`.
- `load_context { label, key }` — loads full doc from a skill provider;
  result becomes the tool output. Loaded keys tracked as `label:key`.
- `unload_context { label, key }` — rewrites the original load_context tool
  output in history to `"[skill unloaded: <key>]"` (frees context; original
  content permanently gone) and untracks the key. Tool description lists
  currently loaded keys.
- `search_context { label, query }` — provider search; top 10; "No results
  found." on empty.
- Loaded-skill state is **reconstructed by scanning history** for successful
  `load_context` tool parts (survives eviction without extra storage).

### Proposed interface
```ts
export interface ContextProviderLike { get(): Promise<string>; set?(c: string): Promise<void>;
  load?(key: string): Promise<string | null>; search?(q: string): Promise<Array<{ key: string; excerpt: string }>>;
  init?(label: string): Promise<void>; }
export interface SessionConfig {
  sessionId?: string;
  blocks: Array<{ label: string; description?: string; maxTokens?: number; provider?: ContextProviderLike }>;
  tokenCounter?: (text: string) => number;
  compaction?: CompactionConfig;          // doc section 2
  onStatus?: (s: { phase: "idle" | "compacting"; tokenEstimate: number; tokenThreshold?: number }) => void;
  onCompactionError?: (e: unknown) => void;
}
export interface Session {
  appendMessage(m: ChatMessage, parentId?: string): Promise<void>;
  updateMessage(m: ChatMessage): Promise<void>;
  deleteMessages(ids: string[]): Promise<void>;
  clearMessages(): Promise<void>;
  getHistory(leafId?: string): Promise<ChatMessage[]>;    // compaction overlay applied
  getLatestLeaf(): Promise<ChatMessage | undefined>;
  getBranches(messageId: string): Promise<ChatMessage[]>;
  addContext(label: string, opts?: {...}): Promise<void>;  // runtime blocks
  removeContext(label: string): void;
  getContextBlock(label: string): { label; description?; content; tokens; maxTokens?; writable; isSkill; isSearchable } | undefined;
  replaceContextBlock(label: string, content: string): Promise<void>;
  appendContextBlock(label: string, content: string): Promise<void>;
  freezeSystemPrompt(): Promise<string>;
  refreshSystemPrompt(): Promise<string>;
  tools(): Promise<ToolSet>;
  compact(): Promise<{ compacted: boolean; summaryId?: string }>;
  estimatedTokens(): Promise<number>;
}
export function createSession(deps: { store: KeyValueStore; clock: Clock; ids: IdSource }, config: SessionConfig): Session;
```

Think's `configureSession(builder)` seam is preserved in doc 23 via a small
builder (`withContext/withCachedPrompt/onCompaction/compactAfter`) that
produces `SessionConfig`.

---

## 2. `domain/session/compaction.ts`

### Responsibilities (original `createCompactFunction` + overlay)
- Non-destructive overlay: originals stay in the store; a compaction record
  `{ id, fromMessageId, toMessageId, summary }` replaces that range at read
  time with a synthetic assistant message `id: "compaction_<id>"` whose text
  is the summary.
- Boundary algorithm:
  1. protect head: first `protectHead` (default 3) messages;
  2. protect tail: walk backward accumulating tokens up to `tailTokenBudget`
     (default 20 000), always keeping ≥ `minTailMessages` (default 2);
  3. align boundaries so a tool call and its results are never split;
  4. middle → `summarize(prompt)` (injected async fn — the app wires an LLM);
     prompt includes any existing overlay summary for iterative update;
  5. store overlay (superseding overlaps).
- `compactAfter(threshold)`: auto-run after appendMessage when estimated
  history tokens exceed threshold; requires a summarize fn; errors go to
  `onCompactionError` (writes never fail because compaction failed).
- Return whether history actually shortened (`shortened`) — doc 14's overflow
  recovery needs it.

### Proposed interface
```ts
export interface CompactionConfig {
  summarize: (prompt: string) => Promise<string>;
  protectHead?: number; tailTokenBudget?: number; minTailMessages?: number;
  compactAfterTokens?: number;
  tokenCounter?: (messages: ChatMessage[]) => number;
}
export function planCompaction(messages: ChatMessage[], cfg: CompactionConfig):
  { from: number; to: number } | null;   // indices; null = nothing worth compacting
export function applyOverlays(messages: ChatMessage[], overlays: Overlay[]): ChatMessage[];
```
(`Session.compact()` orchestrates plan → summarize → store overlay.)

### Tests
- prompt rendering with usage lines; frozen vs refresh semantics; branch
  walking; loaded-skill reconstruction from history; unload rewrites history;
  set_context maxTokens enforcement; compaction boundary rules (head/tail/tool
  pair alignment); overlay applied in getHistory; auto-compaction trigger and
  error swallowing; iterative re-compaction passes previous summary.
