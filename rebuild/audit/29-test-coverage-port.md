# 29 — Porting the original test coverage

Plan for reaching full spiritual coverage of Think's original test suite in the
rebuild, based on a complete inventory of the original suites (2026-07-14).
Companion to audit 28 (which covers code); this covers tests.

## 0. Inventory summary

| Original location | Files | ~Tests | Harness | Coupling profile |
|---|--:|--:|---|---|
| `think/src/tests/` | 43 | ~871 | vitest-pool-workers (35 DO bindings) | ~14 WIRE, ~20 PUBLIC-API, ~9 INTERNAL |
| `think/src/e2e-tests/` | 14 | 29 | node vitest → spawns real `wrangler dev`, SIGKILLs it mid-stream, restarts | all WIRE (harness-heavy) |
| `think/src/{cli,react,vite}-tests/` | 5 | 70 | node/jsdom | cli+vite INTERNAL (tooling); react = WIRE-client (`useAgentChat`) |
| `agents/src/tests/` (Think-relevant subset) | ~15 | ~350 | vitest-pool-workers | PUBLIC-API (sub-agents, schedule, fibers, state, callable, keep-alive, session module) |
| `agents/src/chat/__tests__/` | 25 | 477 | node vitest | ALL INTERNAL to the replaced architecture — spec references, not ports |

Coupling legend: **WIRE** = drives only the external surface (WebSocket
`cf_agent_*` frames / `{type:"rpc"}` frames / fetch) — copy-paste candidates.
**PUBLIC-API** = stubs + public/`@callable` methods — light rewrite.
**INTERNAL** = imports private modules of the old architecture — re-derive
intent, don't port.

Two structural gifts from the original suites: (a) there is NO shared
frame-builder utility — every WIRE file inlines its own WS helpers, so files
are self-contained and portable one at a time; (b) the e2e flagship
(`chat-recovery.test.ts`) imports **nothing** from `think` at all — it is pure
localhost WS+RPC and can run against the rebuild verbatim once the fixture
worker and payload fidelity (§1) exist.

## 1. Finding: wire compat is name-level, not yet payload-level

The rebuild kept the `cf_agent_*` frame NAMES (audit 25 decision) but the
original payload envelopes differ from what our WS adapter speaks:

- Original chat request: `{ type: "cf_agent_use_chat_request", id,
  init: { method: "POST", body: JSON.stringify({ messages, ...extra }) } }` —
  ours parses `frame.messages` / `frame.input` directly and ignores `init`.
- Original chat response chunks: `{ type: "cf_agent_use_chat_response", id,
  body, done, error }` (body = serialized chunk, done flag terminates) — ours
  emits `{ id, chunk }` per event with no `done` framing.
- The resume handshake and RPC framing (`{type:"rpc",id,method,args}` →
  `{type:"rpc",id,success,result|error}`) must be field-checked the same way.

This blocks both the copy-paste tests and the real `agents/react` client
(ISSUE-007). Tracked as **ISSUE-026**; fixing it is the first port wave (T0),
using two smallest original WIRE tests as the acceptance criteria.

## 2. The compat shim (what "run as-is" requires)

Union of what the top WIRE candidates import, and where it comes from:

| Import in original test | Provider in the rebuild |
|---|---|
| `getAgentByName` from `agents` | `adapters/cloudflare/routing.ts` (exists) — expose via a `test-compat/agents.ts` alias module |
| `getServerByName` from `partyserver` | alias to the same |
| `routeAgentRequest` (fixture worker) | exists |
| `subscribe` from `agents/observability` | ISSUE-009 adapter (or a bus-bridge stub for the observability assertions) |
| `env` / `exports` from `cloudflare:workers` | test worker's wrangler bindings, named identically to the original `wrangler.jsonc` |
| Think types (`ChatResponseResult`, `TurnResult`, `StreamCallback`, `action`, `agentTool`, ...) | rebuilt `app/think.ts` exports (mostly same names by design; alias the rest) |

**The real integration point is the fixture agents**, not the test files: every
WIRE/PUBLIC-API test depends on `tests/agents/*` classes subclassing Think and
overriding `getModel/getTools/getActions/...` + `@callable` inspection methods.
Those ~16 fixture files must be re-authored against the rebuilt public API
(hosted via `hostAgent`); after that, the WIRE assertions transfer nearly
unchanged. Fixture re-authoring is where the porting effort actually lives.

Ported suites live in `rebuild/test-workers/ported/` (same pool-workers rig,
bindings added to the existing wrangler.jsonc) — keeping them separate from our
native tests so provenance stays visible.

## 3. Tracks

