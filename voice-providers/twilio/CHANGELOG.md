# @cloudflare/voice-twilio

## 0.0.3

### Patch Changes

- [#2157](https://github.com/cloudflare/agents/pull/2157) [`f08ee06`](https://github.com/cloudflare/agents/commit/f08ee06fd610756de0d8abf539dfe9b746bdd7c5) Thanks [@cjol](https://github.com/cjol)! - Improve voice lifecycle accuracy, diagnostics, and per-turn timing visibility.

  - Clear stale interim transcripts when calls start, end, disconnect, close, or fail during startup.
  - Emit `speaking` only when the first server audio chunk is sent.
  - Add structured, content-free browser diagnostics and structured Worker error logging without reading arbitrary provider response bodies.
  - Report transcriber startup and runtime failures through `onFatalError`, structured client errors, and reliable call cleanup.
  - Preserve model finish reasons and distinguish no-output, output-limit, content-filtered, and model-error completions.
  - Add stable typed per-turn timing summaries for speech, text, terminal outcomes, model streaming, reasoning exposed by the model stream, and overlapping TTS work through `VoiceClient` and the React hooks.
  - Keep the existing four-field metrics wire shape compatible while making no-audio and streamed TTS accounting consistent.
  - Update the bundled voice providers to propagate lifecycle failures and log errors consistently.

## 0.0.2

### Patch Changes

- [`9b5a790`](https://github.com/cloudflare/agents/commit/9b5a790a59718f73700368d95eba2cf7443be9c8) Thanks [@threepointone](https://github.com/threepointone)! - bump for release
