# Agents as Tools

A focused minimal proof of the **agents-as-tools** pattern: during a single chat turn, the assistant dispatches a helper sub-agent to do multi-step work, and the helper's chat stream forwards live into the parent chat UI as the turn unfolds.

This is the v0.2 prototype for the design captured in
[`wip/inline-sub-agent-events.md`](../../wip/inline-sub-agent-events.md). It exists to drive that design empirically before the framework freezes any helper-protocol API.

**v0.2 (Option B from the design notes)** replaced v0.1's single-turn scripted helper with a real Think helper that runs its own inference loop. The helper IS a chat agent; the parent forwards the helper's chat stream chunks (`UIMessageChunk` shapes) inside a `helper-event` envelope.

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

The assistant calls the `research` tool. A live mini-chat panel renders inline under the tool call as the helper's own Think turn unfolds — text, reasoning blocks, internal tool calls, all rebuilt on the client from the helper's forwarded chunks via `applyChunkToParts`. When the helper finishes, the assistant's reply summarizes the result.

Plain chat works too — the helper only spawns when the model picks the `research` tool.

## What it demonstrates

```
Browser ──ws──▶ Assistant DO ──┬──▶ chat stream (UIMessage parts)
                                │
                                └──▶ side-channel `helper-event` frames
                                          │  (started + N chunks + finished/error,
                                          │   tagged with parentToolCallId)
                                          ▼
                                Researcher facet (itself a Think; retained for replay)
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

- **`Assistant extends Think`** — top-level chat agent. `getModel`, `getSystemPrompt`, `getTools` are the standard Think hooks. `getTools()` returns one tool, `research`, that wraps the helper.
  - `onStart` creates `cf_agent_helper_runs` (helper_id, parent_tool_call_id, helper_type, query, status, summary, error_message, started_at, completed_at) and migrates any `running` rows to `interrupted` so a parent crash can't leave a permanently-running panel.
  - `runResearchHelper` is the proto-shape of an eventual `helperTool(Cls)` framework helper: insert running row → broadcast synthesized `started` → open a byte stream over RPC from `helper.runTurnAndStream` → decode NDJSON frames → broadcast each as a `chunk` event with monotonic per-run sequence → fetch the helper's final assistant text → broadcast synthesized `finished` (or `error` on failure) → update row.
  - `onConnect` runs after Think's chat-protocol setup. It walks `cf_agent_helper_runs`, synthesizes a `started` event from row data, fetches the helper's stored chat chunks via DO RPC, forwards them as `chunk` events, and appends a synthesized `finished`/`error` lifecycle event from the row.

- **`Researcher extends Think`** — helper sub-agent, itself a Think. Has its own model, system prompt, tools (`web_search` returning simulated results so the demo runs offline), session, and chat protocol. **No second `ResumableStream`** on the helper to collide with Think's — the helper's own `_resumableStream` IS the canonical durable event log.
  - `runTurnAndStream(query, helperId)` returns a `ReadableStream<Uint8Array>` over DO RPC. Each NDJSON line is `{ sequence, body }` where `body` is a JSON-encoded `UIMessageChunk` — the same shape the helper's own WS clients see. The `body` field is `Uint8Array` because workerd's DO RPC stream bridge only transports byte chunks; object chunks fail with the opaque "Network connection lost" error tracked in [cloudflare/workerd#6675](https://github.com/cloudflare/workerd/issues/6675).
  - The forwarder is wired by **overriding `broadcast`**: while a `runTurnAndStream` is in flight, `MSG_CHAT_RESPONSE` chunks are tee'd into the active RPC stream. Other broadcasts (state, identity, MSG_CHAT_MESSAGES, future helper-events from any downstream) pass through untouched. The pattern preserves chunk durability (Think's `_streamResult` still calls `_resumableStream.storeChunk` first) and works for direct WS clients of the helper too — drill-in is just chat.
  - `getChatChunksForReplay()` exposes the helper's stored chunks for the parent's `onConnect` replay path.
  - `getFinalAssistantText()` returns the synthesized summary the parent uses as the tool output.

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

The cost of putting events on the helper's DO instead of the parent's: one extra roundtrip during reconnect to read each helper's chunks. The benefits: state containment (helper events are about the helper's work, not the chat's); zero new framework primitives needed (single-channel `ResumableStream` is sufficient because each DO has its own SQLite by isolation); and **drill-in for free** — a curious developer can open a normal `useAgentChat` against `useAgent({ sub: [{ agent: "Researcher", name: helperId }] })` to see the helper's full conversation in its own UI.

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
- The `onBeforeSubAgent` gate is open — any `helperId` will be routed through Assistant to a fresh facet if it doesn't exist. For the demo this is fine; production should gate on a `cf_agent_helper_runs` lookup so an attacker can't spawn arbitrary helper DOs by guessing ids.

## What's deliberately out of scope (and why)

| Limitation                                                                        | Tracked in `wip/inline-sub-agent-events.md` |
| --------------------------------------------------------------------------------- | ------------------------------------------- |
| No TTL/GC yet beyond Clear; completed helper facets are retained                  | Ring 5 (retention / lifetime)               |
| Helper-as-tool wrapping is hand-rolled, not `helperTool(Cls)`                     | Stage 4 step 3                              |
| Cancellation only half-wired (parent abort doesn't propagate to helper inference) | Ring 5 (cancellation propagation)           |
| `onBeforeSubAgent` gate is open — any helperId routes through Assistant to a fresh facet | Add a `cf_agent_helper_runs` lookup gate before promoting the example past prototype |
| Parent crash mid-helper marks the run interrupted; live work is not resumed       | Ring 5 (live tail subscription)             |
| Only Think-based parent. AIChatAgent port deferred                                | Stage 5 in the wip doc                      |

**Parent-crash recovery**: `Assistant.onStart` marks any `running` helper rows as `interrupted`. On the next connect, stored helper chunks replay and the parent appends a synthesized terminal error event (using the row's `interrupted` status) so the UI doesn't show a "Running" panel that never resolves. The helper's live work is not resumed; Ring 5's future "live tail subscription" is the place for that.

## Why Think helpers (not just AIChatAgent helpers)

The design notes argue Think-first because helpers want to live inside Think's fibers / sessions / turns model. v0.2 takes the next step: the helper is itself a Think, so it can use Think's auto-resume, fiber recovery, durable chat-stream resumption, and message persistence "for free" — none of which the parent has to reinvent.

The pieces that stay AIChatAgent-portable:

- The wire protocol (`HelperEvent`, `HelperEventMessage`) doesn't reference Think types.
- The `chunk` body is just a JSON-encoded `UIMessageChunk`, which is what AIChatAgent's `onChatMessage` would also produce.
- The parent forwarding path is `this.broadcast(...)` — works on both AIChatAgent and Think.
- The override-`broadcast` tee pattern works the same on AIChatAgent.

Porting the helper to AIChatAgent would mean: `class Researcher extends AIChatAgent<Env>`, override `onChatMessage` instead of `getModel`/`getSystemPrompt`/`getTools`, drop `getChatChunksForReplay` if AIChatAgent's stream-storage shape differs (today it doesn't — same `_resumableStream`). Roughly a 30-line diff.

## Tests

`src/tests/` mirrors `examples/assistant/src/tests` — vitest+workers harness with a test worker that subclasses production `Assistant` and `Researcher` to add seed/inspect helpers. `TestResearcher` overrides `getModel()` with a deterministic mock LanguageModel V3 so the helper's inference loop runs end-to-end without a Workers AI binding.

Coverage:

- **`registry.test.ts`** — schema (helper_type, query, summary, error_message), `running` → `interrupted` sweep, idempotent re-sweep.
- **`clear-helper-runs.test.ts`** — empty registry no-op, mixed-status cleanup, idempotency, missing-sub-agent best-effort path.
- **`helper-stream.test.ts`** — drives a real Think turn through the mock model. Asserts NDJSON byte-stream contract, monotonic sequence from 0, that the mock's `text-delta` arrives as a `UIMessageChunk` body, that every emitted chunk is durably stored, that `getFinalTurnText` returns the mock's response and is `null` on a never-ran helper, and that the mock's `throws` mode surfaces the actual error message via `getLastStreamError` (B2).
- **`reconnect-replay.test.ts`** — every branch of `onConnect` replay: empty registry, completed run (started + chunks + finished using row's summary), running run (no terminal), error run with stored `error_message`, error run with default message, interrupted run with stored chunks, interrupted run with no chunks, multiple runs in `started_at` order with per-run sequence numbering preserved.
- **`parallel-fanout.test.ts`** — concurrent helpers under different `parentToolCallId`s (Alpha — LLM dispatching `research` twice in one turn) and concurrent helpers under the same `parentToolCallId` (Beta — `compare`'s `Promise.all`). Live broadcast frames demux cleanly per `(parentToolCallId, helperId)`; per-helper sequences are monotonic from 0; `onConnect` replay correctly emits both helpers' frames under one shared parent tool call without sequence collisions.

Run with `npm test`.

## How to read this code in order

If you want the design clean:

1. `src/protocol.ts` first. Four event kinds, one wire frame, one demo constant. The `chunk` body is opaque so the protocol stays AI-SDK-version-agnostic.
2. Then `src/server.ts`, top-down: `Researcher` (extends Think; override `broadcast` tees chunks; `runTurnAndStream` drives `saveMessages` and writes NDJSON chat-frame bodies to a `ReadableStream` over RPC; `getChatChunksForReplay` exposes Think's stored chunks for replay), then `Assistant.runResearchHelper` (parent decodes the byte stream, broadcasts each chunk wrapped in a `helper-event` envelope, synthesizes lifecycle events around it), then `Assistant.onConnect` (per-row replay synthesis).
3. Then `src/client.tsx`, starting from `applyHelperEvent`. Each helper accumulates parts via `applyChunkToParts`; the rendered panel is the same shape `useAgentChat` produces for the assistant's own message.
4. Then `wip/inline-sub-agent-events.md` for the design context this is grounding, especially the "Decisions confirmed 2026-04-28" section that explains why helpers are Think DOs (Option B) rather than `Agent`-with-scripted-events (the v0.1 prototype).

If you want to see parallel fan-out in action:

- Send a message like _"Compare HTTP/3 and gRPC for me."_ — the LLM picks the `compare` tool, which dispatches both Researcher helpers via `Promise.allSettled`. Two panels render side-by-side under the single `compare` tool call, each rebuilding its own `UIMessage` from its own chunk firehose.
- Or ask about two unrelated topics — _"Research Rust web frameworks AND OAuth vs OIDC."_ — and the LLM may call `research` twice in parallel, producing two separate tool calls with one panel each.
- Or mix tools in one turn — _"Compare HTTP/3 and gRPC, then plan how I'd add HTTP/3 support to my service."_ — and the LLM may call `compare` and `plan` in parallel, with the Researcher panels and the Planner panel rendering as siblings under different tool parts.

If you want to drill in:

- Click the ↗ button on any helper panel. The helper's full chat opens in a side panel — same `useAgentChat` machinery as the parent's main chat, just pointed at the helper's sub-agent URL. Try typing a follow-up question; it's a real Think turn.

If you want to extend it:

- **Try parallel helpers in one turn.** Add a second tool that fans out, or have the LLM call `research` twice — the `helperId` and `sequence` plumbing already supports per-helper demux on the client. Next-steps item 2 in the wip doc.
- **Wire the drill-in detail view.** A click on a helper panel opens a side panel that uses `useAgentChat` against the helper directly via `useAgent({ sub: [{ agent: "Researcher", name: helperId }] })`. The routing is free; only the UI is missing. Next-steps item 3 in the wip doc.
- **Refresh the page mid-helper.** Both the chat stream and the helper timeline catch up cleanly. Compare with v0.1, where the timeline was scripted events; v0.2 streams the helper's actual reasoning + tool calls.

## Related

- [`wip/inline-sub-agent-events.md`](../../wip/inline-sub-agent-events.md) — the full design context this example is grounding.
- [`docs/sub-agents.md`](../../docs/sub-agents.md) — the routing primitive (`subAgent`, `parentAgent`, `useAgent({ sub })`) this example builds on.
- [`examples/multi-ai-chat`](../multi-ai-chat) — the other "minimal proof" example, for the routing primitive itself. Sibling-conversations pattern.
- [`examples/assistant`](../assistant) — the kitchen-sink Think reference. This example's helper pattern will eventually be folded in once the API stabilizes.
- [`examples/ai-chat`](../ai-chat) — the canonical AIChatAgent reference.
- [`#1377`](https://github.com/cloudflare/agents/issues/1377) — the issue that surfaced the underlying primitive gap.
