---
"agents": patch
---

Make `applyChunkToParts` idempotent against an existing tool part with the same `toolCallId`, and add `isReplayChunk(parts, chunk)` for stream broadcasters that want to drop provider replay chunks ([#1404](https://github.com/cloudflare/agents/issues/1404)).

Some providers (notably the OpenAI Responses API) re-emit a prior tool call in continuation streams. The previous `tool-input-start` handler unconditionally pushed a fresh tool part, which produced duplicate parts in the message; `tool-input-delta` and `tool-input-available` overwrote a fully resolved input/state if a chunk happened to arrive for an already-known toolCallId. The new behavior:

- `tool-input-start` for a `toolCallId` that already exists in `parts` is a no-op (it does not push a duplicate or regress state).
- `tool-input-delta` only mutates input while the existing part is still `input-streaming`.
- `tool-input-available` only advances from `input-streaming` to `input-available`; replays against parts that have already moved past `input-streaming` (including `approval-requested`/`approval-responded` and any terminal state) are no-ops.

`isReplayChunk(parts, chunk)` is exported from `agents/chat` for stream broadcasters (e.g. `AIChatAgent._streamSSEReply`) that want to detect "this chunk is a replay of an already-known tool call" and skip re-broadcasting it. AI SDK v6's `updateToolPart` on the client mutates an existing tool part in place when the toolCallId matches, so re-broadcasting these replay chunks would visibly regress an `output-available` part to `input-streaming` on connected clients. `tool-output-available` is _not_ treated as a replay because its in-place update is safe when the output already matches.

Tool calls that the model genuinely wants to re-issue always carry a new toolCallId, so an existing match is never a legitimate "start over".
