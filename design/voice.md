# Voice Pipeline — Design (Experimental)

> **Status: experimental.** The voice API is in `@cloudflare/voice` and will break between releases. See `docs/voice.md` for user-facing docs.

How the voice pipeline works and why it is built this way.

## Architecture

A single WebSocket carries audio frames (binary), JSON status messages, transcript updates, and pipeline metrics.

```
Browser / Client                        Durable Object (withVoice or withVoiceInput)
┌──────────┐   binary PCM (16kHz)       ┌──────────────────────────────────────┐
│ Mic      │ ─────────────────────────► │ AudioConnectionManager (per-conn)    │
│          │                            │   ↓                                  │
│          │   JSON: end_of_speech      │ VAD (optional)                       │
│          │ ─────────────────────────► │   ↓                                  │
│          │                            │ STT (batch or streaming)             │
│          │   JSON: transcript         │   ↓                                  │
│          │ ◄───────────────────────── │ onTurn() / onTranscript()            │
│          │   binary: audio            │   ↓ (SentenceChunker, withVoice only)│
│ Speaker  │ ◄───────────────────────── │ TTS (withVoice only)                 │
└──────────┘                            └──────────────────────────────────────┘
```

One WebSocket per client. The same connection handles voice, state sync, RPC, and text chat.

### Why WebSocket-native (no SFU)

A voice agent is a 1:1 conversation. The browser has `getUserMedia()` for the mic and Web Audio API for playback. Audio flows as binary WebSocket frames over the connection the Agent already has.

What you give up:

- Multi-participant (does not apply to 1:1)
- WebRTC-grade network resilience (TCP head-of-line blocking on bad networks)
- Tightly coupled echo cancellation (browser AEC via `getUserMedia` constraints still works)

SFU integration is documented as an advanced option in `docs/voice.md`.

## Two mixins

### `withVoice(Agent)` — full conversational voice agent

Full pipeline: continuous STT, LLM (`onTurn`), sentence chunking, streaming TTS, interruption handling, conversation persistence (SQLite), and pipeline metrics. Requires `transcriber` and `tts` providers. Supports hibernation via `_unsafe_setConnectionFlag`/`_unsafe_getConnectionFlag`. Recommended transcriber: `WorkersAIFluxSTT` (Flux has built-in conversational turn detection).

### `withVoiceInput(Agent)` — STT-only voice input

Lightweight pipeline: continuous STT, then `onTranscript()` callback. No TTS, no `onTurn`, no response generation, no conversation persistence. For dictation/voice input UIs. Recommended transcriber: `WorkersAINova3STT` (Nova 3 has better raw transcription accuracy).

Both mixins share `AudioConnectionManager` for per-connection state and use the same wire protocol.

### `VoiceAgentOptions`

Voice-only options: `historyLimit`, `audioFormat`, `maxMessageCount`.

## Pipeline stages

1. **Audio buffering + continuous STT** — binary frames accumulate per-connection in `AudioConnectionManager`. Capped at 30 seconds (`MAX_AUDIO_BUFFER_BYTES = 960KB`). Each chunk is simultaneously buffered and fed to the active transcriber session via `session.feed()`. The transcriber session is created at `start_call` and lives for the entire call.

2. **Client-side speech detection (UI only)** — AudioWorklet monitors RMS. `start_of_speech` / `end_of_speech` messages drive local UI state (speaking indicators, audio level). The server ignores these for STT — the model handles turn detection. This makes the client thinner and more portable (mobile, embedded, etc. clients only need mic capture + WebSocket).

3. **Model-driven turn detection** — the transcriber model detects utterance boundaries. Flux fires `EndOfTurn` events with a stable transcript. Nova 3 uses `endpointing` + `speech_final` results. The mixin maps `onUtterance` to `onTurn` (withVoice) or `onTranscript` (withVoiceInput).

4. **Interrupt handling** — on interrupt, the LLM+TTS pipeline is aborted but the transcriber session stays alive. The model continues receiving audio and will detect the next turn naturally. This is simpler than the old per-utterance model where interrupt required aborting the STT session, clearing buffers, and resetting EOT state.

