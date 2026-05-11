# Voice Agent

A real-time voice agent running entirely inside a Durable Object. Talk to an AI assistant that can answer questions, set spoken reminders, and check the weather — with streaming responses, interruption support, and conversation memory across sessions.

Uses Workers AI for all models — zero external API keys required:

- **STT**: Deepgram Flux (`@cf/deepgram/flux`) by default, with a Nova 3 (`@cf/deepgram/nova-3`) option in the UI
- **TTS**: Deepgram Aura (`@cf/deepgram/aura-1`)
- **Turn detection**: Flux `StartOfTurn` / `EndOfTurn` events
- **LLM**: Kimi K2.6 (`@cf/moonshotai/kimi-k2.6`), GPT OSS 20B, or GLM 4.7 Flash

## Run it

```bash
npm install
npm run start
```

No API keys needed — all AI models run via the Workers AI binding.

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
3. Flux detects speech start and turn completion server-side
4. Agent runs the voice pipeline: STT → LLM (with tools) → streaming TTS
5. TTS audio streams back per-sentence as MP3 while the LLM is still generating
6. Browser decodes and plays audio; user can interrupt at any time

## Features

- **Streaming TTS** — LLM output is split into sentences and synthesized concurrently, so the user hears the first sentence while the rest is still being generated.
- **Interruption handling** — speak over the agent to cut it off mid-sentence. Flux speech-start events abort the server pipeline and stop queued browser playback; client audio-level detection remains as a fallback.
- **Server-side turn detection** — Flux handles speech boundaries, so the example does not need client-side end-of-speech signaling to run the voice pipeline.
- **Conversation persistence** — all messages are stored in SQLite and survive restarts. The agent remembers previous conversations.
- **Agent tools** — the LLM can call `get_current_time`, `set_reminder`, and `get_weather` during conversation.
- **Proactive scheduling** — reminders set via voice fire on schedule and are spoken to connected clients (or saved to history if disconnected).
- **`useVoiceAgent` hook** — the client uses the `agents/voice-react` hook, which encapsulates all audio infrastructure in ~10 lines of setup.
