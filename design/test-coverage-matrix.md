# Test coverage matrix

Living design doc. A single place to answer "what proves feature X works, at which
layer, and which CI run guards it?" — and to track the gaps and quarantined tests
we still owe.

This doc does **not** redefine the testing philosophy. The layer model, scenario
lists, and release-gate reasoning live in
[`rfc-chat-recovery-foundation.md`](./rfc-chat-recovery-foundation.md) (§Testing
strategy, Layers 1–6). This doc is the operational rollup across the whole repo,
including non-recovery features.

## How to use / maintain this doc

- When you add a feature, add a row and mark the layers it's covered at.
- When you add a test layer to an existing feature, flip the cell and cite the
  dir/file.
- When you `skip`/quarantine a test, add it to [Skipped & quarantined](#skipped--quarantined-test-debt)
  with a reason and a target layer — don't let it rot silently.
- Cells cite a directory or representative file, not an exhaustive list.

## Layer model (recap)

| Layer   | Name                            | Runtime                                                              | Where                                                           | Runs in                                       |
| ------- | ------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| **0**   | Type-level                      | `tsgo`, `*.test-d.ts`                                                | `packages/*/src/tests-d/`, `*.test-d.ts`                        | PR + release (`check` → typecheck)            |
| **1/2** | Unit / adapter contract         | in-process vitest (Node)                                             | `src/chat/__tests__/`, `src/tests/` (pure)                      | PR (affected) + release (all)                 |
| **3**   | Workers-pool integration        | `@cloudflare/vitest-pool-workers` (simulated workerd, in-process DO) | `src/tests/` + `vitest.config.ts` using `cloudflareTest()`      | PR (affected) + release (all)                 |
| **3b**  | React hooks (browser)           | Playwright via `@vitest/browser-playwright`, or jsdom                | `src/react-tests/`                                              | PR + release (when in package default `test`) |
| **3c**  | Browser connector e2e           | Node vitest spawning `wrangler dev`                                  | `packages/agents/src/browser-tests/`                            | **not in CI** (excluded from default `test`)  |
| **4**   | Local e2e (SIGKILL / reconnect) | Node vitest, child `wrangler dev`, persistent state dir              | `src/e2e-tests/`, `e2e/*.test.ts`                               | **nightly**                                   |
| **4b**  | Playwright app e2e              | Playwright `webServer: wrangler dev`                                 | `packages/*/e2e/*.spec.ts`, `examples/*/e2e/`                   | **nightly** (ai-chat only today)              |
| **5**   | Deployed (real edge)            | `wrangler deploy` + HTTP to `*.workers.dev`                          | `deployed-recovery.test.ts`, `experimental/chat-recovery-probe` | **nightly schedule** / opt-in                 |
| **6**   | Release gates                   | composite                                                            | RFC checklist                                                   | PR = L0–3; nightly = L4                       |

### CI → layer mapping

| Workflow          | Command                                        | Layers                                      |
| ----------------- | ---------------------------------------------- | ------------------------------------------- |
| `pullrequest.yml` | `check` + `nx affected -t test`                | 0, 1/2, 3, 3b (per-package default `test`)  |
| `release.yml`     | `check` + `nx run-many -t test`                | same as PR, all packages (drift safety net) |
| `conformance.yml` | `test:conformance:*` (on `packages/agents/**`) | MCP client + server conformance             |
| `nightly.yml`     | per-package `test:e2e` / Playwright / deployed | 4, 4b (ai-chat), 5 (schedule/opt-in)        |

> `test:e2e` and `test:browser` are **deliberately excluded** from the default
> `test` script in `agents`/`ai-chat`/`think`, so PR/release do not run Layers
> 3c/4/4b/5. Those are nightly-only (or not wired at all — see hygiene below).

## Feature × layer matrix

Legend: ✅ covered · ⚠️ partial / indirect · — none · 🚫 gated (opt-in env)

| Feature / area                                                           |    L0 type    |                           L1/2 unit                           |                                                 L3 workers-pool                                                 |                      L3b react                       |                              L4 local-e2e                              |                  L4b playwright                  |       L5 deployed        |
| ------------------------------------------------------------------------ | :-----------: | :-----------------------------------------------------------: | :-------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------: | :--------------------------------------------------------------------: | :----------------------------------------------: | :----------------------: |
| Core Agent (state sync, RPC, routing, basePath)                          | ✅ `tests-d/` |                              ✅                               |                                             ✅ `agents/src/tests/`                                              |       ✅ `useAgent.test.tsx`, `client.test.ts`       |                                   —                                    |                        —                         |            —             |
| `useAgent` (connect, cache, RPC robustness, reconnect)                   |      ✅       |                               —                               |                                                        —                                                        |                  ✅ `react-tests/`                   |                                   —                                    |                        —                         |            —             |
| `useAgentToolEvents` (live-vs-replay dedupe, terminal guard)             |      ✅       |              ✅ reducer in `chat/agent-tools.ts`              |                                 ⚠️ replay-on-connect via `_replayAgentToolRuns`                                 |        ✅ `useAgentToolEvents.test.tsx` (new)        |                       ⚠️ via agent-tool recovery                       | ⚠️ `examples/agents-as-tools/e2e/refresh-replay` |            —             |
| `useAgentChat` (replay, per-socket resume ACK dedupe, accumulator)       |      ✅       |          ✅ `broadcast-state`, `stream-accumulator`           |                                             ✅ `ai-chat/src/tests/`                                             | ✅ `ai-chat/src/react-tests/use-agent-chat.test.tsx` |                      ✅ `ai-chat/src/e2e-tests/`                       |                ✅ `ai-chat/e2e/`                 |  ✅ `deployed-recovery`  |
| Chat streaming & resume handshake (`ResumableStream`, `ResumeHandshake`) |      ✅       |          ✅ `chat/__tests__/resume-handshake-frames`          |                                                       ✅                                                        |          ⚠️ client side via `useAgentChat`           |                      ✅ `chat-recovery*.test.ts`                       |             ✅ `resume-none.spec.ts`             |            ✅            |
| Chat recovery engine (shared)                                            |      ✅       |                              ✅                               |                                                       ✅                                                        |                          —                           |                      ✅ agents/ai-chat/think e2e                       |                        —                         | ✅ ai-chat + think probe |
| Agent-tools / sub-agents (`runAgentTool`, `agentTool`, reattach, rebind) |      ✅       |                              ✅                               | ✅ `nested-agent-tools`, `max-concurrent-agent-tools`, `agent-tool-reattach-recovery`, `agent-tool-rebind-noop` |           ✅ `useAgentToolEvents.test.tsx`           |         ✅ `reattach-budget`, `agent-tool-recovery` (ai-chat)          |                   ⚠️ examples                    |            —             |
| Channels (policy re-apply across recovery)                               |      ✅       |                              ✅                               |                                          ✅ `channel-recovery.test.ts`                                          |                          —                           |                                   —                                    |                        —                         |            —             |
| Actions / HITL (durable pause × recovery)                                |      ✅       |                              ✅                               |                                       ✅ `action-pause-recovery.test.ts`                                        |                ⚠️ think studio jsdom                 |                        ✅ think `action-*` e2e                         |                        —                         |            —             |
| Turns / `runTurn` × recovery                                             |      ✅       |                              ✅                               |                                         ✅ `run-turn-recovery.test.ts`                                          |                          —                           |                              ✅ think e2e                              |                        —                         |            —             |
| Durable execution / fibers (eviction, poison rows, deadlines)            |      ✅       |                              ✅                               |                                                       ✅                                                        |                          —                           |                       ✅ `agents/src/e2e-tests/`                       |                        —                         |            —             |
| Workflows (durable steps, error reporting)                               |      ✅       | ⚠️ `workflow.test.ts` (5 `it.skip` in `workflow-integration`) |                                                       ⚠️                                                        |                          —                           |                                   —                                    |                        —                         |            —             |
| MCP (server/client)                                                      |      ✅       |                              ✅                               |                                                       ✅                                                        |                  ⚠️ `webmcp-tests/`                  |                                   —                                    |                        —                         |            —             |
| Voice                                                                    |      ✅       |                              ✅                               |                                      ✅ `voice/src/tests/` (SFU 🚫 gated)                                       |             ✅ `voice/src/react-tests/`              |                                   —                                    |                        —                         |            —             |
| Shell / Workspace                                                        |      ✅       |                              ✅                               |                                      ✅ `shell/src/tests/` (git clone 🚫)                                       |                          —                           |                                   —                                    |                        —                         |            —             |
| Codemode (dynamic worker exec)                                           |      ✅       |                              ✅                               |                                                       ✅                                                        |          ✅ `codemode/src/tests/` (browser)          |                                   —                                    |       ⚠️ `codemode/e2e/` (**not nightly**)       |            —             |
| Shared-engine genericity (pi / tanstack adapters)                        |      ✅       |                              ✅                               |                                                       ✅                                                        |                          —                           | ✅ `experimental/pi-recovery`, `tanstack-recovery` (workers-ai leg 🚫) |                        —                         |     ✅ tanstack leg      |

## Skipped & quarantined test debt

Tracked so it doesn't rot. **Group A** is intentional opt-in (live/billable deps);
**Group B** is disabled work we still owe. Resolving Group B is deferred (see the
session this doc landed in) — listed here so it's visible.

### Group A — intentional env-gates (not debt)

| Location                                                | Gate                                                 | Why                                             |
| ------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `ai-chat/src/e2e-tests/deployed-recovery.test.ts`       | `RUN_DEPLOYED_E2E=1`                                 | Billable real deploy; nightly-schedule only     |
| `experimental/tanstack-recovery/e2e/workers-ai.test.ts` | `RUN_WORKERS_AI_E2E=1`                               | Real Workers AI binding                         |
| `voice/src/tests/sfu-integration.test.ts`               | `CLOUDFLARE_REALTIME_SFU_*` / `SKIP_SFU_INTEGRATION` | Real SFU API                                    |
| `voice-providers/telnyx/tests/providers/tts.test.ts`    | `TELNYX_API_KEY`                                     | Live REST                                       |
| `think/src/e2e-tests/step-prompt-structured.test.ts`    | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`               | Optional real-provider structured-output checks |

### Group B — disabled / needs fixing (OPEN)

| Location                                             | Form      | Reason (from comments)                                                                                                     | Target layer |
| ---------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `agents/src/tests/workflow-integration.test.ts` (×5) | `it.skip` | Durable step methods + workflow introspection RPC don't compose under the harness; indirect coverage in `workflow.test.ts` | L3           |
| `agents/src/tests/workflow-error-reporting.test.ts`  | `it.skip` | Workflows runtime retries step failures; `waitForStatus("errored")` hangs                                                  | L3           |
| `agents/src/tests/basepath.test.ts`                  | `it.skip` | HTTP via custom path fails under `cloudflare:test`; WS path is covered                                                     | L3           |
| `agents/src/react-tests/useAgent.test.tsx`           | `it.skip` | Suspense/act timing in vitest-browser-react                                                                                | L3b          |
| `shell/src/tests/git.test.ts`                        | `it.skip` | Clone needs outbound network, unavailable in workers pool                                                                  | L3/L4        |

## Nightly hygiene

Current state and concrete recommendations. **Workflow edits (`.github/workflows`)
are ask-first** — the items below that touch `nightly.yml` are proposals pending
sign-off; the non-workflow fix is already applied.

### Done (non-workflow)

- **codemode Playwright `globalTimeout`** — added a 15-min `globalTimeout` to
  `packages/codemode/e2e/playwright.config.ts` so a hung llm spec fails _with_ a
  report instead of being silently killed (mirrors the ai-chat e2e configs). This
  is a test-config change, not a CI change.

### Proposed (needs sign-off — `nightly.yml`)

1. **Wire codemode e2e into nightly.** `packages/codemode/e2e` (Layer 4b) runs in
   no workflow today. Add a job mirroring `e2e-ai-chat`.
2. **Wire `agents test:browser` (Layer 3c) somewhere.** Currently excluded from
   default `test` and not in any nightly job → zero CI coverage of the browser
   connector e2e.
3. **Nightly unit safety net.** Nightly runs only Layers 4/4b/5. A scheduled
   `nx run-many -t test` would catch shared-code drift surfaced only by e2e paths
   (release already does this, but release is infrequent).
4. **Optionally enable the gated legs** in nightly with secrets present:
   `RUN_WORKERS_AI_E2E=1` for the tanstack leg of `e2e-engine-genericity`.
5. **Conformance in nightly.** MCP conformance runs on PR to `packages/agents/**`
   only; a nightly smoke would catch cross-package drift.

### Already-good patterns to keep

- ai-chat Playwright jobs split deterministic vs Workers-AI suites, each with a
  Playwright `globalTimeout` < the 30-min job ceiling, so a flaky edge can't sink
  the deterministic signal or produce a no-output cancel.
- Deployed jobs are opt-in (`schedule` / repo var / `workflow_dispatch`), keeping
  billable runs off PRs.

## History

- Companion to [`rfc-chat-recovery-foundation.md`](./rfc-chat-recovery-foundation.md)
  §Testing strategy — that RFC defines the layer model; this doc rolls it up across
  all features and tracks gaps.
