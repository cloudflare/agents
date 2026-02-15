# Voice Agents — Design (Experimental)

> **Status: experimental.** The voice API is under `agents/experimental/voice` and will break between releases. See `docs/voice.md` for user-facing docs.

How the voice pipeline works and why it is built this way.

## Architecture

A single WebSocket carries audio frames (binary), JSON status messages, transcript updates, and pipeline metrics. No SFU, no meeting infrastructure.

```
Browser / Client                        VoiceAgent (Durable Object)
┌──────────┐   binary PCM (16kHz)       ┌──────────────────────────────┐
│ Mic      │ ─────────────────────────► │ Audio buffer (per connection)│
│          │                            │   ↓                          │
│          │   JSON: end_of_speech      │ VAD: smart-turn-v2           │
│          │ ─────────────────────────► │   ↓                          │
│          │                            │ STT: deepgram nova-3         │
│          │   JSON: transcript         │   ↓                          │
│          │ ◄───────────────────────── │ onTurn() — user LLM logic    │
│          │   binary: audio            │   ↓ (sentence chunking)      │
│ Speaker  │ ◄───────────────────────── │ TTS: deepgram aura-1         │
└──────────┘                            └──────────────────────────────┘
```

One WebSocket per client. The same connection handles voice, state sync, RPC, and text chat.

### Why WebSocket-native (no SFU)

A voice agent is a 1:1 conversation. The browser has `getUserMedia()` for the mic and Web Audio API for playback. Audio flows as binary WebSocket frames over the connection the Agent already has via partyserver.

What you give up without the SFU:

- Multi-participant (does not apply to 1:1)
- WebRTC-grade network resilience (TCP head-of-line blocking on bad networks)
- Tightly coupled echo cancellation (browser AEC via `getUserMedia` constraints still works)

These are all secondary concerns, not the core story. SFU integration is documented as an advanced option in `docs/voice.md`.

## Pipeline stages

1. **Audio buffering** — binary frames accumulate per-connection in memory. Capped at 30 seconds (`MAX_AUDIO_BUFFER_BYTES = 960KB`) to prevent unbounded growth.

2. **Client-side silence detection** — AudioWorklet monitors RMS. 500ms of silence triggers `end_of_speech`. Configurable via `silenceThreshold` and `silenceDurationMs`.

3. **Server-side VAD** — `@cf/pipecat-ai/smart-turn-v2` confirms end-of-turn. Only runs on silence events, not every frame ($0.00034/audio-min). If VAD says "not done," the last N seconds of audio (VAD window, default 2s) are pushed back to the buffer.

4. **STT** — `@cf/deepgram/nova-3` transcribes. Audio is wrapped in WAV header for the Workers AI API.

5. **onTurn()** — user's LLM logic. Receives transcript, conversation history, and abort signal.

6. **Streaming TTS** — token stream from onTurn → `SentenceChunker` → per-sentence TTS. Sentences are synthesized eagerly (concurrently) using `eagerAsyncIterable` to overlap synthesis of sentence N+1 with delivery of sentence N. When `synthesizeStream()` is overridden, individual TTS chunks are sent as they arrive from the provider.

7. **Interruption** — client detects sustained speech above threshold during playback → stops playback → sends `interrupt` → server aborts active pipeline via AbortController.

## Key decisions

### Class extension over composition

`VoiceAgent extends Agent` follows the existing `AIChatAgent` pattern. Considered a `voicePipeline()` composition approach but method overrides are simpler, more TypeScript-native, and consistent with the rest of the codebase.

### `onTurn` return type: `string | AsyncIterable<string>`

Simple responses return a string (one TTS call). Streaming responses return an async iterable (sentence-chunked TTS). The SDK detects the type at runtime — no configuration flag.

### Streaming TTS: eager async iterables

The TTS queue uses `eagerAsyncIterable()` to start TTS calls immediately when enqueued (preserving concurrent synthesis), while allowing the drain loop to iterate chunks on its own schedule. This works for both non-streaming TTS (one chunk per sentence) and streaming TTS (multiple chunks per sentence).

### Audio buffer limits

Without limits, a misbehaving client can accumulate unbounded audio data in the DO's memory. The buffer is capped at 30 seconds (960KB at 16kHz mono 16-bit). Oldest chunks are dropped. The VAD pushback is similarly capped to the VAD window (default 2 seconds) — the full concatenated buffer is no longer pushed back.

### `ttsMs` metric

Previously `ttsMs` was `lastTtsDoneAt - llmStart` which included LLM time. Now it is the cumulative wall time of actual TTS synthesis calls.

## Hibernation

**Status: known issues, mitigated but not fully solved.**

