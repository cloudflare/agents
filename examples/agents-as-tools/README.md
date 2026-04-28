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
- A separate `addEventListener("message")` on the same socket sieves out `helper-event` frames. Each frame carries a `sequence` (monotonic per helper run); a `useRef`-backed Set of seen `(parentToolCallId, sequence)` pairs handles the small reconnect-window race where one event arrives both as a replay frame and as a live broadcast.
- Per helper, an `applyHelperEvent` reducer folds events into a `HelperState` `{ helperId, helperType, query, status, parts, summary?, error? }`. The `parts` field is built by running each `chunk` body through `applyChunkToParts` from `agents/chat` — the same primitive `useAgentChat` uses to rebuild the assistant's `UIMessage` from the chat-stream firehose.
- `<MessageParts>` walks the assistant message's parts as usual; for each tool part, it looks up `helperStateByToolCall[toolCallId]` and renders a `<HelperPanel>` inline. The panel renders the helper's accumulated parts the same way the assistant's main message renders — Streamdown for text and reasoning, a small inline `Surface` for tool calls.

## Durability and reconnect

Both the chat stream and helper events are durable across page refresh:

- The chat stream is Think's existing `ResumableStream`, unchanged.
- Helper chunks are stored on **the helper's own DO**, in **Think's own `_resumableStream`** on the helper. There's no second stream on the helper, no shared tables — single-channel-per-DO, isolated by SQLite scope. On parent reconnect the parent re-fetches the helper's stored chunks and forwards them to the connecting client wrapped in synthesized lifecycle events.

The cost of putting events on the helper's DO instead of the parent's: one extra roundtrip during reconnect to read each helper's chunks. The benefits: state containment (helper events are about the helper's work, not the chat's); zero new framework primitives needed (single-channel `ResumableStream` is sufficient because each DO has its own SQLite by isolation); and **drill-in for free** — a curious developer can open a normal `useAgentChat` against `useAgent({ sub: [{ agent: "Researcher", name: helperId }] })` to see the helper's full conversation in its own UI.

## What's deliberately out of scope (and why)

| Limitation                                                                          | Tracked in `wip/inline-sub-agent-events.md`               |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| No TTL/GC yet beyond Clear; completed helper facets are retained                    | Ring 5 (retention / lifetime)                             |
| Helper-as-tool wrapping is hand-rolled, not `helperTool(Cls)`                       | Stage 4 step 3                                            |
| Cancellation only half-wired (parent abort doesn't propagate to helper inference)   | Ring 5 (cancellation propagation)                         |
| Drill-in detail view exists structurally but isn't wired in the UI                  | Next-steps item 3 in the wip doc                          |
| Parent crash mid-helper marks the run interrupted; live work is not resumed         | Ring 5 (live tail subscription)                           |
| Only Think-based parent. AIChatAgent port deferred                                  | Stage 5 in the wip doc                                    |

**Parallel helpers in one turn**: should work — each call gets a fresh `helperId`, its own facet, its own Think `_resumableStream`, its own `parentToolCallId`. The client's `(parentToolCallId, sequence)` dedup key is unique per helper run. Multiple helpers under one assistant message render as multiple panels under multiple tool parts. Not yet stress-tested though, so officially still out of scope. Next-steps item 2 in the wip doc.

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
- **`helper-stream.test.ts`** — drives a real Think turn through the mock model. Asserts NDJSON byte-stream contract, monotonic sequence from 0, that the mock's `text-delta` arrives as a `UIMessageChunk` body, that every emitted chunk is durably stored, and that `getFinalAssistantText` returns the mock's response.
- **`reconnect-replay.test.ts`** — every branch of `onConnect` replay: empty registry, completed run (started + chunks + finished using row's summary), running run (no terminal), error run with stored `error_message`, error run with default message, interrupted run with stored chunks, interrupted run with no chunks, multiple runs in `started_at` order with per-run sequence numbering preserved.

Run with `npm test`.

## How to read this code in order

If you want the design clean:

1. `src/protocol.ts` first. Four event kinds, one wire frame, one demo constant. The `chunk` body is opaque so the protocol stays AI-SDK-version-agnostic.
2. Then `src/server.ts`, top-down: `Researcher` (extends Think; override `broadcast` tees chunks; `runTurnAndStream` drives `saveMessages` and writes NDJSON chat-frame bodies to a `ReadableStream` over RPC; `getChatChunksForReplay` exposes Think's stored chunks for replay), then `Assistant.runResearchHelper` (parent decodes the byte stream, broadcasts each chunk wrapped in a `helper-event` envelope, synthesizes lifecycle events around it), then `Assistant.onConnect` (per-row replay synthesis).
3. Then `src/client.tsx`, starting from `applyHelperEvent`. Each helper accumulates parts via `applyChunkToParts`; the rendered panel is the same shape `useAgentChat` produces for the assistant's own message.
4. Then `wip/inline-sub-agent-events.md` for the design context this is grounding, especially the "Decisions confirmed 2026-04-28" section that explains why helpers are Think DOs (Option B) rather than `Agent`-with-scripted-events (the v0.1 prototype).

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
