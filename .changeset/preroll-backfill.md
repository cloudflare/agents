---
"@cloudflare/voice": minor
---

Switch to per-call continuous STT sessions. Breaking API change.

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
