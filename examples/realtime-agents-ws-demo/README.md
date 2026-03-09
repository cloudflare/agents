# Realtime Agents WebSocket Demo

A voice-agent demo based on `agents-starter`, but wired for realtime audio over WebSockets. It follows the same core `RealtimeAgent` pattern as `examples/realtime-agents`, except both input audio and output audio/transcripts flow through agent WebSocket messages instead of a meeting transport.

## What it demonstrates

**Server (`src/server.ts`):**

- `RealtimeAgent` pipeline with `WebSocketTransport` on both ends
- `DeepgramSTT` for speech-to-text and `ElevenLabsTTS` for text-to-speech
- `onRealtimeTranscript()` to run LLM inference and return `SpeakResponse`
- Client-only transcript events (`client` + `agent`) broadcast over the agent socket

**Client (`src/app.tsx`):**

- `useAgent` WebSocket session for bidirectional realtime events
- Push-to-talk mic capture that streams PCM chunks as `media` messages
- Audio playback queue for streamed agent voice responses
- Pipeline lifecycle controls (`/realtime/start` and `/realtime/stop`) and live status UI

**Audio helpers (`src/hooks/*`, `src/utils/*`):**

- Browser mic capture with `AudioContext` + base64 encoding
- PCM s16le decode/encode utilities for transport compatibility
- Small reusable helpers for audio byte conversion and WAV utilities

## Running

1. Create a `.env` file in this directory from `.env.example`:

```env
DEEPGRAM_API_KEY=your-deepgram-api-key
ELEVENLABS_API_KEY=your-elevenlabs-api-key
```

2. From the repo root:

```bash
npm install
npm run build
```

3. From this directory:

```bash
npm start
```

Then open `http://localhost:5173`, allow microphone access, start the pipeline, and hold the mic button to speak.

## Voice pipeline

```text
Browser Mic -> WebSocketTransport -> DeepgramSTT -> RealtimeAgent -> ElevenLabsTTS -> WebSocketTransport -> Browser Audio
```

## Try it

- Start pipeline, then say: "Hi, can you introduce yourself?"
- Ask a short factual question and confirm spoken replies stream back
- Watch transcriptions appear for both "You (voice)" and "Agent (voice)"
- Toggle debug mode to inspect connection and pipeline state

## Related examples

- `examples/realtime-agents/README.md` - realtime agent architecture and callbacks
- `cloudflare/agents-starter` - base starter template this demo was adapted from