5. **LLM** (withVoice only) — `onTurn()` receives transcript, conversation history, and `AbortSignal`.

6. **Streaming TTS** (withVoice only) — token stream → `SentenceChunker` (min 10 chars) → per-sentence TTS. Sentences synthesized eagerly via `eagerAsyncIterable` to overlap synthesis of sentence N+1 with delivery of sentence N. TTS providers receive `AbortSignal` for cancellation on interrupt. When the provider implements `synthesizeStream()`, individual chunks stream as they arrive.

7. **Interruption** — client detects sustained speech above threshold during playback → stops playback → sends `interrupt` → server aborts active pipeline via `AbortController`, clears audio buffer, calls `onInterrupt()` hook. Both mixins support `onInterrupt()`.

## Key decisions

### Mixin pattern

`withVoice(Agent)` and `withVoiceInput(Agent)` produce classes with the pipeline mixed in. Constructor interception captures `onConnect`/`onClose`/`onMessage` from the subclass prototype and wraps them — voice protocol messages are handled internally, everything else is forwarded to the consumer.

### Explicit providers

Subclasses set providers as class properties:

```ts
class MyAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);
}
```

Class field initializers run after `super()`, so `this.env` is available. Override `createTranscriber(connection)` for runtime model switching. Workers AI convenience classes accept a loose `AiLike` interface. Any object satisfying the `Transcriber` interface works.

### `onTurn` return type: `string | AsyncIterable<string> | ReadableStream`

Simple responses return a string (one TTS call). Streaming responses return an `AsyncIterable` or `ReadableStream` (sentence-chunked TTS). `iterateText()` normalizes all three into `AsyncIterable<string>`.

### Eager async iterables

`eagerAsyncIterable()` starts TTS calls immediately when enqueued, while letting the drain loop iterate at its own pace. Works for both non-streaming TTS (one chunk per sentence) and streaming TTS (multiple chunks per sentence).

### Audio buffer limits

Buffer capped at 30 seconds (960KB at 16kHz mono 16-bit). Oldest chunks dropped. VAD pushback capped to `vadPushbackSeconds` — only the tail is pushed back, not the full concatenated audio.

### `AudioConnectionManager`

Shared state manager for both mixins. Owns the `Map`/`Set` instances for audio buffers, streaming STT sessions, VAD retry timers, EOT flags, and pipeline `AbortController`s. Key invariants:

- `initConnection()` is idempotent — duplicate `start_call` does not wipe buffered audio.
- `clearAudioBuffer()` only operates on existing connections — calling it before `start_call` does not create a phantom entry.
- `cleanup()` aborts everything: pipeline, STT session, VAD retry, EOT flag, audio buffer.
- `isInCall()` checks buffer map membership. This is the authoritative in-call signal.

### Transport abstraction

`VoiceClient` uses `VoiceTransport` — a minimal callback-style interface:

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

`WebSocketVoiceTransport` (default) wraps PartySocket. Custom transports enable WebRTC, SFU, Twilio, or mock testing.

### Audio input abstraction

`VoiceAudioInput` makes mic capture pluggable:

```ts
interface VoiceAudioInput {
  start(): Promise<void>;
  stop(): void;
  onAudioLevel: ((rms: number) => void) | null;
  onAudioData?: ((pcm: ArrayBuffer) => void) | null;
}
```

When set, VoiceClient delegates capture to it instead of the built-in AudioWorklet. The input must call `onAudioLevel(rms)` for silence/interrupt detection and audio level UI. `onAudioData` is optional — used when audio reaches the server through the same WebSocket (e.g. SFU local dev fallback).

### Audio format negotiation

| Client               | Needs                            |
| -------------------- | -------------------------------- |
| Browser (WebSocket)  | MP3 (smallest, hardware-decoded) |
| Browser (WebRTC/SFU) | Opus (WebRTC-native)             |
| Twilio adapter       | PCM 16-bit (mulaw conversion)    |

The server declares format at call start via `audio_config`. The client can hint via `preferred_format` in `start_call` — currently advisory only.

## Hibernation (withVoice only)

