# Agents as Tools

A focused minimal proof of the **agents-as-tools** pattern: during a single chat turn, the assistant dispatches a helper sub-agent to do multi-step work, and the helper's chat stream forwards live into the parent chat UI as the turn unfolds.

This is the v0.2 prototype for the design captured in
[`wip/inline-sub-agent-events.md`](../../wip/inline-sub-agent-events.md). It exists to drive that design empirically before the framework freezes any helper-protocol API.

**v0.2 (Option B from the design notes)** replaced v0.1's single-turn scripted helper with a real Think helper that runs its own inference loop. The helper IS a chat agent; the parent forwards the helper's chat stream chunks (`UIMessageChunk` shapes) inside a `helper-event` envelope.

## Status (2026-04-28)

The example is feature-complete for v0.2. Three helper-dispatching tools (`research`, `plan`, `compare`), two concrete helper classes (`Researcher` + `Planner`) sharing a `HelperAgent` base, per-helper drill-in side panels, parallel fan-out, full reconnect-replay, cancellation propagation, and a production `onBeforeSubAgent` registry gate. 43 vitest tests cover server-side wire/state contracts; 7 Playwright e2e tests cover browser-side flows against real Workers AI. The next-up work is a Stage 3 RFC for the framework promotion (`helperTool(Cls)` and an AIChatAgent port) — see the design doc for context.

## Run

```bash
npm install
npm start
```

Open the dev URL. The page lands on a single chat. Send a message that asks for research:

- _Research the top three Rust web frameworks and compare their throughput._
- _Find me three good arguments for and against monorepos._
- _What changed in HTTP/3 versus HTTP/2?_
- _What are the key differences between OAuth 2.0 and OIDC?_

The assistant picks one of the helper-dispatching tools (`research`, `plan`, or `compare`). A live mini-chat panel renders inline under the tool call as the helper's own Think turn unfolds — text, reasoning blocks, internal tool calls, all rebuilt on the client from the helper's forwarded chunks via `applyChunkToParts`. When the helper finishes, the assistant's reply summarizes the result. `compare` fans out into TWO helpers and renders two panels side-by-side under the same tool call.

Plain chat works too — helpers only spawn when the model picks one of the helper-dispatching tools.

## What it demonstrates

```
Browser ──ws──▶ Assistant DO ──┬──▶ chat stream (UIMessage parts)
                                │
                                └──▶ side-channel `helper-event` frames
                                          │  (started + N chunks + finished/error,
                                          │   tagged with parentToolCallId)
                                          ▼
                                Helper facet (Researcher / Planner — itself a Think; retained for replay)
```

Three things, none of which the framework currently provides as a shipped primitive:

1. **A chat agent dispatching another chat agent inside a tool execute.** The helper sub-agent is itself a `Think` instance — own model, own system prompt, own tools, own session, own inference loop. The parent treats it as a turn-scoped worker (per-helper-run facet, retained after completion so its timeline can replay after refresh). Built on the existing `subAgent` / `parentAgent` routing primitive.
2. **A four-event helper protocol** wrapping the helper's chat-chunk firehose. Lifecycle (`started`, `finished`, `error`) is synthesized by the parent so panels render even before any chunks arrive; `chunk` carries an opaque JSON-encoded `UIMessageChunk` body forwarded verbatim from the helper's `_streamResult`. The client applies chunks via `applyChunkToParts` — the same primitive `useAgentChat` uses for the assistant's main message.
3. **Inline rendering on the client** — helper events are joined to the chat tool-call by `parentToolCallId` and render as a collapsible mini-message panel under the matching tool part, with text / reasoning / tool calls accumulated from chunks. The helper's progress is visible in the same place the user is already looking, not in a separate pane.

## Wire protocol (`src/protocol.ts`)

A thin module with **no Worker-runtime imports** — types and the `DEMO_USER` constant only. Both `server.ts` and `client.tsx` import from it; the front-end bundle never transitively pulls in `agents`, `@cloudflare/think`, or `workers-ai-provider` through a stray value import.

Four event kinds:

