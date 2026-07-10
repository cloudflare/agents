---
"@cloudflare/voice": patch
---

Honor the configured sample rate for raw `pcm16` audio payloads.

Adds a `sampleRate` option to `VoiceAgentOptions` (default `16000`) that is declared in the server `audio_config` message. `VoiceClient` reads it (exposed via a new `sampleRate` getter) and constructs `AudioBuffer` instances at that rate for raw `pcm16` playback, so providers with a native rate other than 16 kHz (e.g. 24 kHz Gemini TTS) play at the correct speed. Falls back to 16 kHz when the server omits the field.