`withVoice` supports hibernation. `withVoiceInput` does not — if the DO hibernates mid-call, all in-memory state is lost and the client must re-send `start_call`.

### How withVoice hibernation works

The DO hibernates between calls freely. WebSocket connections survive (platform-managed), SQLite data (`cf_voice_messages`) survives, and connection attachments survive.

During active calls, audio frames arrive frequently enough to keep the DO alive. There is no keepalive timer — the audio stream itself prevents hibernation.

### State persistence

Call state is persisted via `_unsafe_setConnectionFlag(connection, "_cf_voiceInCall", true)`. On wake, if `onMessage` receives data for a connection with `_cf_voiceInCall` set but no in-memory buffer, `#restoreCallState()` re-initializes the audio buffer. Audio buffered before eviction is lost — the next `end_of_speech` transcribes only post-wake audio. This is graceful degradation, not failure.

### Client reconnect recovery

If the WebSocket drops (network change, tab sleep, etc.), PartySocket reconnects with a **new** connection. The old connection's `onClose` cleans up server-side state.

`VoiceClient` tracks `#inCall`. On `transport.onopen`, if `#inCall` is true, it re-sends `start_call`. The mic is still running, so audio resumes immediately:

```
Network drop → PartySocket reconnects → onopen fires
  → VoiceClient sees #inCall=true → sends start_call
  → Server processes start_call → listening
  → Audio resumes → call continues
```

Conversation history is preserved in SQLite across reconnects.

### What survives what

| Data                  | Hibernation wake | Client reconnect |
| --------------------- | ---------------- | ---------------- |
| WebSocket connection  | same conn        | new conn         |
| Audio buffer          | re-created empty | fresh start      |
| Active pipeline       | lost             | fresh start      |
| STT session           | lost             | fresh start      |
| Conversation history  | SQLite           | SQLite           |
| Connection attachment | preserved        | new conn         |

## Telephony (Twilio adapter)

`@cloudflare/voice-twilio` bridges Twilio Media Streams to VoiceAgent:

```
Phone → Twilio → WebSocket → TwilioAdapter → WebSocket → VoiceAgent DO
```

- **Inbound**: mulaw 8kHz base64 JSON → decode → PCM 8kHz → resample 16kHz → binary WS frame.
- **Outbound**: binary PCM 16kHz → resample 8kHz → mulaw → base64 → Twilio media JSON.

**Limitation:** `WorkersAITTS` returns MP3, which cannot be decoded to PCM in Workers (no AudioContext). Use a TTS provider that outputs raw PCM (e.g. ElevenLabs with `outputFormat: "pcm_16000"`).

## Lifecycle hooks

Both mixins support:

| Hook                                | Purpose                                      |
| ----------------------------------- | -------------------------------------------- |
| `beforeCallStart(connection)`       | Return `false` to reject the call            |
| `onCallStart(connection)`           | Called after call is accepted                |
| `onCallEnd(connection)`             | Called when call ends                        |
| `onInterrupt(connection)`           | Called when user interrupts the agent        |
| `afterTranscribe(text, connection)` | Transform transcript after STT; `null` skips |

`withVoice` adds:

| Hook                                       | Purpose                                 |
| ------------------------------------------ | --------------------------------------- |
| `onTurn(transcript, context)`              | LLM logic — required                    |
| `beforeSynthesize(text, connection)`       | Transform text before TTS; `null` skips |
| `afterSynthesize(audio, text, connection)` | Transform audio after TTS; `null` skips |

`withVoiceInput` adds:

| Hook                             | Purpose                      |
| -------------------------------- | ---------------------------- |
| `onTranscript(text, connection)` | Handle transcribed utterance |

Hooks run in both streaming and non-streaming STT paths, and in `speak()`/`speakAll()`.

### Single-speaker enforcement

`beforeCallStart(connection)` lets subclasses reject calls. The voice-agent example uses this to enforce single-speaker. The kick mechanism is application-level: the server's `onMessage` intercepts `{ type: "kick_speaker" }` and calls `forceEndCall(connection)`.

### `forceEndCall(connection)`