- `started { helperId, helperType, query }` — synthesized by the parent before the helper runs. Always sequence 0.
- `chunk { helperId, body }` — `body` is a JSON-encoded `UIMessageChunk` from Think's `_streamResult`, forwarded verbatim. Sequences 1..N.
- `finished { helperId, summary }` — synthesized by the parent on completion. Sequence N+1.
- `error { helperId, error }` — synthesized by the parent on failure. Sequence N+1.

The `chunk` body is opaque to this protocol module so it stays AI-SDK-version-agnostic. The client parses each body and runs it through `applyChunkToParts` from `agents/chat` to maintain a per-helper `UIMessage.parts` array.

## Server (`src/server.ts`)

- **`Assistant extends Think`** — top-level chat agent. `getModel`, `getSystemPrompt`, `getTools` are the standard Think hooks. `getTools()` returns three tools (`research`, `plan`, `compare`) that all dispatch helper sub-agents.
  - `onStart` creates `cf_agent_helper_runs` (helper_id, parent_tool_call_id, helper_type, query, status, summary, error_message, display_order, stream_id, started_at, completed_at) and migrates any `running` rows to `interrupted` so a parent crash can't leave a permanently-running panel.
  - `_runHelperTurn(cls, query, parentToolCallId, displayOrder?)` is the proto-shape of an eventual `helperTool(Cls)` framework helper, parameterized by the helper class so `research`, `plan`, and `compare` can all reuse it: insert running row → broadcast synthesized `started` → open a byte stream over RPC from `helper.runTurnAndStream` → decode NDJSON frames → broadcast each as a `chunk` event with monotonic per-run sequence → fetch the helper's final assistant text → broadcast synthesized `finished` (or `error` on failure) → update row.
  - `onConnect` runs after Think's chat-protocol setup. It walks `cf_agent_helper_runs`, resolves each row's `helper_type` to the right helper class via the `helperClassByType` registry, synthesizes a `started` event from row data, fetches the helper's stored chat chunks via DO RPC (using the row's pinned `stream_id` so drill-in follow-up turns don't shadow the original turn's chunks), forwards them as `chunk` events, and appends a synthesized `finished`/`error` lifecycle event from the row.

- **`HelperAgent extends Think`** — abstract base for helper sub-agents. Carries everything the helper protocol needs: the `broadcast` tee, `runTurnAndStream`, the concurrent-call guard, `getFinalTurnText`, `getLastStreamError`, and the drill-in stream-id snapshotting that powers D1 replay isolation. Concrete helpers stay thin — pick a model, a system prompt, and a tool surface.
  - `runTurnAndStream(query, helperId)` returns a `ReadableStream<Uint8Array>` over DO RPC. Each NDJSON line is `{ sequence, body }` where `body` is a JSON-encoded `UIMessageChunk` — the same shape the helper's own WS clients see. The `body` field is `Uint8Array` because workerd's DO RPC stream bridge only transports byte chunks; object chunks fail with the opaque "Network connection lost" error tracked in [cloudflare/workerd#6675](https://github.com/cloudflare/workerd/issues/6675).
  - The forwarder is wired by **overriding `broadcast`**: while a `runTurnAndStream` is in flight, `MSG_CHAT_RESPONSE` chunks are tee'd into the active RPC stream. Other broadcasts (state, identity, MSG_CHAT_MESSAGES, future helper-events from any downstream) pass through untouched. The pattern preserves chunk durability (Think's `_streamResult` still calls `_resumableStream.storeChunk` first) and works for direct WS clients of the helper too — drill-in is just chat.
  - `getChatChunksForReplay(streamId?)` exposes the helper's stored chunks for the parent's `onConnect` replay path; passing the row's pinned `stream_id` returns ONLY the original turn's chunks even if a drill-in follow-up has added newer streams.
  - `getFinalTurnText()` returns the assistant text produced by the most recent turn, used as the tool output.

- **`Researcher extends HelperAgent`** — concrete helper class. Own model, system prompt, and tools (`web_search` returning simulated results so the demo runs offline).

- **`Planner extends HelperAgent`** — second concrete helper class with a different system prompt (writes structured implementation plans) and a different tool (`inspect_file`). Validates that the helper protocol generalizes across diverse helper workflows, not just research-shaped ones.

