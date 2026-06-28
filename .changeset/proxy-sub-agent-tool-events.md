---
"@cloudflare/ai-chat": patch
"@cloudflare/think": patch
---

Fix sub-agent tool events getting stuck at `input-available` when an agent-tool child proxies a remote `toUIMessageStreamResponse()` (#1589).

`tailAgentToolRun` (in both `AIChatAgent` and `Think`) drained the stored chunk backlog and only afterwards attached its live forwarder, with `await` boundaries in between. Any chunk the child stored and broadcast in that window was neither in the drained snapshot nor live-forwarded, so it silently vanished from the parent's stream — leaving tool parts (notably `tool-output-available`) stuck at `input-available` in `useAgentToolEvents`. A network-paced proxied remote stream hits this window constantly, while a fast local child mostly avoids it. The forwarder is now registered before the backlog is drained, with live chunks buffered and replayed in order and deduped by sequence (Think also realigns its live sequence to the true high-water mark so a post-restart re-attach can't collide), closing the gap.
