# @cloudflare/voice

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