- The whole helper run is wrapped in `keepAliveWhile` (via `saveMessages`'s own keep-alive, plus an explicit wrapper around the Think turn) so the helper DO stays alive across the inference loop pauses.

## Client (`src/client.tsx`)

- One connection: `useAgent({ agent: "Assistant", name: "demo" })` driving `useAgentChat({ agent })` for the chat itself.
- A separate `addEventListener("message")` on the same socket sieves out `helper-event` frames. Each frame carries a `sequence` (monotonic per helper run); a `useRef`-backed Set of seen `(parentToolCallId, helperId, sequence)` triples handles the small reconnect-window race where one event arrives both as a replay frame and as a live broadcast. The dedup key has to include `helperId`, not just `parentToolCallId`, because two parallel helpers under one tool call (the `compare` pattern) both legitimately emit a `sequence: 0` started event.
- Per helper, an `applyHelperEvent` reducer folds events into a `HelperState` `{ helperId, helperType, query, status, parts, summary?, error? }`. The `parts` field is built by running each `chunk` body through `applyChunkToParts` from `agents/chat` — the same primitive `useAgentChat` uses to rebuild the assistant's `UIMessage` from the chat-stream firehose.
- State shape is `Record<parentToolCallId, Record<helperId, HelperState>>`. `<MessageParts>` walks the assistant message's parts as usual; for each tool part, it looks up the bucket of helpers under that `toolCallId` and renders a `<HelperPanel>` per helper. Single-helper tool calls show one panel; parallel-fan-out tool calls (`compare`) show several panels stacked as siblings under one `<ToolPart>`, matching the GLips screenshot pattern.

## Durability and reconnect

Both the chat stream and helper events are durable across page refresh:

- The chat stream is Think's existing `ResumableStream`, unchanged.
- Helper chunks are stored on **the helper's own DO**, in **Think's own `_resumableStream`** on the helper. There's no second stream on the helper, no shared tables — single-channel-per-DO, isolated by SQLite scope. On parent reconnect the parent re-fetches the helper's stored chunks and forwards them to the connecting client wrapped in synthesized lifecycle events.

The cost of putting events on the helper's DO instead of the parent's: one extra roundtrip during reconnect to read each helper's chunks. The benefits: state containment (helper events are about the helper's work, not the chat's); zero new framework primitives needed (single-channel `ResumableStream` is sufficient because each DO has its own SQLite by isolation); and **drill-in for free** — a curious developer can open a normal `useAgentChat` against `useAgent({ sub: [{ agent: helperType, name: helperId }] })` to see the helper's full conversation in its own UI.

## Tools

Three tools are exposed to the orchestrator LLM:

- **`research(query)`** — dispatches a single `Researcher` helper. Use for deep dives on one topic. The helper has a simulated `web_search` tool and produces a 2–3 paragraph summary.
- **`plan(description)`** — dispatches a single `Planner` helper. Use for "how do I implement X" / "what's a plan for Y" questions. The helper has a simulated `inspect_file` tool and produces a structured implementation plan (Overview / Affected files / Step-by-step / Open questions).
- **`compare(a, b)`** — dispatches **two `Researcher` helpers in parallel** via `Promise.allSettled`, both sharing the chat tool call's `toolCallId`. The two helpers render as siblings under one chat tool part — the visible "fan-out from one tool call" pattern from [#1377-comment-4328296343](https://github.com/cloudflare/agents/issues/1377#issuecomment-4328296343) image 3. Returns `{ a: { query, summary | error }, b: { query, summary | error } }` so the orchestrator LLM can react to a partial failure (one branch succeeded, the other errored) without the whole tool call being thrown into error and leaving the survivor's "Done" panel as a confusing mixed signal.

The LLM also has the option to call `research` (or `plan`) multiple times in one turn (AI SDK `parallel_tool_calls` default). All shapes work — the wire protocol's `(parentToolCallId, helperId, sequence)` triple uniquely identifies events regardless of whether helpers share a parent tool call or not. Helpers under one shared `parentToolCallId` are rendered in a deterministic left-to-right order via an explicit `order` integer the parent stamps onto each helper's `started` event (`compare` passes `0` for `a`, `1` for `b`). The order also survives reconnect: it's persisted in `cf_agent_helper_runs.display_order` so `onConnect` replay synthesizes the same panel ordering the live broadcast did.

`Researcher` and `Planner` both extend a shared `HelperAgent` base (itself extending `Think`). `HelperAgent` carries everything the helper protocol needs — the `broadcast` tee, `runTurnAndStream`, lifecycle accessors — so concrete helpers stay thin (pick a model / system prompt / tools, that's it). The parent dispatches by class via `_runHelperTurn(cls, ...)`, and a `helper_type → class` registry resolves the right concrete class on `onConnect` / `clearHelperRuns` from the row's stored `helper_type` string.

## Drill-in: helpers are real chat

Every helper panel has an ↗ button in its header. Clicking it opens a side panel that runs `useAgentChat` directly against the helper's own sub-agent connection:

```ts
const helperAgent = useAgent({
  agent: "Assistant",
  name: DEMO_USER,
  // `helperType` is the row's class name ("Researcher" or "Planner")
  // so drill-in routes to the right facet for whichever helper class
  // produced the panel the user clicked through from.
  sub: [{ agent: helperType, name: helperId }]
});
const { messages, sendMessage } = useAgentChat({ agent: helperAgent });
```

Because the helper IS a Think, the side panel is a real chat — same `<MessageParts>` renderer, same Streamdown, same composer. The user can also continue the conversation with the helper directly: typing in the side panel's composer triggers a fresh Think turn on the helper, with the parent's original query and the previous assistant response already in context.

The framework's `subAgent` routing primitive does all the work — there's no cross-DO state, no parent intervention, just a normal `useAgentChat` against a sub-agent URL. This is the "real chat, not a custom event view" promise of [Option B](../../wip/inline-sub-agent-events.md).

A few things to note:

- The side panel and the inline panel render the same chunks from two angles. While a turn is running, both update live; clicking ↗ doesn't pause anything.
- Closing the panel (Escape, ✕ button, or backdrop click) tears down the helper WS connection; reopening opens a fresh one.
- Recursive drill-in (helper → its own sub-helper) isn't wired; helpers in this example don't dispatch their own helpers. The protocol supports it; only the UI would need an extra level.
- **Sub-agent connections are gated.** `Assistant.onBeforeSubAgent` looks up the requested `(helperType, helperId)` in `cf_agent_helper_runs` and returns a 404 if the row doesn't exist. Drill-in URLs are NOT guessable — an attacker can't route through to a fresh empty helper facet by inventing a name, and they can't drill into a helper of class A by routing through class B's endpoint. This is the production posture; rip out the override if you specifically want the demo's old "any name spawns a fresh facet" behavior back.

## What's deliberately out of scope (and why)

| Limitation                                                                  | Tracked in `wip/inline-sub-agent-events.md` |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| No TTL/GC yet beyond Clear; completed helper facets are retained            | Ring 5 (retention / lifetime)               |
| Helper-as-tool wrapping is hand-rolled, not `helperTool(Cls)`               | Stage 4 step 3                              |
| Parent crash mid-helper marks the run interrupted; live work is not resumed | Ring 5 (live tail subscription)             |
| Only Think-based parent. AIChatAgent port deferred                          | Stage 5 in the wip doc                      |

**Parent-crash recovery**: `Assistant.onStart` marks any `running` helper rows as `interrupted`. On the next connect, stored helper chunks replay and the parent appends a synthesized terminal error event (using the row's `interrupted` status) so the UI doesn't show a "Running" panel that never resolves. The helper's live work is not resumed; Ring 5's future "live tail subscription" is the place for that.

**Cancellation propagation (B4)**: `Assistant`'s tool executes thread the AI SDK's `abortSignal` (which Think hooks to its own `_aborts` registry) into `_runHelperTurn`. When the parent's chat turn aborts, the parent's RPC reader is cancelled, the helper RPC stream's `cancel` callback fires, and `abortCurrentTurn` calls `_aborts.destroyAll()` on the helper. The row is marked `error` with an "abort" message and a synthesized `error` event broadcasts so the panel doesn't sit on "Running…" forever.

Helper-side abort is **best-effort** here. Think's `saveMessages` mints its own `requestId` and lazily creates the abort controller via `_aborts.getSignal(requestId)` only after several internal awaits (`keepAliveWhile` → `_turnQueue.enqueue` → `appendMessage` → `_broadcastMessages` → then `getSignal`). If the parent's `cancel()` arrives before that point, `destroyAll()` runs on an empty registry and the inference still runs to completion. In practice cancels arrive mid-inference (Stop button after several seconds) and the controller exists; for a very early cancel the helper wastes one inference pass. The proper fix needs `Think.saveMessages` to accept an external `AbortSignal` so the helper can pass in a controller it owns from turn start — filed as [`cloudflare/agents#1406`](https://github.com/cloudflare/agents/issues/1406).

## Why Think helpers (not just AIChatAgent helpers)

The design notes argue Think-first because helpers want to live inside Think's fibers / sessions / turns model. v0.2 takes the next step: the helper is itself a Think, so it can use Think's auto-resume, fiber recovery, durable chat-stream resumption, and message persistence "for free" — none of which the parent has to reinvent.

The pieces that stay AIChatAgent-portable:

- The wire protocol (`HelperEvent`, `HelperEventMessage`) doesn't reference Think types.
- The `chunk` body is just a JSON-encoded `UIMessageChunk`, which is what AIChatAgent's `onChatMessage` would also produce.
- The parent forwarding path is `this.broadcast(...)` — works on both AIChatAgent and Think.
- The override-`broadcast` tee pattern works the same on AIChatAgent.

Porting the helper to AIChatAgent would mean: `class Researcher extends AIChatAgent<Env>`, override `onChatMessage` instead of `getModel`/`getSystemPrompt`/`getTools`, drop `getChatChunksForReplay` if AIChatAgent's stream-storage shape differs (today it doesn't — same `_resumableStream`). Roughly a 30-line diff.

## Tests

`src/tests/` mirrors `examples/assistant/src/tests` — vitest+workers harness with a test worker that subclasses production `Assistant`, `Researcher`, and `Planner` to add seed/inspect helpers. `TestResearcher` and `TestPlanner` each override `getModel()` with a deterministic mock LanguageModel V3 so each helper's inference loop runs end-to-end without a Workers AI binding. The mock has an `ok` mode (yields a fixed text-delta) and a `throws` mode (rejects from `doStream`) to exercise both happy and error paths.

Coverage:

- **`registry.test.ts`** — `cf_agent_helper_runs` schema (helper_type, query, summary, error_message, display_order, stream_id), `running` → `interrupted` sweep, idempotent re-sweep.
- **`clear-helper-runs.test.ts`** — empty registry no-op, mixed-status cleanup, idempotency, missing-sub-agent best-effort path, mixed-class (Researcher + Planner) cleanup using the right facet table for each class.
- **`helper-stream.test.ts`** — drives a real Think turn through the mock model. Asserts NDJSON byte-stream contract, monotonic sequence from 0, that the mock's `text-delta` arrives as a `UIMessageChunk` body, that every emitted chunk is durably stored, that `getFinalTurnText` returns the mock's response and is `null` on a never-ran helper, and that the mock's `throws` mode surfaces the actual error message via `getLastStreamError` (B2). Includes a Planner end-to-end test that drives the full byte stream through the same protocol Researcher uses, validating the helper-event vocabulary generalizes across helper classes.
- **`reconnect-replay.test.ts`** — every branch of `onConnect` replay: empty registry, completed run (started + chunks + finished using row's summary), running run (no terminal), error run with stored `error_message`, error run with default message, interrupted run with stored chunks, interrupted run with no chunks, multiple runs in `started_at` order with per-run sequence numbering preserved. Plus the Planner replay test (C1, validates the class registry resolves `helper_type` correctly on `onConnect`) and the D1 drill-in follow-up isolation test (asserts replay returns the original turn's chunks even after a follow-up turn has added a newer stream).
- **`parallel-fanout.test.ts`** — concurrent helpers under different `parentToolCallId`s (Alpha — LLM dispatching `research` twice in one turn) and concurrent helpers under the same `parentToolCallId` (Beta — `compare`'s `Promise.all`). Live broadcast frames demux cleanly per `(parentToolCallId, helperId)`; per-helper sequences are monotonic from 0; `onConnect` replay correctly emits both helpers' frames under one shared parent tool call without sequence collisions. Includes a 3-helper Beta stress test for N>2.
- **`cancellation-and-gate.test.ts`** — cancellation propagation (B4) and the production sub-agent gate (E4). For B4: drives `_runHelperTurn` with a pre-aborted signal and asserts both the rejection message and the row's `error` status carry the abort cause. For E4: HTTP-fetches `/sub/researcher/<bogus-id>` directly and asserts the parent returns 404, then HTTP-fetches the same URL after seeding a real row and asserts a 101 WS upgrade. Includes a cross-class isolation case that prevents drilling into a Researcher facet via the Planner endpoint.

Run with `npm test`.

## End-to-end browser tests

Server-side tests cover everything that goes over the WebSocket and DO RPC, but they can't catch bugs that live in the React layer — `useAgent` URL resolution, drill-in routing, replay-vs-live state reducers in the browser. The `e2e/` directory has a Playwright suite that boots `vite dev` and drives the real app in Chromium against a real Workers AI binding.

Run with `npm run test:e2e` (headless), `npm run test:e2e:headed` (visible browser), or `npm run test:e2e:ui` (Playwright's interactive mode).

What's covered:

- **`smoke.e2e.ts`** — page loads, WebSocket handshake completes, composer becomes interactive. Fast first signal for "is the dev server even working".
- **`research-drill-in.e2e.ts`** — research prompt spawns a Researcher panel; clicking ↗ opens a side panel that connects to a Researcher facet and renders messages.
- **`planner-drill-in.e2e.ts`** — same flow for `plan`, with the side panel connecting to a Planner facet. Pins the routing fix from `e9c0e0ff` (the `agent: "Researcher"` hardcode in `<DrillInPanel>` would have hung this test on "Connecting to helper…" before the fix).
- **`compare-fanout.e2e.ts`** — `compare` prompt renders TWO Researcher panels under one chat tool call, both reaching terminal status. The visible "fan-out from one tool call" pattern from #1377-comment-4328296343 image 3.
- **`refresh-replay.e2e.ts`** — completed runs survive a page reload. `Assistant.onConnect` walks `cf_agent_helper_runs` and replays each row's chunks; the post-reload page rebuilds the same panels from durable storage. Single-helper case + Researcher+Planner two-helper case.
- **`clear.e2e.ts`** — Clear button wipes both chat history and the helper-runs registry; a reload after Clear doesn't bring panels back (the `clearHelperRuns()` → `clearHistory()` order matters).

Each test runs against a unique Assistant DO via a `?user=<random>` query param the client honors as an override for `DEMO_USER`. Combined with `workers: 1` in the Playwright config, that makes the suite hermetic across runs without `rm -rf .wrangler/state` — no helper-rows or chat-history state from a previous test can affect the next one. (Originally this also worked around a `partyserver` 0.5.3 bug with facet-alarm name recovery, [partykit#390](https://github.com/cloudflare/partykit/issues/390); 0.5.4 fixes that.)

Real-LLM caveats: the example uses `@cf/moonshotai/kimi-k2.5`, which is slow and occasionally returns 504 Gateway Timeout when Workers AI is overloaded. The config has `retries: 1` to ride out transient capacity issues. A full suite run takes ~4-5 minutes locally.

## How to read this code in order

If you want the design clean:

1. `src/protocol.ts` first. Four event kinds, one wire frame, one demo constant. The `chunk` body is opaque so the protocol stays AI-SDK-version-agnostic.
2. Then `src/server.ts`, top-down: `HelperAgent` (extends Think; override `broadcast` tees chunks; `runTurnAndStream` drives `saveMessages` and writes NDJSON chat-frame bodies to a `ReadableStream` over RPC; `getChatChunksForReplay` exposes Think's stored chunks for replay) → `Researcher` and `Planner` (one-screen subclasses that pick a model / system prompt / tools each) → `Assistant._runHelperTurn` (parent decodes the byte stream, broadcasts each chunk wrapped in a `helper-event` envelope, synthesizes lifecycle events around it) → `Assistant.onConnect` (per-row replay synthesis, with the helper class resolved from each row's `helper_type` via the `helperClassByType` registry).
3. Then `src/client.tsx`, starting from `applyHelperEvent`. Each helper accumulates parts via `applyChunkToParts`; the rendered panel is the same shape `useAgentChat` produces for the assistant's own message.
4. Then `wip/inline-sub-agent-events.md` for the design context this is grounding, especially the "Decisions confirmed 2026-04-28" section that explains why helpers are Think DOs (Option B) rather than `Agent`-with-scripted-events (the v0.1 prototype).

If you want to see parallel fan-out in action:

- Send a message like _"Compare HTTP/3 and gRPC for me."_ — the LLM picks the `compare` tool, which dispatches both Researcher helpers via `Promise.allSettled`. Two panels render side-by-side under the single `compare` tool call, each rebuilding its own `UIMessage` from its own chunk firehose.
- Or ask about two unrelated topics — _"Research Rust web frameworks AND OAuth vs OIDC."_ — and the LLM may call `research` twice in parallel, producing two separate tool calls with one panel each.
- Or mix tools in one turn — _"Compare HTTP/3 and gRPC, then plan how I'd add HTTP/3 support to my service."_ — and the LLM may call `compare` and `plan` in parallel, with the Researcher panels and the Planner panel rendering as siblings under different tool parts.

If you want to drill in:

- Click the ↗ button on any helper panel. The helper's full chat opens in a side panel — same `useAgentChat` machinery as the parent's main chat, just pointed at the helper's sub-agent URL. Try typing a follow-up question; it's a real Think turn.

If you want to refresh the page mid-helper:

- Both the chat stream and the helper timeline catch up cleanly. Live helpers continue rendering as their `running` row replays + tails; completed helpers replay through their stored chunks; interrupted helpers (parent crashed mid-run) replay the chunks that DID land plus a synthesized terminal error so the panel doesn't hang on "Running…".

If you want to extend it:

- **Add a third helper class.** Subclass `HelperAgent`, override `getModel`/`getSystemPrompt`/`getTools`, register it in `helperClassByType` and add it to `KNOWN_HELPER_TYPES` on the client. Then expose a tool in `Assistant.getTools()` that calls `_runHelperTurn(NewHelperClass, ...)`. The wire protocol, replay, drill-in routing, and tests all flow through the registry without touching anything else.
- **Stress the cancellation race window.** The cancel path uses `_aborts.destroyAll()` because the helper doesn't have access to the requestId Think generates internally. That works once `saveMessages` has reached its `getSignal(requestId)` call but loses an early cancel as a no-op. The clean fix is making `Think.saveMessages` accept an external `AbortSignal` — that's a framework follow-up.
- **Promote past prototype.** Wire an `onBeforeSubAgent` gate that checks `cf_agent_helper_runs` for the requested helperId before letting a sub-agent connection through. Without it, drill-in URLs are guessable and would spawn fresh empty facets.

## Related

- [`wip/inline-sub-agent-events.md`](../../wip/inline-sub-agent-events.md) — the full design context this example is grounding.
- [`docs/sub-agents.md`](../../docs/sub-agents.md) — the routing primitive (`subAgent`, `parentAgent`, `useAgent({ sub })`) this example builds on.
- [`examples/multi-ai-chat`](../multi-ai-chat) — the other "minimal proof" example, for the routing primitive itself. Sibling-conversations pattern.
- [`examples/assistant`](../assistant) — the kitchen-sink Think reference. This example's helper pattern will eventually be folded in once the API stabilizes.
- [`examples/ai-chat`](../ai-chat) — the canonical AIChatAgent reference.
- [`#1377`](https://github.com/cloudflare/agents/issues/1377) — the issue that surfaced the underlying primitive gap.
