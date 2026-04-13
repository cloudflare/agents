---
"agents": patch
---

Fix `applyChunkToParts` dropping `providerMetadata` on `reasoning-end` and `reasoning-delta` chunks. For Anthropic models with extended/adaptive thinking, the thinking block signature arrives on `reasoning-end.providerMetadata.anthropic.signature`. Without persisting it, `convertToModelMessages` produces reasoning parts with no signature, causing `@ai-sdk/anthropic` to silently drop the thinking block on subsequent turns — effectively making extended thinking single-turn only. The reasoning handlers now merge `chunk.providerMetadata` onto the persisted part, matching the behavior of source and tool chunk handlers in the same file. Fixes #1299.
