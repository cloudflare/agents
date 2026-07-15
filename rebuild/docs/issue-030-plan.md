# ISSUE-030 execution plan (spec-first — for maintainer review before implementation waves)

Approved process (maintainer, 2026-07-15): **spec-first** (this doc + the
capability interfaces landing as a reviewable commit), **rename-first** (the
mechanical `AgentHost`→`AgentRuntime` rename as its own commit before the
interesting refactor), **full-board checkpoint** at merge (per the
periodic-checkpoint policy in the ported ledger).

## 1. The spec commit (this one)

- `src/app/capabilities.ts` — the three ADR-0002 interfaces as real exported
  types: `ConversationApi` (essence), `ApprovalApi` + `RecoveryIntrospection`
  (opinion extensions).
- `ChatAgent implements ConversationApi` and
  `Think implements ApprovalApi, RecoveryIntrospection` — conformance is now
  compiler-checked, not aspirational.

## 2. Rename map: `AgentHost` → `AgentRuntime` (mechanical wave, separate commit)

Rationale (ISSUE-030): the name should signal *capabilities provided to* the
agent, not a `this`-handle to a host object. 14 files reference `AgentHost`:

`src/app/agent.ts` (declaration) · `src/app/chat-agent.ts` · `src/app/think.ts`
· `src/app/agent.test.ts` · `src/app/chat-agent.test.ts` · `src/app/think.test.ts`
· `src/adapters/cloudflare/shell.ts` · `src/adapters/websocket-chat/adapter.test.ts`
· `src/e2e/{actions-approvals, chat-session, delegation, durable-work, recovery,
submissions-scheduled-tasks}.e2e.test.ts`

Policy: pure rename + deprecated type alias `export type AgentHost =
AgentRuntime` retained for one milestone (ported fixtures and external
references keep compiling), then removed. Constructor parameter names
(`host`) and the `this.host` field are IN scope for the rename
(`runtime`) — flag: this touches Think/ChatAgent internals broadly; the
alternative (rename the type only, keep `host` member name) halves the diff
and is the recommended first step. **Decision for review: type-only rename
first (recommended), member rename optional later.**

## 3. The refactor waves (after review of this doc)

**W-A — transport retype.** `attachChatTransport(agent: Think, …)` becomes
capability-typed. Observed surface of the WS adapter (grep, 2026-07-15):
- `ConversationApi`: chat, cancelChat, applyToolResult, history, clearMessages
- `ApprovalApi`: resolveApproval
- `RecoveryIntrospection`: isRecovering, activeTurn, pendingChatTerminal
- Agent-level substrate: `events()`, `state`/`setState`, `identity()`,
  `callables`, `ids`

The Agent-level slice needs a name — the ADR froze only the three
conversation-layer interfaces. **Open question for review:** one coarse
`AgentCoreApi` interface (events/state/setState/identity/callables/ids), or
three fine-grained ones (`EventLogSource`, `StateSyncApi`, `RpcApi`)?
Recommendation: coarse `AgentCoreApi` now (one consumer today), split later
if a transport ever needs a subset.

**W-B — generic host.** The composition-first shell: the DO *has-a* Agent;
one generic host routes platform I/O to composed transport adapters; NO
`instanceof Think` / no "chat" agent type. `hostAgent()` survives as terse
sugar. Migration for `demo/` + `src/e2e/` fixtures rides in the same wave.

**Checkpoint.** Full ported board + snapshot refresh at merge; native + e2e
suites; demo boot verified (`npm run demo:cf` handshake).

## 4. Out of scope here

- ChatAgent-level default transports (none exist; transports stay adapters).
- The DX cookbook ("compose your own agent") — companion work named in
  ADR-0002's follow-up; unblocked but separate.