### T0 — payload fidelity spike (ISSUE-026)
Port `streaming-message-id.test.ts` (1 test, near-zero imports) and
`assistant-agent.test.ts` (5 tests, bare wire chat) verbatim; make them pass by
fixing the WS adapter's request/response envelopes to the original shapes
(accept `init.body`, emit `body/done` framing, keep our internal event
vocabulary unchanged — this is adapter-only). Add the react
`stream-resume.test.tsx` client test as the third acceptance gate (it exercises
`useAgentChat` reconnect/ACK semantics through a mocked transport).

### T1 — WIRE bulk port (copy-paste, ~10 files / ~180 tests)
`client-tools`, `message-reconciliation` (will fail until ISSUE-015 — port it
early as the executable spec), `execute-hitl`, `actions-attach-reply`,
`onconnect-broadcast`, `assistant-agent-loop`, `agent-tool-reattach-recovery`,
plus the WIRE halves of `think-session` and `hooks`. Each file: copy, re-point
imports at the shim, re-author its fixture agent(s), run, and triage failures
into (adapter bug | missing feature → existing ISSUE | intentional divergence →
note in the file).

### T2 — e2e kill/restart suite (~14 files / 29 tests, the crown jewels)
These certify recovery under real process death — the rebuild's reason to
exist. `chat-recovery.test.ts` ports verbatim (zero think imports). Plan:
- New vitest project `rebuild/e2e/` (`test:e2e`, node, `fileParallelism:false`,
  long timeouts) — third project beside node + workers.
- Extract the per-file inlined harness (~250 LOC each in the original) into
  ONE shared helper (`startWrangler/restartWrangler/killProcessTree/
  callAgentByPath/sendChatMessageAndWaitForDone/pollUntil`) — improve, don't
  replicate, the duplication.
- Re-author the e2e fixture worker (the original's is 2481 LOC exporting ~20
  recovery-scenario agents) incrementally, one scenario per ported file.
- Port order by value: chat-recovery → stall-recovery → context-overflow →
  submission-recovery → action-pause/ledger-recovery → tool-rollback →
  persist-false → reattach-budget/task-amplification (need sub-agent
  recovery) → messenger/workflow-recovery (blocked on ISSUES 011/016) →
  assistant-e2e/step-prompt-structured (need real model bindings; keep out of
  CI like the original).

### T3 — PUBLIC-API rewrites (~20 think files + ~15 agents files / ~700 tests)
Light rewrites: same scenarios, method names mapped to the rebuilt surface
(`submitMessages`→submissions surface, `saveMessages`/turn modes→`chat`
options, `subAgent`/`runAgentTool`→delegation surface, `configureSession`→
session config). Wave per area, mirroring the original files: think-session,
hooks, submissions, agent-tools (+the 5 small agent-tool files), scheduled
tasks, fibers, schedule, state, callable, keep-alive, readonly-connections,
channels-policy/threading, deliver-notice, hydration-budget, stream-cleanup,
onstart-degraded, turn-metadata, attachment-consumption. Many will be partial
duplicates of our existing 1057 — the port rule is: keep the original test
when it asserts something ours doesn't; drop it when ours already covers it
(note the drop in the tracking table).

### T4 — INTERNAL suites as spec quarries (do NOT port)
`agents/chat/__tests__` (477 tests) encode the recovery/accumulator/reconciler
/queue semantics of the replaced architecture. Use the big four
(`recovery-engine` 65, `stream-accumulator` 62, `recovery-incident` 48,
`message-reconciler` 37) as checklists against our
`domain/reliability/recovery`, `domain/conversation/chunks`, and ISSUE-015
work — add missing behaviors to OUR suites in our idiom. Same for the session
module tests (~200) if/when session features are quarried (audit 28), and for
think's INTERNAL files, which map 1:1 to open issues: `media-eviction`→014
(port its pure-fn tests WITH the implementation), `extension-manager`→006,
`workflows`→016, `messengers`→011, `fetch-tools`/`browser-tools`→028/008
comparisons, `channels`→existing channels suite, `framework`/`vite`/`cli`→013.
Type-only `.test-d.ts` files: port alongside ISSUE-021.

## 4. Tracking

Add `rebuild/test-workers/ported/COVERAGE.md`: one row per original test file
— ported-verbatim / rewritten / covered-by-native (with pointer) / dropped
(with reason) / blocked-on-ISSUE-NNN. The port is DONE when every row is
non-empty. Counting: original Think-relevant surface ≈ 1,250 behavioral tests
(871 + 29 e2e + ~350 agents-shared); the rebuild's existing 1,099 already
covers a large but unmeasured fraction — the table turns that into a real
number instead of a feeling.

## 5. Sequencing against the issue backlog

T0/T1 force ISSUE-026 and surface ISSUE-015/018 concretely; T2 is
independent after T0; T3 can run as parallel codex waves per area (same
process as the adapter waves); T4 rides each related issue. Suggested first
milestone: T0 + the first three T1 files + `chat-recovery.test.ts` e2e —
after that, the original suite's strongest guarantees are running against the
rebuild and everything else is incremental.