Public method on `withVoice` that programmatically ends a call. Cleans up all server-side state and sends `idle` to the client. No-ops if the connection is not in a call.

### `speak(connection, text)` / `speakAll(text)`

Convenience methods on `withVoice`. `speak()` synthesizes and sends audio to one connection. `speakAll()` sends to all connections. Both respect pipeline hooks and `AbortSignal`.

## Provider interfaces

Defined in `types.ts`:

| Interface              | Methods                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `STTProvider`          | `transcribe(audio, signal?): Promise<string>`                  |
| `TTSProvider`          | `synthesize(text, signal?): Promise<ArrayBuffer \| null>`      |
| `StreamingTTSProvider` | `synthesizeStream(text, signal?): AsyncGenerator<ArrayBuffer>` |
| `VADProvider`          | `checkEndOfTurn(audio): Promise<{ isComplete, probability }>`  |
| `StreamingSTTProvider` | `createSession(options?): StreamingSTTSession`                 |
| `StreamingSTTSession`  | `feed(chunk)`, `finish(): Promise<string>`, `abort()`          |

`AbortSignal` on STT/TTS allows cancelling in-flight calls on interrupt. All built-in and external providers pass it through.

### Built-in providers (Workers AI)

Exported from `@cloudflare/voice`:

| Class               | Interface     | Default model         | Recommended for  |
| ------------------- | ------------- | --------------------- | ---------------- |
| `WorkersAIFluxSTT`  | `Transcriber` | `@cf/deepgram/flux`   | `withVoice`      |
| `WorkersAINova3STT` | `Transcriber` | `@cf/deepgram/nova-3` | `withVoiceInput` |
| `WorkersAITTS`      | `TTSProvider` | `@cf/deepgram/aura-1` | Both             |

All accept an `AiLike` binding (typically `this.env.AI`).

### External providers

| Package                        | Class           | Interface                              |
| ------------------------------ | --------------- | -------------------------------------- |
| `@cloudflare/voice-elevenlabs` | `ElevenLabsTTS` | `TTSProvider` + `StreamingTTSProvider` |
| `@cloudflare/voice-deepgram`   | `DeepgramSTT`   | `Transcriber`                          |

Any object satisfying the `Transcriber` interface works.

## Streaming STT

Eliminates transcription latency by streaming audio to an external STT service in real time instead of buffering all audio for batch transcription.

### Session lifecycle

```
start_call → createSession()
     ↓
  feed(chunk) ←── all audio frames
     ↓
  model detects utterance → onUtterance(transcript)
     ↓
  pipeline runs (LLM + TTS)
     ↓
  back to listening (session stays alive)
     ↓
  end_call → close()
```

Callbacks fire during the session:

- `onInterim(text)` — unstable partial transcript, relayed as `transcript_interim`
- `onUtterance(text)` — model-driven utterance boundary, triggers pipeline

Session is created at `start_call` and lives for the entire call. All audio is fed continuously — no pre-roll needed since there is no gap between speech onset and session creation. The model handles turn detection (Flux `EndOfTurn`, Nova 3 `speech_final` + endpointing). On interrupt, the LLM+TTS pipeline is aborted but the transcriber session stays alive. On `end_call` or disconnect, `session.close()` releases resources.

### Interaction with VAD

VAD still runs on end-of-speech. If VAD rejects, the session stays alive. The VAD retry timer ensures eventual processing.

### Interaction with hooks

`afterTranscribe` runs on the transcript before the pipeline processes it.

### Provider-driven EOT

When the streaming STT provider fires `onEndOfTurn`, the pipeline bypasses client-side silence detection entirely. The session is removed, the audio buffer cleared, and `#runPipeline` (withVoice) or `#emitTranscript` (withVoiceInput) is called immediately. A guard (`#eotTriggered`) prevents double-processing if the client's `end_of_speech` arrives after the provider already triggered EOT.

## Wire protocol

JSON messages over the same WebSocket as binary audio frames. Types defined in `types.ts`.

### Protocol versioning

`VOICE_PROTOCOL_VERSION` (currently `1`). On connect:

1. Server sends `{ type: "welcome", protocol_version: 1 }`.
2. Client sends `{ type: "hello", protocol_version: 1 }`.

