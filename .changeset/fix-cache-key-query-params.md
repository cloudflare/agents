---
"@cloudflare/ai-chat": patch
---

Fix `useAgentChat` cache key including query params, which broke stream resume with cross-domain auth. Auth tokens (and other query params) change across page loads, causing cache misses that re-trigger Suspense and interrupt the stream resume handshake. The cache key now uses agent identity only (origin + pathname + agent + name), keeping it stable across token rotations.
