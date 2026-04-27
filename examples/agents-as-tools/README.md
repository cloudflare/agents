# Agents as Tools

A focused minimal proof of the **agents-as-tools** pattern: during a single chat turn, the assistant dispatches a helper sub-agent to do multi-step work, and the helper's lifecycle events stream live into the chat UI as the turn unfolds.

This is the v0 prototype for the design captured in
[`wip/inline-sub-agent-events.md`](../../wip/inline-sub-agent-events.md). It exists to drive that design empirically before the framework freezes any helper-protocol API.

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

The assistant calls the `research` tool. A live progress panel renders inline under the tool call as the helper steps through "planning → searching aspect 1 → searching aspect 2 → … → synthesizing." When the helper finishes, the assistant's reply summarizes the result.

Plain chat works too — the helper only spawns when the model picks the `research` tool.

## What it demonstrates

```
Browser ──ws──▶ Assistant DO ──┬──▶ chat stream (UIMessage parts)
                                │
                                └──▶ side-channel `helper-event` frames
                                          │
                                          │ broadcast on the same ws,
                                          │ tagged with parentToolCallId
                                          ▼
                                Researcher facet (per-turn lifetime)
```

Three things, none of which the framework currently provides as a shipped primitive:

1. **A chat agent dispatching another agent inside a tool execute**, with the helper sub-agent treated as a turn-scoped worker (per-helper-run facet, deleted in `finally`). Built on the existing `subAgent` / `parentAgent` routing primitive.
2. **A typed helper-event protocol** — six event kinds (`started`, `step`, `tool-call`, `tool-result`, `finished`, `error`) — that the helper emits as it works. The vocabulary is deliberately small. Helping decide whether this is the right shape — vs. reusing AI SDK `UIMessagePart` — is part of the point of this example.
3. **Inline rendering on the client** — helper events are joined to the chat tool-call by `toolCallId` and render as a collapsible timeline panel under the matching tool part. The helper's progress is visible in the same place the user is already looking, not in a separate pane.

## Wire protocol (`src/protocol.ts`, ~65 lines)

A thin module with **no Worker-runtime imports** — types and the `DEMO_USER` constant only. Both `server.ts` and `client.tsx` import from it; the front-end bundle never transitively pulls in `agents`, `@cloudflare/think`, or `workers-ai-provider` through a stray value import.

Add anything else that needs to be shared between server and client (e.g. RPC argument shapes, message-type discriminators) here, not to `server.ts`.

## Server (`src/server.ts`, ~410 lines)

- **`Assistant extends Think`** — top-level chat agent. `getModel`, `getSystemPrompt`, `getTools` are the standard Think hooks. `getTools()` returns one tool, `research`, that wraps the helper.
  - `onStart` creates a tiny `active_helpers` table that tracks in-flight helpers for reconnect-replay.
  - `runResearchHelper` is the proto-shape of an eventual `helperTool(Cls)` framework helper: spawn → open a byte stream over RPC → decode NDJSON frames → broadcast each event with a `sequence` for client-side dedup → delete the helper in `finally`. Hand-rolled here so we can iterate on the protocol before freezing an API.
  - `onConnect` runs after Think's chat-protocol setup. It walks `active_helpers`, fetches each helper's stored events via DO RPC, and forwards them as `replay: true` frames so the connecting client sees the full timeline of any helper currently running.

- **`Researcher extends Agent`** — helper sub-agent. Owns its own `ResumableStream` configured with `messageType: "helper-event"` so its replay frames don't collide with the chat protocol.
  - `startAndStream(query, helperId)` returns a `ReadableStream<Uint8Array>` over DO RPC. Each chunk is one or more NDJSON frames (`{ sequence, body }`), because workerd's DO RPC stream bridge only transports `Uint8Array` chunks. The parent decodes the bytes, splits on newlines, and forwards each frame to clients. Each emitted event is durably stored in the helper's `ResumableStream` _before_ being written to the stream, so reconnect replay catches up cleanly.
  - `getActiveStreamId` and `getStoredEvents` are the RPC surface the parent calls on reconnect to fetch the helper's stored timeline.

  The simulated research workflow inside `startAndStream`:
  1. Plans 3 aspects (deterministic in v0.1, no LLM call).
  2. Emits a `step` event per aspect, then a `tool-call`/`tool-result` pair to simulate fan-out to a search tool. Realistic-feeling latency between events.
  3. Calls Workers AI to synthesize a final summary — the one real LLM call inside the helper.
  4. Emits `finished` with the summary as the tool's eventual output.