Mismatch logs a warning. Future: server may reject incompatible clients.

### Client → Server (`VoiceClientMessage`)

| Message           | Fields              | Purpose                                   |
| ----------------- | ------------------- | ----------------------------------------- |
| `hello`           | `protocol_version?` | Client announces protocol version         |
| `start_call`      | `preferred_format?` | Begin a voice call                        |
| `end_call`        | —                   | End the current call                      |
| `start_of_speech` | —                   | User started speaking (for streaming STT) |
| `end_of_speech`   | —                   | Client-side silence detection triggered   |
| `interrupt`       | —                   | User spoke during agent playback          |
| `text_message`    | `text`              | Send text (bypasses STT, withVoice only)  |

### Server → Client (`VoiceServerMessage`)

| Message              | Fields                                           | Purpose                                             |
| -------------------- | ------------------------------------------------ | --------------------------------------------------- |
| `welcome`            | `protocol_version`                               | Server announces protocol version                   |
| `audio_config`       | `format`, `sampleRate?`                          | Declares audio format for this call                 |
| `status`             | `status`                                         | Pipeline state: idle, listening, thinking, speaking |
| `transcript`         | `role`, `text`                                   | Complete transcript entry                           |
| `transcript_start`   | `role`                                           | Streaming transcript begins                         |
| `transcript_delta`   | `text`                                           | Streaming transcript chunk                          |
| `transcript_end`     | `text`                                           | Streaming transcript complete                       |
| `transcript_interim` | `text`                                           | Interim transcript from streaming STT               |
| `metrics`            | `llm_ms`, `tts_ms`, `first_audio_ms`, `total_ms` | Pipeline timing (withVoice only)                    |
| `error`              | `message`                                        | Error description                                   |

Binary frames flow in both directions. Client sends 16kHz 16-bit mono PCM. Server sends audio in the format declared by `audio_config` (default: MP3).

Non-voice JSON messages are forwarded to the consumer's `onMessage()` on the server and emitted as `custommessage` events on the client.

## Client-side (`VoiceClient`)

`VoiceClient` handles the client side of the voice protocol. It manages:

- Transport lifecycle (connect/disconnect)
- Mic capture (AudioWorklet or custom `VoiceAudioInput`)
- Silence detection (`start_of_speech`/`end_of_speech`)
- Interrupt detection (speech during playback)
- Audio playback
- Protocol message dispatch
- Status and transcript state

`startCall()` emits an error if the transport is not connected, rather than silently doing nothing.

JSON message handling narrows the `try/catch` to only cover `JSON.parse`. Listener errors propagate instead of being swallowed.

### React hooks

- `useVoiceAgent(options)` — wraps `VoiceClient` for `withVoice` agents
- `useVoiceInput(options)` — wraps `VoiceClient` for `withVoiceInput` agents

`useVoiceAgent` accepts `enabled?: boolean` as a React lifecycle gate. While disabled, the hook keeps the exposed state in the idle/disconnected shape and does not construct or connect a `VoiceClient`. Enabling the hook creates a client with the current options; disabling it tears down the active client. This keeps credential/bootstrap readiness in the React hook module instead of forcing callers to provide dormant `VoiceTransport` adapters.

Both include tuning knobs (`silenceThreshold`, `silenceDurationMs`, `interruptThreshold`, `interruptChunks`) in the connection key so changing them triggers client recreation.

## Tradeoffs

- **No hibernation for withVoiceInput** — simpler implementation, but mid-call hibernation loses state. Acceptable for voice input UIs where calls are short.
- **No multi-participant** — WebSocket-only means no SFU-grade multi-party. Fine for 1:1 voice agents.
- **TCP head-of-line blocking** — WebSocket over TCP, not WebRTC. On degraded networks, audio may stall. SFU option exists for critical use cases.
- **MIN_SENTENCE_LENGTH = 10** — balances avoiding false splits on abbreviations ("Dr.", "U.S.") against latency for short responses ("Sure!"). May need tuning.
- **No audio format auto-negotiation** — server always sends its configured format. `preferred_format` is advisory only.
