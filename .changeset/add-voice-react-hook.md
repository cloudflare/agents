---
"agents": minor
---

Add voice agent support: `agents/voice`, `agents/voice-client`, and `agents/voice-react`.

**`agents/voice`** — Server-side `VoiceAgent` base class. Extends `Agent` with a full voice pipeline: audio buffering, VAD (smart-turn-v2), STT (nova-3), streaming TTS (aura-1) with sentence-level chunking, interruption handling, conversation persistence (SQLite), and the WebSocket voice protocol. Users implement `onTurn()` with their LLM logic — everything else is handled. STT/TTS/VAD default to Workers AI models but can be overridden for custom providers. Includes pipeline hooks (`beforeTranscribe`, `afterTranscribe`, `beforeSynthesize`, `afterSynthesize`) for middleware between pipeline stages.

**`agents/voice-client`** — Framework-agnostic `VoiceClient` class for the browser. Encapsulates mic capture (AudioWorklet), PCM encoding, audio playback queue, silence detection, interruption detection, and the voice protocol. Uses PartySocket for the connection.

**`agents/voice-react`** — `useVoiceAgent` React hook, a thin wrapper around `VoiceClient` that syncs its state into React state.

Also exports `SentenceChunker` (from `agents/voice`) for standalone use.
