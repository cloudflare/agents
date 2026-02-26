---
"@cloudflare/ai-chat": patch
---

Fix `useChat` `status` staying `"ready"` during stream resumption after page refresh.

Four issues prevented stream resumption from working:

1. **addEventListener race:** `onAgentMessage` always handled `CF_AGENT_STREAM_RESUMING` before the transport's listener, bypassing the AI SDK pipeline.

2. **Transport instance instability:** `useMemo` created new transport instances across renders and Strict Mode cycles. When `_pk` changed (async queries, socket recreation), the resolver was stranded on the old transport while `onAgentMessage` called `handleStreamResuming` on the new one.

3. **Chat recreation on `_pk` change:** Using `agent._pk` as the `useChat` `id` caused the AI SDK to recreate the Chat when the socket changed, abandoning the in-flight `makeRequest` (including resume). The resume effect wouldn't re-fire on the new Chat.

4. **Double STREAM_RESUMING:** The server sends `STREAM_RESUMING` from both `onConnect` and the `RESUME_REQUEST` handler, causing duplicate ACKs and double replay without deduplication.

Fixes:

- Replace `addEventListener`-based detection with `handleStreamResuming()` — a synchronous method `onAgentMessage` calls directly, eliminating the race.
- Make the transport a true singleton (`useRef`, created once). Update `transport.agent` every render so sends/listeners always use the latest socket. The resolver survives `_pk` changes because the transport instance never changes.
- Use a stable Chat ID (`initialMessagesCacheKey` based on URL + agent + name) instead of `agent._pk`, preventing Chat recreation on socket changes.
- Add `localRequestIdsRef` guard to skip duplicate `STREAM_RESUMING` messages for streams already handled by the transport.
