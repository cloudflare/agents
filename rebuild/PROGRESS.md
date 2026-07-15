# Rebuild progress

Workflow state for the clean-room rebuild. Update when a module lands.
Implementers: read `audit/00-overview.md` first; your module's audit doc is
the spec. **Never read `packages/think/` or `packages/agents/`.**

## Status legend
`todo` → `in-progress` → `done` (tests green + typecheck clean)

## Wave 0–1 (foundations)
- [x] kernel/ids, kernel/errors, kernel/json, kernel/events (audit 01)
- [x] ports/* (audit 02)
- [x] adapters/memory/* incl. FakeModel (audit 02)
- [x] domain/messages/model (audit 03)

## Wave 2
- [x] domain/messages/repair + store (audit 03)
- [x] domain/state (audit 04)
- [x] domain/scheduling/dsl + cron (audit 05)
- [x] domain/stream/chunks (audit 07)

## Wave 3
- [x] domain/scheduling/scheduler + keep-alive (audit 05)
- [x] domain/queue (audit 04)
- [x] domain/fibers (audit 06)
- [x] domain/stream/resumable (audit 07)
- [x] domain/tools/registry (audit 08)
- [x] domain/turn/admission (audit 09)
- [x] domain/session (audit 10)
- [x] domain/workspace (audit 15)
- [x] domain/fetch (audit 16)
- [x] domain/rpc/callable (audit 21)

## Wave 4
- [x] domain/turn/loop (audit 09)
- [x] domain/session/compaction (audit 10)
- [x] domain/submissions (audit 11)
- [x] domain/actions (audit 12)
- [x] domain/scheduled-tasks (audit 13)
- [x] domain/recovery + overflow (audit 14)
- [x] domain/workspace/tools (audit 15)
- [x] domain/skills (audit 17)
- [x] domain/channels (audit 18)
- [x] domain/delegation (audit 19)
- [x] domain/workflows (audit 20)

## Wave 5–6
- [x] app/agent (audit 22)
- [x] app/think (audit 23)
- [x] e2e scenarios (audit 24)

## Refactor wave (docs 25-26): transport-free agents
- [x] domain/events/log.ts — ConversationEventLog (audit 25 §1)
- [x] Agent exposes scheduler/fibers/keepAlive + registerInternalCallback (audit 26 §5)
- [x] app rewire: events out, no Connection/frames; extractions 1-4, 6 (audits 25 §2-3, 26)
- [x] adapters/websocket-chat + relay; resumable.ts retired; e2e rewired (audit 25 §4-6)

## Cloudflare adapter wave (doc 27): real Durable Object hosting
- [x] W1 substrate: vitest 4 bump, workers test rig, DurableKeyValueStore + DurableAlarmTimer, port contract suites green in workerd
- [x] W2 hosting: hostAgent shell + router + hibernatable WS connections, chat e2e in workerd
- [x] W3 delegation: facet spawner + root-multiplexed child alarm
- [x] W4 capabilities: workflows/email/service-binding adapters + demo worker (demo/cloudflare)
- [x] W5 AI SDK ModelClient adapter + Workers AI in the demo

## Log
- 2026-07-15: ADR-0002 ACCEPTED and rewritten (target-state) as `0002-three-layers-agent-chatagent-think.md`: three layers Agent (unchanged; Actor rename rejected — blast radius) → ChatAgent (new middle, to be extracted from Think: model + turn loop + transcript + conversation event vocabulary) → Think (opinions). Allocation-of-concerns table accepted; ConversationApi split into essence core + ApprovalApi + RecoveryIntrospection opinion extensions (transports require the intersection they speak — ISSUE-030 unblocked independent of the class split). Event-log incoherence resolved (mechanism on Agent, vocabulary on ChatAgent). "chat" added to the context-map watchlist; ISSUE-030 updated with the interface split; HANDOFF design section refreshed. Follow-up contradiction sweep across all written artifacts: docs/hosting-dx-sketch.md rewritten to the composed-transports model (ChatAgentDurableObject / instanceof-Think detection / `{chat:true}` flag removed; artifact republished), audit/30's `hostChatAgent` recommendation superseded in place, ISSUE-030 retitled (was "minimal DO host vs chat host") and its Option-C snippet aligned.
- 2026-07-15: authoring-API compatibility audit written (audit/30). Compared the ORIGINAL Think authoring surface (subclass hooks, config fields, public methods, exports, types, hosting model — extracted from packages/think) against the rebuild's, for the publish-as-new-Think goal. Finding: the authoring API is much closer to compatible than the fixture rewrites implied (those were 133:7 test-scaffolding vs real-API). Four piles: (1) ~half already compatible; (2) a half-day of cheap aliases erases most visible diff (getSchedule->getScheduleById, Session->createSession, messages getter, runTurn dispatcher, type-widening); (3) small deliberate breaks = the migration story (hostAgent() wrapper, transport hooks->adapter, this.sql decision, configureSession builder param); (4) the big 'missing' chunk is UNBUILT features (MCP/messengers/extensions/shell/codemode/workflow-base/email/media-eviction/framework), not breaks — they land API-matching when their issues ship. Recommendation: a compat-alias wave before publish + a this.sql decision; fold 'match original signature' into every unbuilt-feature issue's acceptance.
- 2026-07-15: recovery goal stretch 1 (R3, codex) committed — in-band stream errors (additive `error` ModelChunk variant on the port, threaded through anthropic/ai-sdk adapters, turn loop, and the wire) + abort/stall injection seams. Ported think-session 71->103 (+32, zero regressions); native 1076 node (4 new) + 42 workerd + typecheck green. Note: the port change exceeded the wave's letter but is the correct design (mid-stream provider errors must not destroy the stream) — accepted on review. Remaining stretch (2-4) parked as named ledger reasons: sanitization/row-size, saveMessages/addMessages, execute-hitl fixture rework.
- 2026-07-15: recovery GOAL PRIMARY ACCEPTED. R2 (codex) landed the onChatRecovery hook (ChatRecoveryContext + decisions incl. persist:false/continue:false) and recovery injection seams: think-session 57->71, zero regressions (per-test diff). Then three orchestrator fixes flipped two e2e files fully GREEN under real kill/restart — context-overflow-recovery 3/3 and action-pause-recovery 1/1: (a) lazy action-registry compile (approveExecution on fresh activation), (b) lazy overflow config reads honoring Think's mutable-config contract, (c) reactive-retry fidelity (post-compaction history re-read, per-attempt getModel(), discard the overflowing attempt's partial). Acceptance tally: waitUntilStable 9/9, onChatRecovery majority progress, e2e 2-of-4 fully green (goal threshold met). Remaining in-goal stretch (parked with named reasons in the ledger): persist-false continue-halt semantics, submission fixture seams, in-band stream errors/abort injection, sanitization/row-size, saveMessages/addMessages, execute-hitl fixture rework. Native 1072 node + 42 workerd + typecheck green.
- 2026-07-15: recovery goal wave R1 done (codex; wrapper ran a per-test regression diff against a reconstructed baseline — 0 regressions). Think.waitUntilStable({timeoutMs}) (quiescence = no running/queued turn + no armed continuation + no scheduled/in-flight recovery) and read-only recovery inspection (chatRecoveryIncidents/chatRecoverySchedule over durable incident rows; decision paths untouched). Ported think-session 54->57; waitUntilStable block 9/9; native 1067 node (4 new) + 42 workerd + typecheck green.
- 2026-07-15: GOAL stretch tier 4 begun+committed — wave P6 rewrote think-session.test.ts (the original's largest suite, 198 tests) against the rebuilt API: 54 pass, 7 dropped-with-pointer to native coverage, 137 fail with 33 NAMED missing-feature reasons (fixture helpers throw self-describing errors rather than silently stubbing) — a ready-made worklist for the next implementation goals. Ported board: 167/396 passing across 12 files. Native 1063+42 + typecheck green.
- 2026-07-15: GOAL COMPLETE (all tiers + bonus). Tier 3 / wave P5 ported the last unblocked files: routing 24/24 (FULL original suite green; found+fixed unknown-binding 400 divergence), assistant-agent-loop 22/23, protocol-messages 5/18 (frame-vocabulary verdicts pending), reattach-budget 0/1 + task-amplification 0/2 (deep delegation-recovery missing-features, honestly triaged). FINAL BOARDS: ported 113/198 passing (was 38/133 at goal start), e2e 8/19 (was 3/16), native 1063 node + 42 workerd + typecheck green throughout. Five real defects found and fixed by ported tests across the goal: ISSUE-026 payload framing, ISSUE-027 continuation stream identity, ISSUE-028 session parent-cycle infinite loop, kebab-slug routing, unknown-binding 400. ISSUES resolved this goal: 015, 018, 026, 027, 028, 029.
- 2026-07-15: GOAL stretch tier 2 done — ISSUE-015 resolved: domain/messages/reconcile.ts (collapse client-optimistic tool-call duplicates; part-wise no-downgrade merge for known ids) wired into the pre-turn append path; orphan write-back persists repairTranscript results for non-continuation turns (approval-requested exempt — parked, not orphaned); repair now coerces array/missing tool inputs to {}. Acceptance: message-reconciliation 8/8. Fixture honesty fix (seed via real session, ensureSession now protected) exposed 4 client-tools FALSE-PASSES -> ISSUE-029 (approval-state vocabulary). Boards: ported 59/133 net, e2e 8/16 stable, native 1063 node + 42 workerd green.
- 2026-07-15: GOAL stretch tier 1 done — ISSUE-018 resolved (#1645 semantics): proactive STREAM_RESUMING + connect suppression, ACK-gated replay from first delta, terminal retention in turn-state (recovery terminalize writes; eager clear on submit/clear; Think.pendingChatTerminal()), delta chunks stamped with part ids (t1...). onconnect-broadcast 7/9 (2 = /sub/ routing, blocked ISSUE-017). Boards: ported 57/133, e2e 8/16 stable, native 1058+42 green.
- 2026-07-15: GOAL tier 1 done — `framing` eliminated as a failure class. ISSUE-026 resolved (adapter speaks original payloads canonically: init.body envelope in, {id,body,done,error} chunks out, post-settle CHAT_MESSAGES resync; suspended turns keep streams open except durable-pause which is terminal); consumers + demo converged. Two real bugs found by ported tests and fixed: ISSUE-027 (interaction continuations minted fresh requestIds, orphaning client streams) and ISSUE-028 (session appendMessage parent-cycle -> synchronous infinite loop wedging workerd isolates; cycle guard + in-place refresh, regression test added). Boards: ported 38->55/133; e2e 3->8/16 with chat-recovery 5/5, stall-recovery, tool-rollback, action-ledger all GREEN under real kill/restart. Native: 1058 node + 42 workerd, typecheck clean. T0 gates green.
- 2026-07-14: test-port waves P1-P4 done (codex + orchestrator triage). Ported board baseline before the ISSUE-026 goal: workerd ported suite 133 tests / 38 passing; e2e suite 16 tests / 3 passing (incl. agent-tool reattach 2/2 and action-ledger lease reclaim 1/1 passing verbatim). Failures ledgered per-file in test-workers/ported/COVERAGE.md — `framing` (ISSUE-026) dominates. Real compat bug found+fixed by the ports: routing kebab-slugs mishandled acronym class names (E2EAgent → e2-eagent), silently falling through to the worker fallback; toKebabCase now matches original slug parity.
- 2026-07-14: W5 AI SDK adapter done (codex wave, zero fix rounds). createAiSdkModel over ai v6 streamText (no-execute tools = one generation per stream(); fullStream text/reasoning/tool-call/finish mapped; error part throws; abort → AbortedError); 7 mock-model node tests. Demo model selection: ANTHROPIC_API_KEY > Workers AI binding (workers-ai-provider, default @cf/moonshotai/kimi-k2.7-code) > offline. 1057 node + 42 workerd tests, typecheck clean, wrangler dev boot verified.
- 2026-07-14: audit 28 written — integrate-vs-reimplement assessment of non-core packages/modules (research: two coupling surveys of the original monorepo). Drop-ins: codemode, shell, mcp client, extensions seam, browser, observability, client/react (wire-compat payoff). Re-implement: ai-chat, McpAgent server, chat-sdk. Overlaps (session/skills/tools): keep clean-room versions, quarry features.
- 2026-07-14: W4 capabilities + demo done (codex wave, 1 fix round) — Cloudflare adapter wave COMPLETE. createWorkflowRuntime (Workflows bindings run fine under vitest-pool-workers), createEmailTransport (mimetext MIME + cloudflare:email EmailMessage behind an injectable factory; note mimetext RFC2047-encodes subjects), workersFetch/serviceBindingFetch (fetch read lazily per call). Runnable demo at demo/cloudflare (npm run demo:cf): offline scripted model or Anthropic via ANTHROPIC_API_KEY, dependency-free chat page with approval UI. Verified live: wrangler dev boot + real WebSocket handshake returning cf_agent_identity/cf_agent_chat_messages. Totals: 1050 node + 42 workerd tests, typecheck clean.
- 2026-07-14: W3 delegation done (codex wave, 3 fix rounds). Platform facts nailed by probes (kept as living tests): facets + ctx.exports work in pool-workers 0.16/workerd; RPC function args ARE callable across the facet boundary but the stubs are disposed when the carrying call ends (so no stored push-callbacks — child alarm state is synced after every child RPC instead); facet children CANNOT setAlarm at all ("alarms are not yet implemented for SQLite-backed DOs" — surfaced as an UNCATCHABLE out-of-band rejection), fully validating the root-multiplexed design. Built: createFacetSpawner, __call with explicit allowlist (chat/cancelChat/inspectRun + callables) + non-throwing __callResult, child virtual alarm rows + root min-of-all mux, callback drain keeping RPC turns open for streamed relays. 1050 node + 37 workerd tests, typecheck clean; W2 chat/alarm tests untouched-green.
- 2026-07-14: W2 hosting done (codex wave, 1 fix round). hostAgent shell (lazy blockConcurrencyWhile activation, x-agent-name identity persistence, __init/__destroy RPC, attachment-Proxy connection state, alarm mirror wiring), routeAgentRequest/getAgentByName, 7 workerd WS e2e tests: real-socket chat streaming through the router, reconnect resync from real storage, cross-socket state echo-exclusion, scheduler-over-real-alarm (via injected test clock — real workerd auto-fires past alarms), destroy wipe. 1050 node + 26 workerd tests, typecheck clean. New: narrow node-async-hooks.d.ts shim (fibers' AsyncLocalStorage under nodejs_compat).
- 2026-07-14: W1 substrate done (first codex-exec wave; 2 fix rounds). DurableKeyValueStore over ctx.storage.kv (adapter-level order/prefix/limit guards + JSON-clone normalization over kv's structured-clone values); DurableAlarmTimer mirror gained flush() (awaitable write settling — audit §3 updated); KV contract suite extracted to src/ports/testing/kv-contract.ts and green against BOTH memory and real DO storage. Notable workerd finding: an alarm set in the past auto-fires before runDurableObjectAlarm can — tests must arm future timestamps. 1050 node + 19 workerd tests, typecheck clean.
- 2026-07-14: W1 tooling scaffold done by the orchestrator: vitest 4.1 bump (decorator lowering moved to an esbuild post-plugin — rolldown-vite/oxc doesn't lower stage-3 decorators), wrangler 4.105.0 + vitest-pool-workers 0.16.20 + workers-types installed, tsconfig.cloudflare.json split, vitest.workers.config.ts (cloudflareTest plugin — defineWorkersConfig is gone in 0.16), test-workers/ rig with a SQLite-backed ScaffoldAgent. Workerd smoke test green, incl. a ctx.storage.kv presence probe (the §2 primary substrate exists in real workerd). Node suite 1048 green; typecheck clean across both projects.
- 2026-07-14: audit 27 open questions resolved with the user and merged into the doc: facets for sub-agents (accepting the experimental flag + root-multiplexed child alarm), self-contained wrangler-dev demo at demo/cloudflare, agents/react smoke test deferred (compat by construction), waves implemented via codex exec (gpt-5.5) behind thin wrapper subagents. Also pinned: identity resolution (ctx.id.name unavailable inside a DO — x-agent-name header / facet init, persisted), _pk connection-id compat, toolchain versions + compat flags.
- 2026-07-14: Cloudflare adapter plan written (audit/27-cloudflare-adapters.md): sync KeyValueStore over ctx.storage.kv (SQL fallback), alarm mirror over the async slot, hibernatable-WS connections (hibernation == eviction, already survived by design), hostAgent mixin shell, facet spawner with root-multiplexed child alarms, contract suites re-run in workerd as the faithfulness proof. Three open questions for review (facets vs ctx.exports, client-package compat smoke test, example placement).
- 2026-07-14: interactive demo added (demo/cli.ts + node file-store/real-alarm adapters + Anthropic SDK model adapter). Offline scripted model works keyless; verified live: streaming, workspace tool, approval flow, kill-mid-stream -> restart recovery. 1050 tests still green.
- 2026-07-14: recovery conversation-dep surgery (the R2 deferral) done by the orchestrator: recovery.ts now owns continue/terminalize semantics (commits the repaired partial itself, persists the terminal message itself) over turnState + session + one scheduleTurn callback; Think's three recovery callbacks collapsed to scheduleRecoveryTurn. think.ts 1070 lines. 1050 tests green.
- 2026-07-14: refactor R3 done (1050 tests): websocket-chat adapter (cf_agent_* frames, resume via log offsets, echo exclusion, readonly), relayTurn in domain/events with adapter wrapper, resumable.ts deleted (log owns retention), chat-session + actions-approvals e2e run through the adapter. Refactor waves complete.
- 2026-07-14: refactor R2 done (1029 tests): app/ transport-free (banned-token test), turn-state + pending-interactions + assembly + maybeParkSuspension + session builder extracted; agent.ts 643 / think.ts 1096 lines (above ~450 target — recovery conversation-dep surgery deferred, inherent delegation surface). EventBus field renamed to `bus`; events() is the ConversationEventLog.
- 2026-07-14: refactor R1 done (973 tests): ConversationEventLog + Agent protected services; both Think facades and the fake-method dispatch hack deleted.
- 2026-07-14: refactor audit docs 25 (transport & lifecycle) and 26 (Think decomposition) written; decisions: methods canonical (no command envelope), replay built into the event port, cf_agent_* kept in the WS adapter, extractions bundled.
- 2026-07-13: e2e wave done (939 tests, 57 files). E2e agent fixed two Think bugs (stable session id across restarts; continuation now commits the repaired partial before re-running). Orchestrator closed three follow-up gaps: delegation summarize() reads UiChunk `delta`; Think.onStart reconciles declared tasks; public inspect/list/cancel/deleteSubmissions on Think. Remaining known gap: no public Think entry point for AgentToolRunService.reconcile() (e2e drives the domain service directly).
- 2026-07-13: Think composition root done (919 tests). Known gaps noted in agent report: deep interruption recovery + full delegation flow deferred to e2e; MessageStore row-size guard not wired (session owns persistence).
- 2026-07-13: wave 5 done (901 tests): chat recovery + overflow guard, Agent composition root over memory host.
- 2026-07-13: wave 4 done (826 tests): turn loop, fibers, actions, scheduled-tasks, delegation. (Wave interrupted once by session usage limit; all five agents resumed and completed.)
- 2026-07-13: wave 3 done (680 tests): scheduler/keep-alive, queue, admission, tool registry, session+compaction, workspace tools, fetch, skills, channels, workflows, submissions.
- 2026-07-13: wave 2 + workspace/callable/resumable done (357 tests). Tool types module added at domain/tools/types.ts.
- 2026-07-12: audit complete (docs 00–24), package scaffolded.
