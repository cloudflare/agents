# Session handoff — active workstreams

Snapshot for picking up in a new session. Branch
`claude/think-agent-clean-rebuild-offos3`, green at HEAD. Commit/push per
verified milestone; never PR. Sources of truth: `CONTEXT-MAP.md` +
per-context `CONTEXT.md` (the maintainer's canonical model), `ISSUES.md`,
`test-workers/ported/COVERAGE.md` (the port ledger), `PROGRESS.md` (log).
Dashboard: `npm run dashboard` → `dashboard.html`.

Numbers as of this handoff: ported board **288/552 passing by vitest count**
(`test-workers/ported/BOARD-SNAPSHOT.txt` is the canonical per-test record;
ledger row estimates differ slightly) · native **1082 node + 42 workerd**,
typecheck clean · **6 issues resolved, 28 open** (031–034 new, found by the
P7/P8 ports).

**Verification economy (new discipline, 2026-07-15):** subagents hand off
vitest `--reporter=json` artifacts (orchestrator reads, never re-runs); board
regression gate = snapshot diff via `scripts/board-snapshot.mjs`; full board
runs are periodic checkpoints only, waves gate on typecheck + their own
files. See the COVERAGE.md header.

---

## 1. Test porting

**Goal:** every original Think-relevant test accounted for in the ledger —
ported / rewritten / native-covered / dropped / quarry / blocked-on-issue.
Plan is audit 29; ledger is `test-workers/ported/COVERAGE.md` (single source;
dashboard is generated from it). Status vocabulary + fidelity tags
(`[fidelity:move|light|adapter|rewrite]`) are documented at the ledger top.

**Done:** waves P1–P8 (P7 `hooks` 48/105 + P8 `submissions` 23/51 ran in
parallel worktrees during the ChatAgent extraction; both 0-flip verified
against the merged tree; real bugs found → ISSUES 031–034). P1 first 5 wire files; P2 `chat-recovery` e2e (kill/
restart harness); P3 wire remainder; P4 e2e recovery batch; P5
`assistant-agent-loop`/`protocol-messages`/`routing`(24/24 — first full
original suite green)/`reattach-budget`/`task-amplification`; P6
`think-session` (198 tests → 103 pass, **33 named `missing-feature` reasons**
in its fixtures — a ready-made implementation worklist).

**Remaining (biggest lever = T3 PUBLIC-API waves):** `agent-tools` (33),
`schedule`, `sub-agent` (97), the `agents/src/tests` Think-relevant subset,
plus remaining T1/T2 files. The
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

**ADR-0002 — ACCEPTED (target-state, 2026-07-15), rewritten as
`docs/adr/0002-three-layers-agent-chatagent-think.md`.** Decisions recorded:
- Three layers: **`Agent`** (bottom, name unchanged — `Actor` rename rejected
  for blast radius) = conversation-free durable substrate · **`ChatAgent`**
  (new, extracted from Think) = unopinionated conversing agent (model, turn
  loop, transcript, conversation event vocabulary) · **`Think` extends
  ChatAgent** = opinions (compaction, recovery policy, channels, branching,
  HITL, submissions, skills, delegation).
- The seam is **opinion, not conversation**; transport-free ≠
  conversation-free. Event-log incoherence resolved: mechanism on Agent,
  conversation vocabulary on ChatAgent.
- Allocation-of-concerns table accepted first-pass (rows movable by team
  call); `ConversationApi` split into essence core + `ApprovalApi` +
  `RecoveryIntrospection` opinion extensions — transports require the
  intersection they speak, so ISSUE-030 doesn't wait for the split.
- Invariants carried: each layer uses only the layer below's
  public+protected surface (promotion rule, grep-verified); transports depend
  on capability interfaces, never concrete classes.
- "chat" added to the context-map overloaded-term watchlist (protocol bundle
  vs ChatAgent layer).
- **Migration LANDED (2026-07-15):** `src/app/chat-agent.ts` extracted (14
  protected seams, neutral defaults); think.ts 1239→706. Ported board
  per-test diff pre/post: byte-identical. Bare-ChatAgent test proves
  compose-your-own-agent works with zero opinion services. See the ADR's
  Migration section for the two domain-seam widenings and the
  ensureRuntime ordering note.

**ISSUE-030 — hosting refactor (well-specified, unbuilt).** Composition-first:
the DO *has-a* Agent. One generic host that routes platform I/O to **composed
transport adapters**; NO "chat" agent type / no `instanceof Think` (3 of the 4
`cf_agent_*` concerns — event projection, state sync, RPC — are Agent-level;
only conversation needs the turn surface). Transports typed to capability
interfaces: the **inbound seam is `ConversationApi` + the opinion extensions a
transport actually speaks** (`ApprovalApi`, `RecoveryIntrospection` — split per
ADR-0002; don't call it `ConversationSurface`, which collides with the map's
Channels/**Surfaces**), the **outbound seam is `ConversationEventLog`**
(exists). Also: rename `AgentHost` → `AgentRuntime` (signal capabilities, not
a `this` handle). Fold in the current leak: `attachChatTransport(agent: Think)`
is nominally coupled (Think's private brand) — retype to the interface
intersection it speaks. DX comparison in
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

- ~~ChatAgent extraction~~ — DONE 2026-07-15 (see §3).
- **ISSUE-030 hosting refactor** as a `/goal` (generic host + capability-typed
  transports + AgentHost→AgentRuntime + retype attachChatTransport). Sizeable
  adapter change; full re-verify.
- **Recovery stretch 2–4** and/or continue **T3 port waves** — both are
  green-loop incremental.
- **ISSUE-003 MCP client** if shifting from parity to new capability.
