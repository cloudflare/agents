# Voice Agent

A real-time voice agent running entirely inside a Durable Object. Talk to an AI assistant that can answer questions, set spoken reminders, and check the weather — with streaming responses, interruption support, and conversation memory across sessions.

Uses Workers AI for all models — zero external API keys required:

- **STT**: Deepgram Nova 3 (`@cf/deepgram/nova-3`)
- **TTS**: Deepgram Aura (`@cf/deepgram/aura-1`)
- **VAD**: Pipecat Smart Turn v2 (`@cf/pipecat-ai/smart-turn-v2`)
- **LLM**: Llama 4 Scout (`@cf/meta/llama-4-scout-17b-16e-instruct`)

## Run it

```bash
npm install
npm run dev
```

No API keys needed — all AI models run via the Workers AI binding.

## How it works

```
Browser                          Durable Object (VoiceAgent)
┌──────────┐   binary WS frames   ┌──────────────────────────┐
│ Mic PCM  │ ────────────────────► │ Audio Buffer             │
│ (16kHz)  │                       │   ↓                      │
│          │   JSON: end_of_speech │ VAD (smart-turn-v2)      │
│          │ ────────────────────► │   ↓                      │
│          │                       │ STT (nova-3)             │
│          │   JSON: transcript    │   ↓                      │
│          │ ◄──────────────────── │ LLM (llama-4-scout)      │
│          │   binary: MP3 audio   │   ↓ (sentence chunking)  │
│ Speaker  │ ◄──────────────────── │ TTS (aura-1, streaming)  │
└──────────┘                       └──────────────────────────┘
              single WebSocket connection
```

1. Browser captures mic audio via AudioWorklet, downsamples to 16kHz mono PCM
2. PCM streams to the Agent over the existing WebSocket connection (binary frames)
3. Client-side silence detection (500ms) triggers end-of-speech
4. Server-side VAD (smart-turn-v2) confirms the user finished speaking
5. Agent runs the voice pipeline: STT → LLM (with tools) → streaming TTS
6. TTS audio streams back per-sentence as MP3 while the LLM is still generating
7. Browser decodes and plays audio; user can interrupt at any time

## Features

- **Streaming TTS** — LLM output is split into sentences and synthesized concurrently, so the user hears the first sentence while the rest is still being generated.
- **Interruption handling** — speak over the agent to cut it off mid-sentence. The client detects sustained speech during playback and aborts the server pipeline.
- **Server-side VAD** — `smart-turn-v2` validates end-of-speech after client silence detection, reducing false triggers on mid-sentence pauses.
- **Conversation persistence** — all messages are stored in SQLite and survive restarts. The agent remembers previous conversations.
- **Agent tools** — the LLM can call `get_current_time`, `set_reminder`, and `get_weather` during conversation.
- **Proactive scheduling** — reminders set via voice fire on schedule and are spoken to connected clients (or saved to history if disconnected).
- **`useVoiceAgent` hook** — the client uses the `agents/voice-react` hook, which encapsulates all audio infrastructure in ~10 lines of setup.
