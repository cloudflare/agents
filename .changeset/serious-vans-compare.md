---
"agents": minor
"@cloudflare/ai-chat": minor
"@cloudflare/codemode": minor
"@cloudflare/think": minor
---

Support both AI SDK v6 and v7.

The `ai` peer range is `ai@^6 || ^7` (and `@ai-sdk/react` is `@^3 || ^4`) across
`agents`, `@cloudflare/ai-chat`, `@cloudflare/codemode`, and `@cloudflare/think`.
Consumers can adopt AI SDK v7 or stay on v6 — no forced AI SDK upgrade when
bumping these packages.

Only the current implementations are covered. New optimisations and APIs made
available by AI SDK v7 (broader result-shape audits, stream helper migrations,
etc.) are intentionally out of scope.

How dual-version support works — `@cloudflare/think` calls the AI SDK through the
option names present in both majors (v7 keeps the v6 names as aliases), and
normalizes the genuine divergences at the boundary:

- Uses `stepCountIs`, `system`, `experimental_telemetry`, `onStepFinish`, and
  `experimental_onToolCallFinish` (in v7 this alias resolves to
  `onToolExecutionEnd` and fires once).
- The tool-execution-finished event is normalized across majors: v6's
  `{ success, output, error, durationMs, stepNumber }` and v7's
  `{ toolOutput, toolExecutionMs }` collapse to one `ToolCallResultContext`.
  `stepNumber` is `undefined` under v7 (the v7 event no longer provides it).
- The UI message stream is built via the result's `toUIMessageStream()` method
  (present in both majors); the standalone `toUIMessageStream({ stream })`
  helper and `result.stream` are v7-only.
- The workspace read tool emits `{ type: "file-data", data, mediaType, filename }`
  model output, accepted by both majors (v7's newer `{ type: "file", data: {
type: "data", data } }` shape does not exist in v6).

Public API notes:

- `@cloudflare/think` keeps `system`, `onStepFinish`, and `experimental_telemetry`
  where callers already use them, and also accepts `TurnConfig.telemetry`
  (forwarded ahead of `experimental_telemetry` when present).
- `@cloudflare/ai-chat` updates the `AIChatAgent.onChatMessage` callback type
  from `StreamTextOnFinishCallback` to `GenerateTextOnFinishCallback`.

Verified against both `ai@6` and `ai@7`: `@cloudflare/think` type-checks with
zero errors and its full workers test suite passes under each major.

Known limitations:

- `workers-ai-provider` (Think's default model provider) is a fixed dependency
  targeting one provider-spec generation. Consumers on `ai@6` who rely on
  Think's built-in default model may hit a provider-version mismatch; passing
  their own `LanguageModel` avoids this.
- `chat@4.31.0` currently declares an `ai@^6` peer and does not yet advertise
  v7 support; tracked separately.
- CI should exercise both an `ai@6` and an `ai@7` resolution to guard the matrix.