## Client (`src/client.tsx`, ~620 lines)

- One connection: `useAgent({ agent: "Assistant", name: "demo" })` driving `useAgentChat({ agent })` for the chat itself.
- **A separate `addEventListener("message")` on the same socket** sieves out `helper-event` frames. Each frame carries a `sequence` (the helper-local 0-based index of the event); the client dedupes by `(parentToolCallId, sequence)` and sorted-inserts frames so the timeline renders in helper-emit order even if replay and live frames arrive out of order.
- The `<MessageParts>` renderer walks the assistant message's parts as usual; for each tool part, it looks up `helperEventsByToolCall[toolCallId]` and renders a `<HelperEvents>` panel inline if any events exist. The panel is the visual money shot: a live timeline that grows as the helper works, with status badges (`Running` → `Done`).

The structure of the `<HelperEvents>` component is intentionally close to the shape an eventual AI SDK `UIMessagePart` of type `helper` would render — keeping the JSX in one place makes the v1 lift easier.

## Durability and reconnect

Both the chat stream and helper events are durable across page refresh:

- The chat stream is Think's existing `ResumableStream`, unchanged.
- Helper events are stored on **the helper's own DO**, in its own `ResumableStream` (one helper, one stream — no shared tables, no multi-channel logic, just one DO per helper). On parent reconnect the parent re-fetches the helper's stored events and forwards them to the connecting client.

The cost of putting events on the helper's DO instead of the parent's: one extra roundtrip during reconnect to read each in-flight helper's events. The benefit: state containment (helper events are about the helper's work, not the chat's), zero new framework primitives needed (single-channel `ResumableStream` is sufficient because each DO has its own SQLite by isolation), and **drill-in for free** — a curious developer can open a second `useAgent({ sub: [Researcher, helperId] })` to a specific helper for a detail view, since helpers _are_ real sub-agents.

## What's deliberately out of scope (and why)

