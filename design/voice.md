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
│          │   JSON: end_of_speech      │ this.vad (optional)          │
│          │ ─────────────────────────► │   ↓                          │
│          │                            │ this.stt                     │
│          │   JSON: transcript         │   ↓                          │
│          │ ◄───────────────────────── │ onTurn() — user LLM logic    │
│          │   binary: audio            │   ↓ (sentence chunking)      │
│ Speaker  │ ◄───────────────────────── │ this.tts                     │
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

3. **Server-side VAD** (optional) — confirms end-of-turn via `this.vad.checkEndOfTurn()`. Only runs on silence events, not every frame. If VAD says "not done," the last N seconds of audio (`vadPushbackSeconds`, default 2) are pushed back to the buffer. If no VAD provider is set, every `end_of_speech` is treated as confirmed.

4. **STT** — two modes:
   - **Batch** (default) — transcribes audio via `this.stt.transcribe()` after end-of-speech. The built-in `WorkersAISTT` wraps audio in a WAV header for the Workers AI API.
   - **Streaming** (opt-in) — if `this.streamingStt` is set, audio is fed to a per-utterance WebSocket session in real time via `session.feed()`. At end-of-speech, `session.finish()` flushes and returns the final transcript (~50ms). Interim transcripts are relayed to the client as `transcript_interim` messages. This eliminates STT latency from the critical path.

5. **onTurn()** — user's LLM logic. Receives transcript, conversation history, and abort signal.

6. **Streaming TTS** — token stream from onTurn → `SentenceChunker` → per-sentence TTS via `this.tts.synthesize()`. Sentences are synthesized eagerly (concurrently) using `eagerAsyncIterable` to overlap synthesis of sentence N+1 with delivery of sentence N. When the TTS provider implements `synthesizeStream()`, individual TTS chunks are sent as they arrive.

7. **Interruption** — client detects sustained speech above threshold during playback → stops playback → sends `interrupt` → server aborts active pipeline via AbortController.

## Key decisions

### Mixin pattern

`withVoice(Agent)` produces a class with the full voice pipeline mixed in. This follows the existing `AIChatAgent` pattern — simpler than composition, more TypeScript-native, and consistent with the rest of the codebase.

### Explicit providers

The mixin does not assume any particular AI binding or service. Subclasses set `stt` (or `streamingStt`), `tts`, and optionally `vad` as class properties:

```ts
class MyAgent extends VoiceAgent<Env> {
  stt = new WorkersAISTT(this.env.AI);
  tts = new ElevenLabsTTS({ apiKey: this.env.ELEVENLABS_KEY });
  vad = new WorkersAIVAD(this.env.AI);
  // Optional: streaming STT replaces batch stt when set
  streamingStt = new DeepgramStreamingSTT({ apiKey: this.env.DEEPGRAM_KEY });
}
```

Class field initializers run after `super()`, so `this.env` is available. The mixin calls `this.stt.transcribe()` etc. internally. If neither `stt` nor `streamingStt` is set, the mixin throws a clear error. If both are set, `streamingStt` takes precedence for audio transcription.

Workers AI convenience classes (`WorkersAISTT`, `WorkersAITTS`, `WorkersAIVAD`) are exported from `agents/experimental/voice`. They accept a loose `AiLike` interface to avoid hard-coupling to `@cloudflare/workers-types`. Any object satisfying the provider interfaces works — including inline objects for quick custom logic.

VAD is optional. If `this.vad` is unset, every `end_of_speech` is treated as confirmed.

### `onTurn` return type: `string | AsyncIterable<string>`

Simple responses return a string (one TTS call). Streaming responses return an async iterable (sentence-chunked TTS). The SDK detects the type at runtime — no configuration flag.

### Streaming TTS: eager async iterables

The TTS queue uses `eagerAsyncIterable()` to start TTS calls immediately when enqueued (preserving concurrent synthesis), while allowing the drain loop to iterate chunks on its own schedule. This works for both non-streaming TTS (one chunk per sentence) and streaming TTS (multiple chunks per sentence).

### Audio buffer limits

Without limits, a misbehaving client can accumulate unbounded audio data in the DO's memory. The buffer is capped at 30 seconds (960KB at 16kHz mono 16-bit). Oldest chunks are dropped. VAD pushback is capped to `vadPushbackSeconds` (default 2) — only the tail of the buffer is pushed back, not the full concatenated audio.

### `ttsMs` metric

`ttsMs` is the cumulative wall time of actual TTS synthesis calls, not including LLM streaming time.

### Transport abstraction

