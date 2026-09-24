---
"@cloudflare/think": minor
---

Add `getGateway(model)` to set AI Gateway options for string models resolved by the default provider (#2262). Return a gateway `id`, `metadata` (recorded as `cf-aig-metadata`), or cache settings without replacing `resolveModel()`. It runs once per turn, so metadata can come from `activeTurn`, the messenger context, or agent state. The default, `undefined`, keeps the current routing.