Hibernation is ON by default in the `Agent` base class. The DO evicts from memory when no JS is executing, but WebSocket connections and SQLite survive.

### What survives

- WebSocket connections (platform-managed)
- SQLite data (`cf_voice_messages`)
- Scheduled alarms

### What is lost

- `#audioBuffers` — accumulated PCM chunks
- `#activePipeline` — AbortControllers for in-flight pipelines
- `#keepaliveTimers` — but these are just a mitigation, not state

### Mitigation: keepalive timers

When a call starts, VoiceAgent starts a 5-second `setInterval` to keep JS executing. This prevents hibernation during active calls. The timer is cleared on `end_call`, `onClose`, or disconnect.

### Remaining issues

These are documented but not yet fixed:

1. **`onConnect` sends wrong status on wake.** After hibernation, `onConnect` sends `{ type: "status", status: "idle" }`. If the user was mid-call, this incorrectly tells the client the call ended. Fix: track call state in SQLite or per-connection state and restore on reconnect.

2. **PartySocket reconnect does not restore call state.** If the connection drops and reconnects, the client does not re-send `start_call`. The user must manually restart. Fix: client-side reconnect logic that detects the dropped call and re-initiates.

3. **Audio buffer loss in edge cases.** If the DO somehow evicts during a call despite the keepalive (e.g., unhandled exception kills the isolate), audio buffers are lost. The pipeline already handles short/empty buffers gracefully.

**Recommendation for production voice agents: set `static options = { hibernate: false }` on the VoiceAgent subclass.** This keeps the DO alive as long as it has connections, at the cost of billable duration. The `examples/voice-agent` example does this. A future fix should make hibernation work correctly with voice calls (see issues above).

## Telephony (Twilio adapter)

The `@cloudflare/agents-voice-twilio` adapter bridges Twilio Media Streams to VoiceAgent. Architecture:

```
Phone → Twilio → WebSocket → TwilioAdapter → WebSocket → VoiceAgent DO
```

### Inbound audio

Twilio sends mulaw 8kHz base64 JSON. The adapter decodes: base64 → mulaw → PCM 8kHz → resample to 16kHz → binary WebSocket frame.

### Outbound audio

VoiceAgent sends binary audio (expected: 16kHz 16-bit mono PCM). The adapter converts: PCM 16kHz → resample to 8kHz → encode mulaw → base64 → Twilio media JSON.

**Important limitation:** The default Workers AI TTS returns MP3, which cannot be decoded to PCM in the Workers runtime (no AudioContext). When using the Twilio adapter, the VoiceAgent MUST use a TTS provider that outputs raw PCM. Options:

- ElevenLabs with `outputFormat: "pcm_16000"`
- A custom `synthesize()` override that returns 16kHz 16-bit mono PCM

## Single-speaker enforcement

The `beforeCallStart(connection)` hook lets subclasses reject calls (return `false`). The voice-agent example uses this to enforce single-speaker: only one connection can be the active speaker at a time. Other connections can still observe transcripts and send text.

The kick mechanism is handled at the application level (not in the SDK): the server's `onMessage` intercepts `{ type: "kick_speaker" }` and forces the active speaker's call to end.

## Provider ecosystem

Provider interfaces:

- `STTProvider` — `transcribe(audio: ArrayBuffer): Promise<string>`
- `TTSProvider` — `synthesize(text: string): Promise<ArrayBuffer | null>`
- `StreamingTTSProvider` — `synthesizeStream(text: string): AsyncIterable<ArrayBuffer>`
- `VADProvider` — `checkEndOfTurn(audio: ArrayBuffer): Promise<VADResult>`

Override the corresponding method on VoiceAgent and delegate to a provider instance. See `@cloudflare/agents-voice-elevenlabs` for the reference implementation.

## Pipeline hooks

Four interception points between pipeline stages:

| Hook                                       | Receives          | Can skip by returning |
| ------------------------------------------ | ----------------- | --------------------- |
| `beforeTranscribe(audio, connection)`      | Raw PCM after VAD | `null`                |
| `afterTranscribe(transcript, connection)`  | STT text          | `null`                |
| `beforeSynthesize(text, connection)`       | Text before TTS   | `null`                |
| `afterSynthesize(audio, text, connection)` | Audio after TTS   | `null`                |

Hooks run in both streaming and non-streaming paths, and in `speak()`/`speakAll()`.

## History

- Initial implementation in `examples/voice-agent` (Layer 0)
- Client-side audio utilities extracted to `agents/voice-client` and `agents/voice-react` (Layer 1)
- Server-side pipeline extracted to `agents/voice` as `VoiceAgent` class (Layer 2)
- Pipeline hooks, streaming TTS, ElevenLabs provider, Twilio adapter (Layer 3/4)
