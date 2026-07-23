# Voice Agent

A real-time voice agent running entirely inside a Durable Object. Talk to an AI assistant that can answer questions, set spoken reminders, and check the weather — with streaming responses, interruption support, and conversation memory across sessions.

Uses Workers AI by default, so it runs with zero external API keys. The STT
provider selector can also route the same voice pipeline through AssemblyAI,
Telnyx, or ElevenLabs when their API keys are configured:

- **STT**: Workers AI Flux (`@cf/deepgram/flux`) by default, Workers AI Nova 3 (`@cf/deepgram/nova-3`), AssemblyAI Universal 3.5 Pro Realtime, Telnyx STT, or ElevenLabs Scribe v2 Realtime
- **TTS**: Deepgram Aura (`@cf/deepgram/aura-1`)
- **Turn detection**: Flux `StartOfTurn` / `EndOfTurn` events
- **LLM**: Kimi K2.7 Code (`@cf/moonshotai/kimi-k2.7-code`), GPT OSS 20B, or GLM 4.7 Flash

## Run it

```bash
npm install
npm run start
```

No API keys are needed for the default Workers AI STT/TTS/LLM path. To try
external STT providers, copy `.env.example` to `.env` and set the relevant key:

```bash
ASSEMBLYAI_API_KEY=...
TELNYX_API_KEY=...
ELEVENLABS_API_KEY=...
```

## How it works

```
Browser                          Durable Object (VoiceAgent)
┌──────────┐   binary WS frames   ┌──────────────────────────┐
│ Mic PCM  │ ────────────────────► │ Audio Buffer             │
│ (16kHz)  │                       │   ↓                      │
│          │                       │ STT (flux)               │
│          │                       │   ↓                      │
│          │   JSON: transcript    │   ↓                      │
│          │ ◄──────────────────── │ LLM                      │
│          │   binary: MP3 audio   │   ↓ (sentence chunking)  │
│ Speaker  │ ◄──────────────────── │ TTS (aura-1, streaming)  │
└──────────┘                       └──────────────────────────┘
              single WebSocket connection
```

1. Browser captures mic audio via AudioWorklet, downsamples to 16kHz mono PCM
2. PCM streams to the Agent over the existing WebSocket connection (binary frames)
3. The selected STT provider detects speech and turn completion server-side
4. Agent runs the voice pipeline: STT → LLM (with tools) → streaming TTS
5. TTS audio streams back per-sentence as MP3 while the LLM is still generating
6. Browser decodes and plays audio through the selected speaker when supported; user can interrupt at any time

## Features

- **Streaming TTS** — LLM output is split into sentences and synthesized concurrently, so the user hears the first sentence while the rest is still being generated.
- **Interruption handling** — speak over the agent to cut it off mid-sentence. Flux speech-start events abort the server pipeline and stop queued browser playback; client audio-level detection remains as a fallback.
- **Provider selector** — choose Workers AI, AssemblyAI, Telnyx, or ElevenLabs STT without changing the agent code.
- **Server-side turn detection** — the selected STT provider handles speech boundaries, so the example does not need client-side end-of-speech signaling to run the voice pipeline.
- **Provider tuning** — AssemblyAI exposes latency/accuracy mode, Voice Focus, context prompt, and keyterms; Telnyx exposes model/language; ElevenLabs exposes Scribe cleanup, background filtering, and keyterms.
- **Speaker selection** — choose an audio output device for assistant playback. Unsupported browsers keep using the system default output.
- **Conversation persistence** — all messages are stored in SQLite and survive restarts. The agent remembers previous conversations.
- **Agent tools** — the LLM can call `get_current_time`, `set_reminder`, and `get_weather` during conversation.
- **Proactive scheduling** — reminders set via voice fire on schedule and are spoken to connected clients (or saved to history if disconnected).
- **`useVoiceAgent` hook** — the client uses the `agents/voice-react` hook, which encapsulates all audio infrastructure in ~10 lines of setup.
