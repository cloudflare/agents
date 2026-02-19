# Minions — Patterns for Personal Computing Assistants

Analysis of the Minions codebase (Gadgets Workshop) and what's relevant for Think.

## Patterns to steal

### 1. Proposed Changes / Merge-before-apply

The killer pattern. When the agent writes code, changes are **proposed** — they exist in a separate branch of the Y.js document, visible in a diff view, but don't take effect until the user merges. The user can test the proposed version first.

**How it works:**
- Agent calls `writeFile`/`editFile` → Y.js update captured
- Update stored as `changes` message in chat thread
- Changes marked as "proposed" (not merged to mainline)
- Frontend shows diff view — user can accept or revert
- `mergeChanges(chatId, mergeThrough)` merges changes
- `revertChanges(chatId, revertFrom)` reverts changes
- `getGadgetFacet(chatId)` loads a version with proposed changes applied for testing

**For Think:** Our `writeFile` tool currently writes directly to the workspace. We could add a staging layer: agent writes to a staging area, user previews a diff in the file browser, then accepts or reverts. Critical as the agent gets more capable.

### 2. Version locking during agent execution

When the agent first reads a file, it "locks" to that code version. If the user edits the file while the agent is working, the agent doesn't see the change. Proposed changes are based on the locked version.

**Implementation:**
- `observedCodeVersion` stored in tool call metadata
- Checked on every `readFile`/`writeFile`/`editFile` call
- Prevents confusion from concurrent edits during agent execution

**For Think:** Our agent reads and writes to the same workspace concurrently with the user browsing files. If we add a file editor, version locking becomes critical.

### 3. The Gatekeeper pattern for external services

Gatekeepers are DO facets that mediate between the agent and external resources. They enforce policies, provide audit trails, and can require human approval for side effects.

**Architecture:**
```
Gadget code → env.BINDING_NAME (ServiceStub)
  → GatekeeperLoopback (WorkerEntrypoint)
    → Overseer.startGatekeeperSession(id)
      → Gatekeeper facet.startSession(approvalQueue)
        → Session RPC stub (proxied back to Gadget)
```

**Each gatekeeper:**
- Is a Durable Object facet (isolated SQLite)
- Implements `Gatekeeper<Session, Action, RevertInfo, Hook>`
- Provides typed RPC interface to the Gadget
- Must submit all actions via `ApprovalQueue` before applying
- Can simulate actions (show state as if approved) until actual approval
- Self-describes with TypeScript types via `getTypeScriptTypes()`
- Suggests a binding name via `suggestedBindingName`

**For Think:** To make it a real personal assistant, it needs to talk to external things — GitHub, email, databases, APIs. The gatekeeper pattern gives us a clean way to add these as typed, auditable, approval-gated capabilities.

### 4. `executeCode` — run arbitrary code in a sandbox

The agent can write and immediately run JavaScript in an isolated Worker. The code gets `env` bindings (gatekeepers) but can't fetch the internet directly.

**Implementation:**
```javascript
// Agent writes this:
export default async function(env, ctx) {
  let data = await env.DATABASE.query("SELECT * FROM users");
  console.log(data);
}
```
- `env.LOADER.get(randomKey, factory)` creates a temporary Worker
- Worker config: `{mainModule, modules, env, compatibilityFlags: ["disallow_importable_env"]}`
- Output captured via tail worker (`CodeModeTailLoopback`)
- Logs returned to agent as tool result

**For Think:** Our `bash` tool via `just-bash` is useful but limited. An `executeCode` tool running JS/TS in a sandboxed Worker would be far more powerful — write a test, run it, see output, fix issues.

### 5. Approval queue for dangerous operations

Gatekeepers can mark actions as needing approval. The action is stored as `pending`, the user sees it in the UI, and the system waits.

**Data model:**
```typescript
type ActionRecord = {
  id: number;
  gatekeeperId: number;
  createdAt: Date;
  state: "pending" | "approved" | "rejected";
  type: "action" | "observation";
  action?: any;           // Gatekeeper-defined action data
  description: {
    title: string;        // One-line summary
    description: string;  // Markdown for approver
    implementsRevert: boolean;
  };
  appliedAt?: Date;
};
```

**Flow:**
1. Gatekeeper receives call from Gadget
2. If read-only: `authorizeObservation()` → logged
3. If side-effecting: `submitAction(action, description)` → stored as `pending`
4. User approves/rejects in UI
5. Overseer calls `gatekeeper.applyAction()` or `rejectAction()`