| Limitation                                                                  | Tracked in `wip/inline-sub-agent-events.md` |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| Per-turn lifetime only. No persistent / resumable helpers                   | Ring 5 (lifetime: persistent)               |
| Helper-as-tool wrapping is hand-rolled, not `helperTool(Cls)`               | Stage 4 step 3                              |
| Cancellation only half-wired (parent abort doesn't propagate to helper LLM) | Ring 5 (cancellation propagation)           |
| Drill-in detail view exists structurally but isn't wired in the UI          | Ring 4 (drill-in)                           |
| Parent crash mid-helper: stored events are wiped on parent wake (sweep)     | Ring 5 (live tail subscription)             |
| Only Think-based. AIChatAgent port deferred                                 | Ring 6 (Think-first, framework-wide)        |
| No vitest harness                                                           | Stage 2 follow-up                           |

**Parallel helpers in one turn**: should work — each call gets a fresh `helperId`, its own facet, its own stream, its own `parentToolCallId`. The client's `(parentToolCallId, sequence)` dedup key is unique per helper run. Multiple helpers under one assistant message render as multiple panels under multiple tool parts. Not yet stress-tested though, so officially still v0.2.

**Parent-crash recovery**: `Assistant.onStart` sweeps any leftover `active_helpers` rows and calls `deleteSubAgent` for each on parent wake. After a crash, in-flight helpers' stored events are intentionally discarded — there's no live forwarding loop to resume them, and showing a "Running" panel that never resolves is worse UX than just losing the events. The chat-stream layer's existing recovery machinery handles the assistant message itself (the tool call shows up with whatever output Think persisted).

## Why Think (and how to port to AIChatAgent)

The design notes argue for Think-first because helpers want to live inside Think's fibers / sessions / turns model. This example doesn't yet exercise any of those, but it does extend `Think` for the parent so the Think-native ergonomics (`getModel`, `getSystemPrompt`, `getTools`) are in place when later stages need them.

The pieces that are deliberately portable to AIChatAgent:

- `Researcher extends Agent` — the helper class doesn't depend on Think.
- The helper-event protocol (`HelperEvent`, `HelperEventMessage`) doesn't reference Think types.
- The parent forwarding path is just `this.broadcast(...)` — both `AIChatAgent` and `Think` extend `Agent`, both have `broadcast`.
- `getTools` works on both.

Porting would mean:

1. `class Assistant extends AIChatAgent<Env>` instead of `Think<Env>`.
2. Override `onChatMessage` instead of `getModel`/`getSystemPrompt`/`getTools` — call `streamText` directly, pass the same `tools` shape.
3. Same `subAgent` / `deleteSubAgent` / `parentAgent` / `broadcast` calls everywhere else.

Roughly a 30-line diff. The helper class and the entire client are unchanged.

## How to read this code in order

If you want the design clean:

1. `src/protocol.ts` first. Six event kinds, one wire frame, one demo constant, one `sequence` field. Sets up everything else.
2. Then `src/server.ts`, top-down: `Researcher.startAndStream` (helper does work, durably stores each event, writes NDJSON bytes to a `ReadableStream` over RPC), then `Assistant.runResearchHelper` (parent decodes that stream and broadcasts), then `Assistant.onConnect` (replay path on reconnect).
3. Then `src/client.tsx`, starting from the `useEffect` that subscribes to `message` events on the agent socket — that's the join point between the chat stream and the helper side-channel. Note the `(parentToolCallId, sequence)` dedup and sorted insertion.
4. Then `wip/inline-sub-agent-events.md` for the design context this is grounding, especially the "Design pivot" section that explains why helpers are sub-agents rather than parent-side channels.

If you want to extend it:

- **Try a second helper class** (e.g. a `WorkspacePlanner` that takes a multi-file edit task and emits per-file progress). Watching what events feel right for a non-research helper is the most direct way to validate or break the v0 vocabulary.
- **Try parallel helpers in one turn**. Add a second tool that fans out, or have the LLM call `research` twice — the `helperId` and `sequence` plumbing already supports per-helper demux on the client; the rendering may need a small tweak.
- **Refresh the page mid-helper.** Both the chat stream and the helper timeline catch up cleanly. Compare with v0, where helper events disappeared on refresh — that's the difference state-on-helper-DO buys you.
- **Drill into a helper.** The routing primitive supports `useAgent({ agent: "Assistant", name: "demo", sub: [{ agent: "Researcher", name: "<helperId>" }] })` to open a direct WebSocket to the helper; this isn't wired in the example UI, but it's a free capability.

## Related

- [`wip/inline-sub-agent-events.md`](../../wip/inline-sub-agent-events.md) — the full design context this example is grounding. Six rings of design surface, five staged implementation steps.
- [`docs/sub-agents.md`](../../docs/sub-agents.md) — the routing primitive (`subAgent`, `parentAgent`, `useAgent({ sub })`) this example builds on.
- [`examples/multi-ai-chat`](../multi-ai-chat) — the other "minimal proof" example, for the routing primitive itself. Sibling-conversations pattern; siblings are addressable, this example's helpers are not.
- [`examples/assistant`](../assistant) — the kitchen-sink Think reference. This example's helper pattern will eventually be folded in there once the API stabilizes.
- [`examples/ai-chat`](../ai-chat) — the canonical AIChatAgent reference. After Stage 4, expect a one-line `helperTool(Cls)` demo to land there too.
- [`#1377`](https://github.com/cloudflare/agents/issues/1377) — the issue that surfaced the underlying primitive gap (multi-channel `ResumableStream`).
