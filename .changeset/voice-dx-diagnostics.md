---
"@cloudflare/voice": minor
"@cloudflare/voice-assemblyai": minor
"@cloudflare/voice-elevenlabs": minor
"@cloudflare/voice-deepgram": minor
"@cloudflare/voice-telnyx": minor
"@cloudflare/voice-plivo": patch
"@cloudflare/voice-twilio": patch
---

Improve voice lifecycle accuracy, diagnostics, and per-turn timing visibility.

- Clear stale interim transcripts when calls start, end, disconnect, close, or fail during startup.
- Emit `speaking` only when the first server audio chunk is sent.
- Add structured, content-free browser diagnostics and structured Worker error logging without reading arbitrary provider response bodies.
- Report transcriber startup and runtime failures through `onFatalError`, structured client errors, and reliable call cleanup.
- Preserve model finish reasons and distinguish no-output, output-limit, content-filtered, and model-error completions.
- Add stable typed per-turn timing summaries for speech, text, terminal outcomes, model streaming, reasoning exposed by the model stream, and overlapping TTS work through `VoiceClient` and the React hooks.
- Keep the existing four-field metrics wire shape compatible while making no-audio and streamed TTS accounting consistent.
- Update the bundled voice providers to propagate lifecycle failures and log errors consistently.