**For Think:** Extend the `done` tool pattern. Certain tools (`rm -rf`, `bash` with dangerous patterns) require explicit user confirmation. The RUN queue infrastructure makes this possible — a paused run resumes after approval.

### 6. Bindings as discoverable capabilities

Each gatekeeper self-describes with TypeScript types and a suggested binding name. The agent's system prompt includes the list of available bindings. The agent uses `describeBinding` to learn the API before using it.

**For Think:** Our tools are hardcoded in `buildFileTools`. As we add capabilities, we need a discovery mechanism — a `describeBinding` equivalent so the agent knows what's available and how to use it at runtime.

---

## Interesting but lower priority

### Y.js / CRDT for code editing

Minions uses Y.js for real-time collaborative editing with Monaco. Updates stored incrementally, snapshots when log size exceeds threshold. Real-time sync via RPC subscriptions. This matters once we have an in-browser code editor.

### Dynamic Worker loading

`env.LOADER.get(key, factory)` creates ephemeral Workers from source code at runtime. Powers `executeCode`. We'd need this for sandboxed code execution.

### Influencer tracking

The security model tracks who can "influence" a gadget (through prompts, hooks, or data). Prevents prompt injection from data sources. Important for production, not yet for experimental.

### Snapshot strategy for incremental storage

Uses Y.js update log with periodic snapshots. When log exceeds snapshot size, creates new snapshot and trims old updates. Ensures storage is at most 2x the update history. Good pattern for any append-only log.

---

## Architecture comparison

| Concept | Minions | Think |
|---------|---------|-------|
| Orchestrator | Overseer (DurableObject) | ThinkAgent (Agent) |
| Conversations | Chat threads in Overseer storage | Chat facets with isolated SQLite |
| Filesystem | Y.js document (code files) | Workspace facet (SQLite + R2) |
| Agent tools | readFile, writeFile, editFile, executeCode, describeBinding | readFile, writeFile, bash, rm, mkdir, listFiles, done |
| External access | Gatekeeper facets + approval queue | Not yet implemented |
| Code execution | Dynamic Worker sandbox via LOADER | just-bash in-memory interpreter |
| Sibling comms | GatekeeperLoopback (WorkerEntrypoint) | WorkspaceLoopback (WorkerEntrypoint) |
| Streaming | RPC subscriptions (Cap'n Web) | NDJSON over TransformStream + WebSocket |
| Proposed changes | Y.js branching + merge/revert UI | Direct writes (no staging) |
| Security | Capability-based + approval queue | Ownership check on workspace |

---

## Roadmap informed by Minions

### Immediate (uses current architecture)
1. **Proposed changes layer** — staging area, diff preview, merge/revert
2. **Approval for dangerous tools** — `rm`, certain `bash` patterns
3. **Version locking** — lock workspace state at start of agent run

### Medium-term (new infrastructure)
4. **`executeCode` tool** — run JS/TS in a sandboxed Worker
5. **Gatekeeper-style bindings** — typed, auditable external service access
6. **`describeBinding` discovery** — agent learns available tools at runtime

### Longer-term
7. **Y.js for collaborative editing** — real-time sync with Monaco
8. **Influencer tracking** — security against prompt injection
9. **Agent spawners** — sub-agents for parallel task execution
10. **Hooks** — push notifications from external services into threads

---

## Key files in Minions

| File | What it does |
|------|-------------|
| `packages/workshop-backend/src/overseer.ts` | Main orchestrator DO — state management, facet lifecycle, approval queue, code execution |
| `packages/workshop-backend/src/agent.ts` | AI agent — system prompt, tools, version locking, proposed changes |
| `packages/workshop-shared/src/gatekeeper.ts` | Gatekeeper interface — capability model, approval queue types |
| `packages/workshop-shared/src/api.ts` | RPC API definitions (Cap'n Web) |
| `packages/workshop-frontend/src/GadgetEditor.tsx` | Main editor UI — chat, code, connections, gadget tabs |
| `packages/workshop-frontend/src/ChatInterface.tsx` | Chat UI — real-time subscriptions, message rendering |
| `packages/workshop-frontend/src/CodeEditor.tsx` | Monaco + Y.js integration |
| `packages/workshop-frontend/src/CodeDiffEditor.tsx` | Proposed changes diff view |
| `overview.md` | Product vision, security model, architecture overview |
