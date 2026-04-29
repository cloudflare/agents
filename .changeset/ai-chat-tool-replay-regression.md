---
"@cloudflare/ai-chat": patch
---

Stop provider tool-call replays from regressing tool part state during continuation streams ([#1404](https://github.com/cloudflare/agents/issues/1404)).

Some providers (notably the OpenAI Responses API) re-emit prior tool calls in continuation streams as a `tool-input-start` → `tool-input-delta` → `tool-input-available` → `tool-output-available` sequence carrying the _same_ `toolCallId` and the _same_ `output` the part already holds. The AI SDK's `updateToolPart` mutates an existing tool part in place when the toolCallId matches, so a replayed `tool-input-start` was clobbering an `output-available` part back to `input-streaming` on the client and producing the worker warn `_applyToolResult: Tool part with toolCallId X not in expected state`.

Two fixes:

- `_streamSSEReply` now drops replay tool-input chunks before broadcasting them to clients or storing them for resume, using the new shared `isReplayChunk` helper. The cloned server-side streaming message is never corrupted because `applyChunkToParts` is idempotent against existing toolCallIds for these chunk types (also fixed below).
- `_applyToolResult` accepts `output-available` and `output-error` as valid starting states for _idempotent_ re-application. A duplicate `cf_agent_tool_result` (cross-tab re-run, redelivered WS frame, provider replay round-trip) is now a silent no-op rather than a warn + skipped update. The cross-message `tool-output-available`/`tool-output-error` fallback in `_streamSSEReply` gets the same tolerance.

`_findAndUpdateToolPart` skips the SQLite write and `MESSAGE_UPDATED` broadcast when the apply produced no semantic change, so idempotent re-applies don't churn UI on connected tabs.
