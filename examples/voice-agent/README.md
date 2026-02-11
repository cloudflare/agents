# Voice Agent

A voice agent demo showing real-time audio conversation with an AI, running entirely inside a Durable Object. Uses Workers AI for speech-to-text (Deepgram Nova), text generation (Llama 3.1), and text-to-speech (Deepgram Aura) — zero external API keys required.

## How it works

1. Browser captures mic audio via AudioWorklet, downsamples to 16kHz mono PCM
2. PCM streams to the Agent over the existing WebSocket connection (binary frames)
3. Client-side silence detection signals end-of-speech
4. Agent runs the voice pipeline: STT → LLM → TTS
5. TTS audio (MP3) streams back over the same WebSocket
6. Browser decodes and plays the audio

The entire pipeline runs inside a single Durable Object. The agent has access to persistent state, SQL, scheduling, and MCP tools — everything the Agents SDK provides.

## Run it

```bash
npm install
npm run start
```

No API keys needed — all AI models run via the Workers AI binding.

## Architecture

```
Browser                          Durable Object (VoiceAgent)
┌──────────┐   binary WS frames   ┌──────────────────────┐
│ Mic PCM  │ ────────────────────► │ Audio Buffer         │
│ (16kHz)  │                       │   ↓                  │
│          │   JSON: end_of_speech │ STT (nova-3)         │
│          │ ────────────────────► │   ↓                  │
│          │                       │ LLM (llama-3.1)      │
│          │   JSON: transcript    │   ↓                  │
│          │ ◄──────────────────── │ TTS (aura-1)         │
│          │   binary: MP3 audio   │   ↓                  │
│ Speaker  │ ◄──────────────────── │ Audio response       │
└──────────┘                       └──────────────────────┘
              single WebSocket connection
```