The client-side `VoiceClient` uses `VoiceTransport` — a minimal interface that decouples how data moves from what VoiceClient does with it:

```ts
interface VoiceTransport {
  sendJSON(data: Record<string, unknown>): void;
  sendBinary(data: ArrayBuffer): void;
  connect(): void;
  disconnect(): void;
  readonly connected: boolean;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error?: unknown) => void) | null;
  onmessage: ((data: string | ArrayBuffer | Blob) => void) | null;
}
```

`WebSocketVoiceTransport` is the default implementation, wrapping PartySocket. It is created automatically when no custom transport is provided in `VoiceClientOptions`.

This enables:

- **WebRTC transport** — wrapping the SFU peer connection for control, allowing `useSFUVoice` to reuse VoiceClient instead of duplicating 475 lines
- **Twilio client-side transport** — wrapping the Twilio Device SDK
- **Testing** — injecting a mock transport for deterministic client tests

The interface is intentionally minimal (callback-style, not EventTarget) to avoid coupling to browser APIs. Implementations are free to use WebSocket, WebRTC DataChannel, or anything else underneath.

### Audio input abstraction

The transport handles signaling and data, but audio _capture_ is a separate concern. In the WebSocket case, VoiceClient captures mic audio via AudioWorklet and sends PCM over `transport.sendBinary()`. In the SFU case, audio goes through WebRTC — a completely different path.

`VoiceAudioInput` makes mic capture pluggable:

```ts
interface VoiceAudioInput {
  start(): Promise<void>;
  stop(): void;
  onAudioLevel: ((rms: number) => void) | null;
}
```

When `VoiceClientOptions.audioInput` is set, VoiceClient delegates mic capture to it instead of using its built-in AudioWorklet. The audio input is responsible for capturing and routing audio to the server (however it chooses — WebRTC, SFU, direct binary, etc.).

The audio input must call `onAudioLevel(rms)` with RMS values on each audio frame. VoiceClient uses these for:

1. **Audio level UI** — the `audioLevel` getter and `audiolevelchange` event
2. **Silence detection** — `start_of_speech` and `end_of_speech` messages
3. **Interrupt detection** — stopping playback when user speaks over the agent

This eliminates the duplication between `VoiceClient` and `useSFUVoice`. The SFU hook can now be rewritten as:

```ts
const sfuInput = new SFUAudioInput({ ... });  // WebRTC + AnalyserNode
const client = new VoiceClient({
  transport: wsTransport,   // WebSocket for control + transcripts
  audioInput: sfuInput,     // WebRTC for audio capture
});
```

All protocol handling, playback, state management, silence detection, and interrupt detection are shared. Only the audio capture path differs.

### Audio format negotiation

Different clients need different audio formats:

| Client               | Needs                            |
| -------------------- | -------------------------------- |
| Browser (WebSocket)  | MP3 (smallest, hardware-decoded) |
| Browser (WebRTC/SFU) | Opus (WebRTC-native)             |
| Twilio adapter       | PCM 16-bit (mulaw conversion)    |

The server declares the format at call start:

1. `VoiceAgentOptions` accepts `audioFormat` (default: `"mp3"`). Type: `"mp3" | "pcm16" | "wav" | "opus"`.
2. On `start_call`, the server sends `{ type: "audio_config", format, sampleRate? }` before the first `listening` status.
3. The client stores `audioFormat` and exposes it via a getter. Future work: the client adapts its playback/decoding pipeline based on the declared format.

The `audio_config` message is sent once per call start, not per audio chunk. This keeps the protocol lightweight. If format changes mid-call (unlikely), the server sends a new `audio_config`.

The client can send a `preferred_format` hint in the `start_call` message:

```
{ type: "start_call", preferred_format: "pcm16" }
```

The server logs the request but currently always sends its configured format. When TTS providers support multiple output formats, the server can honor the hint. The `audio_config` message always reflects reality — what the server is actually sending.

`VoiceClientOptions.preferredFormat` sets this hint. It is optional and purely advisory.

## Hibernation

Hibernation works correctly by default. Voice agents do not need `hibernate: false`.

The design gives you the best of both worlds: the DO hibernates between calls (saving billable duration), and stays alive during active calls (preserving audio buffers and pipeline state). Two mechanisms make this work:

### During calls: keepalive timer

When a call starts, VoiceAgent starts a 5-second `setInterval` to keep JS executing. This prevents the DO from hibernating while a call is active. The timer is cleared on `end_call`, `onClose`, or disconnect. The timer callback is a no-op — it exists solely to keep the isolate alive.

