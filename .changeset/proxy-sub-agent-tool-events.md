---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Fix sub-agent tool events getting stuck at `input-available` when an agent-tool child proxies a remote `toUIMessageStreamResponse()` (#1589).

`tailAgentToolRun` (in both `AIChatAgent` and `Think`) drained the stored chunk backlog and only afterwards attached its live forwarder, with `await` boundaries in between. Any chunk the child stored and broadcast in that window was neither in the drained snapshot nor live-forwarded, so it silently vanished from the parent's stream — leaving tool parts (notably `tool-output-available`) stuck at `input-available` in `useAgentToolEvents`. A network-paced proxied remote stream hits this window constantly, while a fast local child mostly avoids it. The forwarder is now registered before the backlog is drained, with live chunks buffered and replayed in order and deduped by sequence, closing the gap.

Both `AIChatAgent` and `Think` also realign the in-memory live sequence to the stored high-water mark after draining. Without this, a re-attach after the child's Durable Object restarts or wakes from hibernation (where the live counter is cold but the durable backlog sits at N) would hand the recovered turn's new chunks sequences from 0, which the high-water dedupe silently drops — leaving the parent permanently stuck with no post-restart chunks.
