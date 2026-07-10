---
"agents": minor
"@cloudflare/ai-chat": minor
"@cloudflare/codemode": minor
"@cloudflare/think": minor
---

Update the published packages to support AI SDK v7.

This release moves the package peer ranges from `ai@6` and `@ai-sdk/*@3` to
`ai@7` and `@ai-sdk/*@4`. Consumers need to update their AI SDK dependencies
when upgrading these packages.

Only the current implementations were migrated. New optimisations and APIs made
available by AI SDK v7, such as broader result-shape audits or stream helper
migrations, are intentionally out of scope for this release.

Top-level API notes:

- `@cloudflare/think` keeps the existing `system`, `onStepFinish`, and
  `experimental_telemetry` names where callers already use them, while
  translating to AI SDK v7 options internally.
- `@cloudflare/think` now also accepts `TurnConfig.telemetry` and forwards it
  ahead of `experimental_telemetry` when present.
- `@cloudflare/think` adapts AI SDK v7 `onToolExecutionEnd` events back into
  the existing `ToolCallResultContext` shape. `stepNumber` is now `undefined`
  for tool completion callbacks because AI SDK v7 no longer provides that value
  on the tool execution end event.
- `@cloudflare/ai-chat` updates the `AIChatAgent.onChatMessage` callback type
  from `StreamTextOnFinishCallback` to `GenerateTextOnFinishCallback`.