### Between calls: hibernation is free

When no call is active, the DO can hibernate freely. WebSocket connections survive (platform-managed), SQLite data (`cf_voice_messages`) survives, and connection attachments survive. When the next message arrives, the DO wakes and handles it normally.

### Edge case: DO evicts mid-call

If something catastrophic kills the isolate despite the keepalive (e.g., an unhandled exception), the DO evicts. On wake:

1. The WebSocket connection is still alive (platform-managed).
2. The client sends the next audio chunk, waking the DO.
3. `onMessage` detects "no in-memory buffer but `_voiceInCall` attachment is true" → `#restoreCallState()` re-initializes the audio buffer and keepalive timer.
4. Audio processing continues. The buffer accumulated before eviction is lost — the next `end_of_speech` transcribes only post-wake audio. This is graceful degradation, not failure.

### Client reconnect recovery

If the WebSocket drops entirely (network change, browser tab sleep, etc.), PartySocket reconnects automatically with a **new** connection. The old connection's `onClose` cleans up server-side state. The new connection gets `welcome` + `idle` from `onConnect`.

`VoiceClient` tracks an `#inCall` flag. On `transport.onopen`, if `#inCall` is true, it automatically re-sends `start_call` on the new connection. The mic is still running (not stopped on disconnect), so audio resumes flowing immediately. The call recovers transparently:

```
Network drop → PartySocket reconnects → onopen fires
  → VoiceClient sees #inCall=true → sends start_call
  → Server processes start_call on new connection → listening
  → Mic audio resumes flowing → call continues
```

Conversation history is preserved in SQLite across reconnects. The user experiences a brief pause (the reconnect window), then the call continues as if nothing happened.

### What survives what

| Data                  | Hibernation wake | Client reconnect |
| --------------------- | ---------------- | ---------------- |
| WebSocket connection  | ✓ (same conn)    | ✗ (new conn)     |
| Audio buffer          | ✗ (re-created)   | ✗ (fresh start)  |
| Active pipeline       | ✗ (aborted)      | ✗ (fresh start)  |
| STT session           | ✗ (aborted)      | ✗ (fresh start)  |
| Conversation history  | ✓ (SQLite)       | ✓ (SQLite)       |
| Connection attachment | ✓                | ✗ (new conn)     |
| Keepalive timer       | ✗ (restarted)    | N/A (new call)   |

## Telephony (Twilio adapter)

The `@cloudflare/agents-voice-twilio` adapter bridges Twilio Media Streams to VoiceAgent. Architecture:

```
Phone → Twilio → WebSocket → TwilioAdapter → WebSocket → VoiceAgent DO
```

### Inbound audio

Twilio sends mulaw 8kHz base64 JSON. The adapter decodes: base64 → mulaw → PCM 8kHz → resample to 16kHz → binary WebSocket frame.

### Outbound audio

VoiceAgent sends binary audio (expected: 16kHz 16-bit mono PCM). The adapter converts: PCM 16kHz → resample to 8kHz → encode mulaw → base64 → Twilio media JSON.

**Important limitation:** `WorkersAITTS` returns MP3, which cannot be decoded to PCM in the Workers runtime (no AudioContext). When using the Twilio adapter, the VoiceAgent MUST use a TTS provider that outputs raw PCM. Options:

- ElevenLabs with `outputFormat: "pcm_16000"`
- A custom TTS provider that returns 16kHz 16-bit mono PCM

## Single-speaker enforcement

The `beforeCallStart(connection)` hook lets subclasses reject calls (return `false`). The voice-agent example uses this to enforce single-speaker: only one connection can be the active speaker at a time. Other connections can still observe transcripts and send text.

The kick mechanism is handled at the application level (not in the SDK): the server's `onMessage` intercepts `{ type: "kick_speaker" }` and calls `this.forceEndCall(connection)` on the kicked connection.

### `forceEndCall(connection)`

Public method on the mixin that programmatically ends a call for a specific connection. Cleans up all server-side state (audio buffers, active pipelines, streaming STT sessions, keepalive timers) and sends `idle` status to the client. No-ops if the connection is not in a call. Use this for kicking speakers, enforcing call limits, or server-initiated hangups.

## Provider ecosystem

Provider interfaces (defined in `types.ts`):

