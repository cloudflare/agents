# Session handoff — active workstreams

Snapshot for picking up in a new session. Branch
`claude/think-agent-clean-rebuild-offos3`, green at HEAD. Commit/push per
verified milestone; never PR. Sources of truth: `CONTEXT-MAP.md` +
per-context `CONTEXT.md` (the maintainer's canonical model), `ISSUES.md`,
`test-workers/ported/COVERAGE.md` (the port ledger), `PROGRESS.md` (log).
Dashboard: `npm run dashboard` → `dashboard.html`.

Numbers as of this handoff: ported board **228/416 passing** · native
**~1076 node + 42 workerd**, typecheck clean · **6 issues resolved, 24 open**.

---

## 1. Test porting

**Goal:** every original Think-relevant test accounted for in the ledger —
ported / rewritten / native-covered / dropped / quarry / blocked-on-issue.
Plan is audit 29; ledger is `test-workers/ported/COVERAGE.md` (single source;
dashboard is generated from it). Status vocabulary + fidelity tags
(`[fidelity:move|light|adapter|rewrite]`) are documented at the ledger top.

**Done:** waves P1–P6. P1 first 5 wire files; P2 `chat-recovery` e2e (kill/
restart harness); P3 wire remainder; P4 e2e recovery batch; P5
`assistant-agent-loop`/`protocol-messages`/`routing`(24/24 — first full
original suite green)/`reattach-budget`/`task-amplification`; P6
`think-session` (198 tests → 103 pass, **33 named `missing-feature` reasons**
in its fixtures — a ready-made implementation worklist).

**Remaining (biggest lever = T3 PUBLIC-API waves):** `hooks` (105),
`submissions`, `agent-tools`, `schedule`, `sub-agent` (97), the
`agents/src/tests` Think-relevant subset, plus remaining T1/T2 files. The
`quarry` set (`agents/chat/__tests__`, ~477) is never ported — it's the spec
checklist for our native suites.

**Workflow:** codex-exec waves behind thin wrapper subagents (Sonnet). NEW
DISCIPLINE (memory saved): wrappers must launch `codex exec` and any long
suite as **explicit background jobs** (`run_in_background: true`), never long
foreground Bash — the foreground auto-background relay was unreliable.
Orchestrator verifies, triages into the ledger, commits. Wrappers/codex may
read original TEST files but never original implementation
(`packages/think/src/think.ts`, `agents/src/index.ts`, `agents/chat/*`).

---

## 2. Real implementation (the recovery goal + fallout)

**Recovery goal:** PRIMARY ACCEPTED — `onChatRecovery` hook (persist:false/
continue:false), `waitUntilStable`, recovery inspection accessors; 2 of 4
stalled e2e files green under real kill/restart (`context-overflow-recovery`
3/3, `action-pause-recovery` 1/1). Stretch tier 1 (R3) committed: in-band
stream errors (additive `error` ModelChunk) + abort/stall injection seams —
think-session 71→103.

**Stretch tiers remaining (parked, named in the ledger):** (2)
sanitization + row-size enforcement (extends ISSUE-019); (3) saveMessages/
addMessages surface variants; (4) execute-hitl fixture rework onto durable-
pause actions (target 10/10). Beyond those, the 33 `missing-feature` reasons
in `think-session-agents.ts` are the implementation backlog (recovery-incident
bookkeeping variants, submission seams, child-stream forwarding, etc.).

**9 real bugs found+fixed by the ported tests this session:** framing
(ISSUE-026), continuation requestId orphaning (027), session parent-cycle
infinite loop (028), kebab-slug routing (acronyms), unknown-binding 400-vs-404,
lazy action-registry compile (deploy-then-approve), lazy overflow config,
reactive-retry fidelity, approval-state vocabulary (029). Issues resolved:
015, 018, 026, 027, 028, 029.

---

## 3. Design work

**Publish-as-new-Think** is the north star. Two axes to keep separate
(learned the hard way this session): *transport-free vs coupled* (Agent must
not touch frames — a real goal) is ORTHOGONAL to *unopinionated vs
opinionated* (the real Agent/Think seam).

**ADR-0002 — DRAFT/CONTESTED, needs authoritative rewrite.** The maintainer
rejected its "Agent is non-conversational" framing. Agreed conclusions:
- The Agent/Think seam is **opinion, not conversation.** "An agent can
  converse" is essence, not an opinion; opinions are compaction, subagents,
  recovery policy, channels, branching sessions, HITL, submissions, skills.
- transport-free ≠ conversation-free (conversation is all typed methods + a
  durable log; touches no wire). The `ConversationEventLog` IS conversational
  and already lives on Agent — the old "it's generic" claim was a
  rationalization for an incoherent split (outbound conv. on Agent, inbound in
  Think).
- **Three-layer model (maintainer: "probably sensible"), aligns with the
  context map's Context 3 vs 4:** *Durable Runtime* = conversation-free
  substrate (non-conversational actors) · *Agent* = unopinionated agent that
  converses (model + turn loop + transcript + event stream, transport-free) ·
  *Think* = opinions.
- No strong universal line for turn-loop knobs (maxSteps, stop, tool protocol)
  — maintainer: it's the **team's case-by-case call** whether something is a
  sensible global standard or a Think opinion. So the ADR states the layering
  + the principle, not a hard rule.
- Mechanical findings that STAND regardless: Think reaches only Agent's
  public+protected surface (grep-verified — no private access, no casts), so
  Think is reproducible in userland; and transports must depend on **capability
  interfaces, not concrete classes** (corollary).

**ISSUE-030 — hosting refactor (well-specified, unbuilt).** Composition-first:
the DO *has-a* Agent. One generic host that routes platform I/O to **composed
transport adapters**; NO "chat" agent type / no `instanceof Think` (3 of the 4
`cf_agent_*` concerns — event projection, state sync, RPC — are Agent-level;
only conversation needs the turn surface). Transports typed to capability
interfaces: the **inbound seam is `ConversationApi`** (renamed from
`ConversationSurface` to avoid colliding with the map's Channels/**Surfaces**),
the **outbound seam is `ConversationEventLog`** (exists). Also: rename
`AgentHost` → `AgentRuntime` (signal capabilities, not a `this` handle). Fold
in the current leak: `attachChatTransport(agent: Think)` is nominally coupled
(Think's private brand) — retype to `ConversationApi`. DX comparison in
`docs/hosting-dx-sketch.md` (published artifact); direction = composition is
the documented model, one generic base class is the everyday shortcut,
`hostAgent()` survives as terse sugar.

**this.sql — RESOLVED:** raw SQL is a DO-shell concern, not an agent concern.
The agent stays port-pure; authors reach `ctx.storage.sql` by subclassing the
hosted DO. Accept-break on `this.sql`-on-the-agent.

**Integration/reimplementation backlog (audits 28, 30):** ISSUES 003–013
consume standalone/leaf modules (MCP client behind ExternalToolSource is
highest-value; codemode/shell/extensions/browser/observability/voice/
messengers/hono/framework); 014–025 re-implement gaps (media eviction,
message reconciliation done as 015, workflow base, sub-routing, sanitization,
retry, Serializable, MCP server, inbound email, delegation reconcile entry,
webmcp). ISSUE-007 (real `agents/react` client smoke test) is the true
external wire-compat proof and is now viable post-026.

---

## Suggested next moves (not committed — maintainer's call)

- **Authoritative ADR-0002 rewrite** with the three-layer model, once the team
  is ready to commit to Runtime/Agent/Think. (User leaning yes on 3 layers.)
- **ISSUE-030 hosting refactor** as a `/goal` (generic host + capability-typed
  transports + AgentHost→AgentRuntime + retype attachChatTransport). Sizeable
  adapter change; full re-verify.
- **Recovery stretch 2–4** and/or continue **T3 port waves** — both are
  green-loop incremental.
- **ISSUE-003 MCP client** if shifting from parity to new capability.
