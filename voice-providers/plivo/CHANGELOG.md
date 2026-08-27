# @cloudflare/voice-plivo

## 0.1.1

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

## 0.1.0

### Minor Changes

- [#2048](https://github.com/cloudflare/agents/pull/2048) [`3172a23`](https://github.com/cloudflare/agents/commit/3172a232d2c663db6bff126c7ca1ccddb5beb45d) Thanks [@cjol](https://github.com/cjol)! - Add Plivo audio streaming adapter for the Cloudflare Agents voice pipeline.

  `PlivoAdapter` bridges Plivo's bidirectional audio streaming WebSocket protocol to `VoiceAgent`, structured as a sibling to the Twilio provider. Audio is mulaw 8kHz on the Plivo side, decoded and resampled to 16kHz PCM for the agent. Includes barge-in support via Plivo's `clearAudio` event and a `setupPlivoApplication()` helper that configures the Plivo application and phone number through the REST API.