- `STTProvider` — `transcribe(audio: ArrayBuffer, signal?: AbortSignal): Promise<string>`
- `TTSProvider` — `synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null>`
- `StreamingTTSProvider` — `synthesizeStream(text: string, signal?: AbortSignal): AsyncGenerator<ArrayBuffer>`
- `StreamingSTTProvider` — `createSession(options?): StreamingSTTSession`
- `StreamingSTTSession` — `feed(chunk)`, `finish(): Promise<string>`, `abort()`, `onInterim`, `onFinal`
- `VADProvider` — `checkEndOfTurn(audio: ArrayBuffer): Promise<{ isComplete: boolean; probability: number }>`

The optional `AbortSignal` on STT/TTS providers allows the pipeline to cancel in-flight calls when the user interrupts. The Workers AI providers and ElevenLabsTTS pass it through. Custom providers should do the same.

### Built-in providers (Workers AI)

Exported from `agents/experimental/voice`:

| Class          | Interface     | Default model                  |
| -------------- | ------------- | ------------------------------ |
| `WorkersAISTT` | `STTProvider` | `@cf/deepgram/nova-3`          |
| `WorkersAITTS` | `TTSProvider` | `@cf/deepgram/aura-1`          |
| `WorkersAIVAD` | `VADProvider` | `@cf/pipecat-ai/smart-turn-v2` |

All accept an `AiLike` binding (typically `this.env.AI`) and an optional options object for model/language/speaker/windowSeconds. Both `WorkersAISTT` and `WorkersAITTS` accept and forward the optional `AbortSignal` to the AI binding.

### External providers

- `@cloudflare/agents-voice-elevenlabs` — `ElevenLabsTTS` implements both `TTSProvider` and `StreamingTTSProvider`
- `@cloudflare/agents-voice-deepgram` — `DeepgramStreamingSTT` implements `StreamingSTTProvider` using Deepgram's real-time WebSocket API
- Any object satisfying the provider interfaces works — use inline objects for quick custom logic

### Inline providers

For one-off customization without a class:

```ts
stt = {
  transcribe: async (audio: ArrayBuffer) => {
    const resp = await fetch("https://my-stt.example.com/v1/transcribe", {
      method: "POST",
      body: audio
    });
    return (await resp.json()).text;
  }
};
```

## Streaming STT

Streaming STT is an alternative to batch STT that eliminates transcription latency. Instead of buffering all audio and transcribing at end-of-speech, audio is streamed to an external STT service in real time.

### Session lifecycle

```
start_of_speech → createSession()    Feed audio chunks
     ↓                                    ↓
  feed(chunk) ←── audio frames ───    onInterim(text)
     ↓                                    ↓
  end_of_speech → finish()           onFinal(segment)
     ↓                                    ↓
  transcript ready (~50ms)           transcript_interim → client
```

1. **Session start** — triggered by `start_of_speech` from the client, or auto-created on the first audio chunk if the client does not send `start_of_speech` (backward compat with older clients, SFU, Twilio).
2. **Feeding** — every audio chunk is forwarded to `session.feed()` alongside normal buffer accumulation.
3. **Interim transcripts** — `session.onInterim` and `session.onFinal` fire as the provider returns results. These are sent to the client as `transcript_interim` messages. The display text accumulates finalized segments plus the current interim.
4. **Finish** — at end-of-speech (after VAD confirmation), `session.finish()` is called. This flushes the provider and returns the full stable transcript. Typical flush time: ~50ms (vs 500-2000ms for batch STT).
5. **Abort** — on interrupt, disconnect, or end-call, `session.abort()` closes the session immediately without producing a transcript.

### Interaction with other pipeline stages

- **VAD** still runs on end-of-speech. If VAD rejects the turn, the session stays alive (user may still be speaking).
- **`beforeTranscribe`** is skipped when streaming STT is active (audio was already fed incrementally). `afterTranscribe` still runs on the final transcript.
- **Batch STT fallback** — if `streamingStt` is not set, the pipeline uses `stt.transcribe()` as before.

### Provider implementation

The `StreamingSTTProvider` interface has a single method: `createSession(options?)`. The session manages its own connection lifecycle (e.g., a WebSocket to Deepgram). The `DeepgramStreamingSTT` package in `packages/agents-voice-deepgram` is the reference implementation.

## Pipeline hooks

Four interception points between pipeline stages:

| Hook                                       | Receives          | Can skip by returning |
| ------------------------------------------ | ----------------- | --------------------- |
| `beforeTranscribe(audio, connection)`      | Raw PCM after VAD | `null`                |
| `afterTranscribe(transcript, connection)`  | STT text          | `null`                |
| `beforeSynthesize(text, connection)`       | Text before TTS   | `null`                |
| `afterSynthesize(audio, text, connection)` | Audio after TTS   | `null`                |

