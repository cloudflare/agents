# 05 — Voice Pipeline

The voice packages add real-time speech-to-text (STT) and text-to-speech (TTS) capability to any agent. The architecture is a mixin pattern: you call `withVoice(Agent)` to produce a new class that is both a normal agent and a voice pipeline.

All code lives in `packages/voice/` with provider-specific implementations in `voice-providers/`.

---

## Core pipeline (`packages/voice/src/voice.ts`)

[`withVoice<TBase>(Base)` mixin](../packages/voice/src/voice.ts#L195-L240) — the main export. Takes any `Agent` subclass and returns a new class that adds the full voice pipeline. Typical usage:

```typescript
class MyVoiceAgent extends withVoice(Agent)<Env> {
  async onTurn(connection, transcription) { /* ... */ }
}
```

[`VoiceAgentMixinMembers` interface](../packages/voice/src/voice.ts#L133-L162) — the public API surface added by the mixin. Key members:
- `onTurn(transcript, context)` — override this to handle a complete voice utterance. Returns a `TextSource` (string, stream, or async iterable); the pipeline synthesises it to audio.
- `speak(connection, text)` — synthesise text to audio and send it to a specific connection.
- `speakAll(text)` — synthesise and broadcast audio to all active connections.
- `beforeCallStart()` / `onCallStart()` / `onCallEnd()` — call lifecycle hooks.
- `afterTranscribe()` / `beforeSynthesize()` / `afterSynthesize()` — per-turn transform hooks.
- `transcriber` / `tts` — the STT and TTS provider properties.

[Voice mixin — constructor, onConnect/onClose/onMessage wiring, and user-overridable hooks](../packages/voice/src/voice.ts#L240-L450) — the constructor wraps the base class lifecycle methods to intercept voice protocol messages and binary audio frames. User-overridable hooks (`onTurn`, `createTranscriber`, `beforeCallStart`, `onCallStart`, `onCallEnd`, `onInterrupt`, `afterTranscribe`, `beforeSynthesize`, `afterSynthesize`) and conversation persistence (`saveMessage`, `getConversationHistory`) are also defined here.

[Voice mixin — speakAll(), synthesize helpers, and call lifecycle (#handleStartCall, #handleEndCall, #handleInterrupt, #handleBargeIn)](../packages/voice/src/voice.ts#L450-L600) — `speakAll()` broadcasts TTS audio to all connections; `#handleStartCall` initialises the transcriber session and sends `audio_config`; `#handleEndCall` and `#handleInterrupt`/`#handleBargeIn` abort in-flight TTS and clean up connection state.

[Voice mixin — #handleTextMessage() and #runPipeline(): the core STT→LLM→TTS execution path](../packages/voice/src/voice.ts#L600-L800) — `#runPipeline` is called for each transcribed utterance: it invokes `afterTranscribe`, saves the user message, calls `onTurn`, then feeds the result to `#streamResponse`. `#handleTextMessage` is the equivalent path for text-only (non-voice) input from the client.

[Voice mixin — #streamResponse() and #streamingTTSPipeline(): sentence-chunked streaming TTS](../packages/voice/src/voice.ts#L800-L1000) — `#streamResponse` handles both plain-string and streaming LLM responses. For streams it delegates to `#streamingTTSPipeline`, which uses `SentenceChunker` to break the token stream into sentences, fans each sentence out to TTS concurrently via an eager queue, and streams audio chunks to the client as they are synthesised.

[Voice mixin — tail of #streamingTTSPipeline(), #sendJSON() helper, and eagerAsyncIterable() utility](../packages/voice/src/voice.ts#L1000-L1074) — the final metrics collection and return from the streaming pipeline; the internal `#sendJSON` helper that serialises voice protocol messages; and `eagerAsyncIterable`, which eagerly buffers an async iterable so TTS synthesis for sentence N+1 starts before the consumer has finished consuming sentence N.

---

## Audio pipeline state (`src/audio-pipeline.ts`)

[`AudioConnectionManager` class](../packages/voice/src/audio-pipeline.ts#L34-L146) — manages per-connection state: audio buffers (up to 30 seconds / ~960 KB), the active transcriber session, and its abort controller. Kept separate from the mixin so the state is cleanly scoped to a single WebSocket connection.

[`MAX_AUDIO_BUFFER_BYTES` constant](../packages/voice/src/audio-pipeline.ts#L1-L33) — 960 KB, equivalent to about 30 seconds of 16 kHz mono PCM. Excess audio is dropped to prevent runaway memory growth.

---

## Streaming text to sentences (`src/sentence-chunker.ts`)

LLM output arrives as a stream of tokens. Feeding every token to TTS would produce robotic speech with unnatural pauses. The sentence chunker buffers tokens and emits complete sentences.

[`SentenceChunker` class](../packages/voice/src/sentence-chunker.ts#L1-L115) — call `add(token)` for each token; it returns complete sentences as strings. Call `flush()` at the end of the stream to get any remaining partial sentence. Splits on `.`, `!`, `?` followed by a space or newline, with a minimum sentence length of 10 characters to avoid splitting abbreviations.

---

## Browser client (`src/voice-client.ts`)

[`VoiceClient` class — AudioWorklet processor, PCM helpers, and `WebSocketVoiceTransport`](../packages/voice/src/voice-client.ts#L1-L200) — the browser-side counterpart to the voice mixin. The top of the file defines the inline `AudioCaptureProcessor` AudioWorklet source (resamples mic audio from 48 kHz to 16 kHz), PCM/RMS helpers, and the `WebSocketVoiceTransport` class (the default transport backed by PartySocket). The `VoiceClient` class declaration and its constructor begin here.

[`VoiceClientOptions` interface](../packages/voice/src/voice-client.ts#L37-L84) — configuration: `agent` name, optional `host`/`name`/`query` for routing, `transport` (custom `VoiceTransport`), `audioInput` (custom mic source), `preferredFormat` for TTS audio, silence detection tuning (`silenceThreshold`, `silenceDurationMs`), interrupt detection tuning (`interruptThreshold`, `interruptChunks`), and `maxTranscriptMessages`.

[`VoiceClientEventMap` interface](../packages/voice/src/voice-client.ts#L87-L97) — the events you listen to: `statuschange` (idle/listening/thinking/speaking), `transcriptchange` (final transcript array updated), `interimtranscript` (partial STT result), `metricschange` (latency stats), `audiolevelchange` (mic RMS), `connectionchange` (WebSocket open/close), `mutechange`, `error`, `custommessage` (non-protocol server messages).

[VoiceClient — public getters, event system, and connect()/disconnect()](../packages/voice/src/voice-client.ts#L200-L450) — public read-only getters (`status`, `transcript`, `metrics`, `audioLevel`, `isMuted`, `connected`, `error`, `interimTranscript`), the `addEventListener`/`removeEventListener`/`#emit` event system, and the `connect()` method which wires transport callbacks and handles reconnect recovery. `disconnect()` also lives here.

[VoiceClient — startCall(), endCall(), toggleMute(), sendText(), sendJSON(), and #handleJSONMessage()](../packages/voice/src/voice-client.ts#L450-L700) — `startCall()` sends `start_call`, starts the mic (or custom `audioInput`), and forwards audio to the server; `endCall()` tears everything down; `toggleMute()` gates audio and flushes a pending utterance; `sendText()` and `sendJSON()` allow non-audio input. `#handleJSONMessage()` dispatches all incoming JSON protocol messages — routing `status`, `transcript_*`, `metrics`, `error`, and custom app messages to the appropriate state updates and events.

[VoiceClient — audio context, playback queue, mic capture, and audio-level processing](../packages/voice/src/voice-client.ts#L700-L906) — `#getAudioContext`/`#closeAudioContext` manage the shared Web Audio context; `#playAudio`/`#processPlaybackQueue`/`#stopPlayback` implement a serialised playback queue that decodes incoming audio (PCM16 or browser-native formats); `#startMic`/`#stopMic` set up the AudioWorklet pipeline for mic capture and resampling; `#processAudioLevel` runs both silence detection (end-of-speech timer) and interrupt detection (consecutive high-RMS chunks during agent playback).

---

## React hooks (`src/voice-react.tsx`)

[`useVoiceInput(options)` hook](../packages/voice/src/voice-react.tsx#L1-L150) — a lightweight hook for voice-to-text dictation (no TTS, no full agent turn). Accumulates user transcript text as a plain string. Returns `{ transcript, interimTranscript, isListening, audioLevel, isMuted, error, start, stop, toggleMute, clear }`. Reconnects automatically when connection identity changes.

[`useVoiceAgent(options)` hook](../packages/voice/src/voice-react.tsx#L150-L250) — wraps `VoiceClient` for React, bridging all client events into React state. Returns `{ status, transcript, interimTranscript, metrics, audioLevel, isMuted, connected, error, startCall, endCall, toggleMute, sendText, sendJSON, lastCustomMessage }`. Tears down and recreates the client when connection identity changes, firing `onReconnect` if provided.

---

## Workers AI providers (`src/workers-ai-providers.ts`)

Convenience implementations that use Cloudflare's built-in AI models so you don't need external API keys.

[`WorkersAITTS` class](../packages/voice/src/workers-ai-providers.ts#L46-L100) — TTS via the `@cf/deepgram/aura-1` Workers AI model. Implements the `TTSProvider` interface.

[`WorkersAIFluxSTT` class](../packages/voice/src/workers-ai-providers.ts#L100-L200) — continuous STT using the `@cf/deepgram/flux` model. Implements `Transcriber`. The Flux model has built-in conversational end-of-turn detection (`EndOfTurn` events); no client-side silence detection is needed. Recommended for `withVoice` conversational agents.

[`WorkersAINova3STT` class](../packages/voice/src/workers-ai-providers.ts#L200-L330) — continuous STT using the `@cf/deepgram/nova-3` model. Uses server-side VAD endpointing and `speech_final` results for utterance detection. Recommended for `withVoiceInput` dictation UIs.

[FluxSession and Nova3Session implementations](../packages/voice/src/workers-ai-providers.ts#L330-L595) — the internal per-call session classes for each Workers AI STT provider. Each opens a Workers AI WebSocket session (`ai.run(..., { websocket: true })`), buffers audio while connecting, and translates model-specific events (`StartOfTurn`/`EndOfTurn` for Flux; `Results` with `speech_final` for Nova 3) into the pipeline's `onInterim`/`onSpeechStart`/`onUtterance` callbacks.

---

## SFU utilities (`src/sfu-utils.ts`)

For deployments using Cloudflare Realtime (a Selective Forwarding Unit for WebRTC), audio needs to be encoded/decoded in the SFU's wire format.

[Protobuf varint helpers: `encodeVarint()` and `decodeVarint()`](../packages/voice/src/sfu-utils.ts#L18-L43) — encode/decode protocol-buffer-style varints. Used to frame audio packets in the SFU protocol.

[Packet handling: `extractPayloadFromProtobuf()` and `encodePayloadToProtobuf()`](../packages/voice/src/sfu-utils.ts#L45-L96) — unwrap/wrap audio payloads from/into protobuf frames.

[Audio resampling and SFU API helpers](../packages/voice/src/sfu-utils.ts#L99-L235) — `downsample48kStereoTo16kMono()` and `upsample16kMonoTo48kStereo()` convert between the WebRTC wire format (48 kHz stereo) and the STT format (16 kHz mono). The remainder of the file contains SFU REST API helpers (`sfuFetch`, `createSFUSession`, `addSFUTracks`, `renegotiateSFUSession`, `createSFUWebSocketAdapter`) for setting up Cloudflare Realtime sessions.

---

## Voice input only — no TTS (`src/voice-input.ts`)

[withVoiceInput mixin — VoiceInputMixinMembers interface and mixin class setup](../packages/voice/src/voice-input.ts#L1-L180) and [withVoiceInput — onConnect, audio capture, transcript dispatch, and call lifecycle](../packages/voice/src/voice-input.ts#L180-L349) — a lighter mixin than `withVoice`. Adds STT transcription but no TTS or LLM turn. Use this when you want speech dictation into an existing chat UI rather than a fully conversational voice agent.

[`VoiceInputMixinMembers` interface](../packages/voice/src/voice-input.ts#L50-L100) — the API surface: `transcriber`, `onTranscript(text, connection)`, `createTranscriber(connection)`, `beforeCallStart()`, `onCallStart()`, `onCallEnd()`, `onInterrupt()`, `afterTranscribe()`.

---

## Shared wire types (`src/types.ts`)

[`VOICE_PROTOCOL_VERSION` constant](../packages/voice/src/types.ts#L1-L50) — an integer bumped on breaking wire protocol changes. The server sends it in the initial `welcome` message; clients can detect mismatches.

[`VoiceClientMessage` union type](../packages/voice/src/types.ts#L50-L130) — the messages sent from browser to agent: `hello`, `start_call`, `end_call`, `start_of_speech`, `end_of_speech`, `interrupt`, `text_message`.

[`VoiceServerMessage` union type](../packages/voice/src/types.ts#L130-L243) — the messages sent from agent to browser: `welcome`, `status`, `audio_config`, `transcript`, `transcript_start`, `transcript_delta`, `transcript_end`, `transcript_interim`, `playback_interrupt`, `metrics`, `error`.

[`Transcriber` and `TTSProvider` interfaces](../packages/voice/src/types.ts#L200-L243) — the contracts every STT and TTS provider must implement. `Transcriber` has `createSession(options): TranscriberSession`; sessions receive audio via `feed(chunk)` and fire callbacks (`onInterim`, `onSpeechStart`, `onUtterance`). `TTSProvider` has `synthesize(text): Promise<ArrayBuffer | null>`. `StreamingTTSProvider` extends it with `synthesizeStream(text): AsyncGenerator<ArrayBuffer>`. Also defines `VoiceAudioInput` and `VoiceTransport` interfaces used by the browser client.

---

## Text stream normalisation (`src/text-stream.ts`)

The voice pipeline needs to handle LLM output as a stream of text chunks regardless of where it comes from (AI SDK, raw fetch, plain string).

[`TextSource` type and `iterateText(source)` function](../packages/voice/src/text-stream.ts#L1-L210) — normalises a `string`, `ReadableStream<Uint8Array>`, `ReadableStream<string>`, or `AsyncIterable<string>` into a uniform `AsyncGenerator<string>`. The `Uint8Array` stream path parses newline-delimited JSON / SSE to extract text deltas from common AI API response shapes.

---

## Voice providers (`voice-providers/`)

Each provider is a small package implementing the `Transcriber` or `TTSProvider` interface.

### Deepgram (`voice-providers/deepgram/`)

[`DeepgramSTT` class](../voice-providers/deepgram/src/index.ts#L1-L100) — connects to `wss://api.deepgram.com/v1/listen` for real-time streaming STT. Configurable model (default `nova-3`), language, smart formatting, punctuation, and endpointing delay.

[`DeepgramSession` implementation — streaming and events](../voice-providers/deepgram/src/index.ts#L100-L259) — the internal per-call `DeepgramSession` class. Binary audio is sent as WebSocket frames; text results arrive as JSON. `interim_results: true` enables partial transcripts. The session accumulates `is_final` segments and emits the joined utterance when `speech_final: true` arrives. On close it sends a `CloseStream` JSON message before shutting down the WebSocket.

### ElevenLabs (`voice-providers/elevenlabs/`)

[`ElevenLabsTTS` class](../voice-providers/elevenlabs/src/index.ts#L1-L100) — implements both `TTSProvider` (full response) and `StreamingTTSProvider` (chunked streaming). Model `eleven_flash_v2_5` is the low-latency default. Supports per-request `voiceId` and `outputFormat` overrides.

### Twilio (`voice-providers/twilio/`)

[`TwilioAdapter` class — overview](../voice-providers/twilio/src/index.ts#L1-L100) — bridges Twilio Media Streams (which send μ-law 8 kHz audio over WebSocket) to the `VoiceAgent` protocol (which expects 16 kHz PCM). Includes a full μ-law decode/encode table and translates Twilio lifecycle events (`connected`, `start`, `stop`) to the agent protocol.

[`TwilioAdapter` implementation — audio and lifecycle](../voice-providers/twilio/src/index.ts#L100-L389) — the full implementation: μ-law codec tables, the bidirectional audio conversion pipeline (Twilio sends μ-law 8 kHz base64-encoded; the pipeline decodes, resamples to 16 kHz, and delivers PCM to the agent), and the outgoing direction (agent audio is downsampled from 16 kHz to 8 kHz μ-law and re-encoded as Twilio Media Stream messages).

### Telnyx (`voice-providers/telnyx/`)

[Telnyx top-level exports](../voice-providers/telnyx/src/index.ts#L1-L20) — re-exports `TelnyxSTT`, `TelnyxTTS`, `TelnyxClient`, and `TelnyxJWTEndpoint`. The `browser` export provides WebRTC-based browser integration via `@telnyx/webrtc`.

[`TelnyxSTT` class in `providers/stt.ts`](../voice-providers/telnyx/src/providers/stt.ts#L1-L262) — Telnyx's streaming STT provider. Sends audio to the Telnyx WebSocket API and emits `TranscriptEvent` objects. Configurable model, language, and punctuation.

[`TelnyxTTS` — class setup, configuration, and synthesize() implementation](../voice-providers/telnyx/src/providers/tts.ts#L1-L300) and [`TelnyxTTS` — streaming synthesis and audio format helpers](../voice-providers/telnyx/src/providers/tts.ts#L301-L345) — Telnyx TTS. Implements both `TTSProvider` (full response) and `StreamingTTSProvider`. Supports multiple voices and audio formats.

[`TelnyxCallBridge` — class setup, constructor, and incoming call handling](../voice-providers/telnyx/src/providers/call-bridge.ts#L1-L300) and [`TelnyxCallBridge` — audio routing and call state machine](../voice-providers/telnyx/src/providers/call-bridge.ts#L301-L500) and [`TelnyxCallBridge` — lifecycle cleanup and media stream teardown](../voice-providers/telnyx/src/providers/call-bridge.ts#L501-L628) — the server-side bridge for Telnyx phone calls. Receives Telnyx webhook events, manages the call state machine (ringing → active → ended), and routes audio to the voice agent pipeline.

[`TelnyxPhoneClient` — class setup, auth, and outbound call initiation](../voice-providers/telnyx/src/phone-client.ts#L1-L300) and [`TelnyxPhoneClient` — inbound call handling, media streams, and cleanup](../voice-providers/telnyx/src/phone-client.ts#L301-L578) — the counterpart to `TelnyxCallBridge`: the Telnyx API client that places outbound calls, answers inbound calls, and manages media streams.

[`TelnyxJWTEndpoint` class in `server/jwt-endpoint.ts`](../voice-providers/telnyx/src/server/jwt-endpoint.ts#L1-L288) — generates short-lived JWTs for the browser WebRTC client. Browsers need a credential before they can connect to Telnyx's WebRTC infrastructure.

[Transport config helpers in `helpers/transport-config.ts`](../voice-providers/telnyx/src/helpers/transport-config.ts#L1-L119) — utility functions that build the correct WebSocket URL, credentials, and codec settings for different Telnyx transport modes.

[Phone transport in `transport/phone-transport.ts`](../voice-providers/telnyx/src/transport/phone-transport.ts#L1-L154) — the lower-level transport class used by `TelnyxCallBridge` to send and receive audio over Telnyx's media streams.

[Audio utilities in `audio/utils.ts`](../voice-providers/telnyx/src/audio/utils.ts#L1-L110) — audio format conversion helpers specific to Telnyx's requirements (sample rate conversion, codec negotiation).

[Browser WebRTC client in `browser.ts`](../voice-providers/telnyx/src/browser.ts#L1-L27) — thin re-export of the `@telnyx/webrtc` browser SDK with Telnyx-specific defaults applied.

[`TelnyxClient` class in `client.ts`](../voice-providers/telnyx/src/client.ts#L1-L22) — REST API client for Telnyx account management operations (creating SIP connections, configuring phone numbers, etc.).
