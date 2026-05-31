---
"agents": minor
"@cloudflare/think": minor
"@cloudflare/ai-chat": minor
---

Expose recovery incident identity and enrich the `onExhausted` payload so
products can build a terminal-state policy without re-deriving anything (#1631).

- `ChatRecoveryContext` (the `onChatRecovery` argument) now includes
  `recoveryRootRequestId` — the stable request ID for the whole continuation
  chain. Unlike `requestId`, it doesn't change across chained continuations, so
  it's the right key for per-incident budget tracking / fresh-incident detection
  without re-deriving identity from message IDs.
- `ChatRecoveryExhaustedContext` (the `onExhausted` argument) now carries
  `recoveryRootRequestId`, `terminalMessage` (the exact text shown to the user),
  `partialText` / `partialParts` (what the turn produced before it was given up
  on), and `streamId` / `createdAt` — enough to render or persist a user-facing
  terminal banner AND emit correlated terminal telemetry (e.g. time-since-turn-start,
  stream correlation) directly, without re-deriving anything.

All fields are additive. Applied across `agents` (shared types),
`@cloudflare/think`, and `@cloudflare/ai-chat`.
