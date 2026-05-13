# @cloudflare/voice

## 0.2.0

### Minor Changes

- [#1478](https://github.com/cloudflare/agents/pull/1478) [`2c7d91b`](https://github.com/cloudflare/agents/commit/2c7d91b7dd2aed73b1871f72b79e6e59b89e2ce8) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Add an `enabled` option to `useVoiceAgent` so React apps can delay creating and connecting a `VoiceClient` until async prerequisites such as capability tokens are ready.

### Patch Changes

- [#1458](https://github.com/cloudflare/agents/pull/1458) [`84cb429`](https://github.com/cloudflare/agents/commit/84cb429f7f41becc5e6ff0592f0308c52a5134f1) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix Workers AI STT session edge cases for Flux and Nova 3.

  Flux now preserves the latest non-empty turn transcript from turn lifecycle events so an `EndOfTurn` event with an empty `transcript` can still emit the completed utterance. Flux `StartOfTurn` also drives server-side barge-in so model-detected user speech aborts active LLM/TTS playback promptly. Nova 3 now defensively normalizes finalized segment state before reading it to avoid stale teardown messages throwing during abnormal close paths.

- [#1462](https://github.com/cloudflare/agents/pull/1462) [`5f6214d`](https://github.com/cloudflare/agents/commit/5f6214dccfe3ba9bf243ec15d291b37b9659a54c) Thanks [@whoiskatrin](https://github.com/whoiskatrin)! - Fix `withVoice` text streaming for AI SDK `textStream` responses so TTS audio is produced when `onTurn()` returns `streamText(...).textStream` directly.

## 0.1.3

### Patch Changes

- [`ca510d4`](https://github.com/cloudflare/agents/commit/ca510d4fecbecb07d0d3cdad7d78c32cc226275e) Thanks [@threepointone](https://github.com/threepointone)! - Tighten the `agents` peer dependency floor from `>=0.9.0` to `>=0.11.7` to reflect the current monorepo set we actually test against. Upper bound (`<1.0.0`) is unchanged.

  No runtime change in `@cloudflare/voice` itself. The visible effect for consumers: pairing the latest `@cloudflare/voice` with a stale `agents` (`<0.11.7`) now produces a peer warning where it previously did not. That's the intended signal — `agents` versions older than 0.11.7 are no longer tested against this `@cloudflare/voice`.

## 0.1.2

### Patch Changes

- [#1313](https://github.com/cloudflare/agents/pull/1313) [`08da191`](https://github.com/cloudflare/agents/commit/08da191ab66d2df5de7337a295d5f6a081473ff9) Thanks [@threepointone](https://github.com/threepointone)! - Publish with correct peer dependency ranges for `agents` (wide ranges were being overwritten to tight `^0.x.y` by the pre-publish script)

## 0.1.1

### Patch Changes

- [#1310](https://github.com/cloudflare/agents/pull/1310) [`bd0346e`](https://github.com/cloudflare/agents/commit/bd0346ec05406e258b3c8904874c7a8c0f4608e5) Thanks [@threepointone](https://github.com/threepointone)! - Fix peer dependency ranges for `agents` — published packages incorrectly had tight `^0.10.x` ranges instead of the intended `>=0.8.7 <1.0.0` / `>=0.9.0 <1.0.0`, causing install warnings with `agents@0.11.0`. Also changed `updateInternalDependencies` from `"patch"` to `"minor"` in changesets config to prevent the ranges from being overwritten on future releases.

## 0.1.0

### Minor Changes

- [#1293](https://github.com/cloudflare/agents/pull/1293) [`16769b0`](https://github.com/cloudflare/agents/commit/16769b0bbf92ee6dab0293957b2a9b7d340e567a) Thanks [@threepointone](https://github.com/threepointone)! - Switch to per-call continuous STT sessions. Breaking API change.

  The transcriber session is now created at `start_call` and lives for the entire call duration. The model handles turn detection — no client-side `start_of_speech`/`end_of_speech` required for STT. Voice agents use `keepAlive` to prevent DO eviction during calls.

  New API:
  - `transcriber` property replaces `stt`, `streamingStt`, and `vad`
  - `createTranscriber(connection)` hook for runtime model switching
  - `WorkersAIFluxSTT` — per-call Flux sessions (recommended for `withVoice`)
  - `WorkersAINova3STT` — per-call Nova 3 streaming sessions (recommended for `withVoiceInput`)
  - `query` option on `VoiceClientOptions` — pass query params to the WebSocket URL (e.g. for model selection)
  - Throws at `start_call` if no transcriber is configured
  - Duplicate `start_call` is silently ignored when already in a call

  Removed:
  - `stt` (batch STT), `streamingStt` (per-utterance streaming), `vad` (server-side VAD)
  - `WorkersAISTT`, `WorkersAIVAD`, `pcmToWav`
  - `prerollMs`, `vadThreshold`, `vadPushbackSeconds`, `vadRetryMs`, `minAudioBytes` options
  - `VoiceInputAgentOptions` type
  - `beforeTranscribe` hook (audio is fed continuously, not in batches)
  - `vad_ms` and `stt_ms` from pipeline metrics
  - Hibernation support (`withVoice` and `withVoiceInput` now require `Agent`, not partyserver `Server`)

## 0.0.5

### Patch Changes

- [`c5ca556`](https://github.com/cloudflare/agents/commit/c5ca55618bd79042f566e55d1ebbe0636f91e75a) Thanks [@threepointone](https://github.com/threepointone)! - Replace wildcard `*` peer dependencies with real version ranges: `agents` to `>=0.9.0 <1.0.0` and `partysocket` to `^1.0.0`.

## 0.0.4

### Patch Changes

- [#1198](https://github.com/cloudflare/agents/pull/1198) [`dde826e`](https://github.com/cloudflare/agents/commit/dde826ec78f1714d9156d964d720507e3a139d8e) Thanks [@threepointone](https://github.com/threepointone)! - Fix TypeScript 6 declaration emit for `withVoice` and `withVoiceInput` mixin functions. TS6 enforces TS4094 which disallows `#private` members in exported anonymous class types. Added explicit return type interfaces (`VoiceAgentMixinMembers`, `VoiceInputMixinMembers`) so the generated `.d.ts` only exposes the public API surface.

## 0.0.3

### Patch Changes

- [`8fd45cf`](https://github.com/cloudflare/agents/commit/8fd45cf81aaa7eee2b97eb6c4fc2b0b3ce7b8ffd) Thanks [@threepointone](https://github.com/threepointone)! - Initial publish (again)

## 0.0.2

### Patch Changes

- [`d384339`](https://github.com/cloudflare/agents/commit/d384339817cb724fd74dcfacf8194684ecefb81b) Thanks [@threepointone](https://github.com/threepointone)! - Initial publish