Hooks run in both streaming and non-streaming paths, and in `speak()`/`speakAll()`.

## Wire protocol

The voice protocol is a set of JSON messages over the same WebSocket that carries binary audio frames. All types are defined in `types.ts` and shared between server and client.

### Protocol versioning

`VOICE_PROTOCOL_VERSION` (currently `1`) is exported from `types.ts`. The handshake:

1. On connect, the server sends `{ type: "welcome", protocol_version: 1 }`.
2. On connect, the client sends `{ type: "hello", protocol_version: 1 }`.
3. If there is a version mismatch, the client logs a warning. Future: the server may reject incompatible clients or negotiate capabilities.

Bump `VOICE_PROTOCOL_VERSION` when making backwards-incompatible wire protocol changes.

### Client → Server (`VoiceClientMessage`)

| Message           | Fields              | Purpose                                   |
| ----------------- | ------------------- | ----------------------------------------- |
| `hello`           | `protocol_version?` | Client announces its protocol version     |
| `start_call`      | —                   | Begin a voice call                        |
| `end_call`        | —                   | End the current call                      |
| `start_of_speech` | —                   | User started speaking (for streaming STT) |
| `end_of_speech`   | —                   | Client-side silence detection triggered   |
| `interrupt`       | —                   | User spoke during agent playback          |
| `text_message`    | `text`              | Send text (bypasses STT)                  |

### Server → Client (`VoiceServerMessage`)

| Message              | Fields                                                               | Purpose                                             |
| -------------------- | -------------------------------------------------------------------- | --------------------------------------------------- |
| `welcome`            | `protocol_version`                                                   | Server announces its protocol version               |
| `audio_config`       | `format`, `sampleRate?`                                              | Declares audio format for this call                 |
| `status`             | `status`                                                             | Pipeline state: idle, listening, thinking, speaking |
| `transcript`         | `role`, `text`                                                       | Complete transcript entry                           |
| `transcript_start`   | `role`                                                               | Streaming transcript begins                         |
| `transcript_delta`   | `text`                                                               | Streaming transcript chunk                          |
| `transcript_end`     | `text`                                                               | Streaming transcript complete                       |
| `transcript_interim` | `text`                                                               | Interim (unstable) transcript from streaming STT    |
| `metrics`            | `vad_ms`, `stt_ms`, `llm_ms`, `tts_ms`, `first_audio_ms`, `total_ms` | Pipeline timing                                     |
| `error`              | `message`                                                            | Error description                                   |

Binary frames (audio) flow in both directions alongside JSON. Client sends 16kHz 16-bit mono PCM. Server sends audio in the format declared by `audio_config` (default: MP3).

Non-voice JSON messages (any `type` not in the list above) are routed to `onNonVoiceMessage()` on the server and emitted as `custommessage` events on the client. This allows app-level messages (e.g., `{ type: "kick_speaker" }`) to share the same connection.

## History

- Initial implementation in `examples/voice-agent` (Layer 0)
- Client-side audio utilities extracted to `agents/voice-client` and `agents/voice-react` (Layer 1)
- Server-side pipeline extracted to `agents/voice` as `VoiceAgent` class (Layer 2)
- Pipeline hooks, streaming TTS, ElevenLabs provider, Twilio adapter (Layer 3/4)
- Transport abstraction, audio format negotiation, hibernation state persistence (Layer 5)
- Provider-based pipeline: removed env.AI assumption, added WorkersAISTT/TTS/VAD classes, VAD made optional (Layer 6)
- Streaming STT: `StreamingSTTProvider`/`StreamingSTTSession` interfaces, server integration, client `interimTranscript`, Deepgram provider package (Layer 7)
- Protocol versioning: `welcome`/`hello` handshake, `VOICE_PROTOCOL_VERSION` constant (Layer 7)
- `forceEndCall(connection)`: programmatic call termination (Layer 7)
- Signal support: `WorkersAISTT.transcribe()` and `WorkersAITTS.synthesize()` now accept `AbortSignal` (Layer 7)
- Hibernation: client reconnect recovery (`#inCall` tracking, auto re-send `start_call`), removed `hibernate: false` recommendation (Layer 8)
- Audio input abstraction: `VoiceAudioInput` interface, `#processAudioLevel` extracted for shared silence/interrupt detection, `audioInput` option on `VoiceClientOptions` (Layer 9)
- Format negotiation: `preferred_format` in `start_call` message, `preferredFormat` option on `VoiceClientOptions` (Layer 9)
