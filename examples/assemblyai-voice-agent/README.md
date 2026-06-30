# AssemblyAI Voice Agent

A real-time voice agent running entirely inside a Durable Object, using [AssemblyAI Universal 3.5 Pro Realtime](https://www.assemblyai.com/docs/speech-to-text/streaming) for speech-to-text. Talk to an AI assistant that can answer questions, set spoken reminders, and check the weather — with streaming responses, interruption (barge-in) support, and conversation memory across sessions.

- **STT**: AssemblyAI `universal-3-5-pro` via [`@cloudflare/voice-assemblyai`](../../voice-providers/assemblyai) — turn detection + barge-in server-side, with `agent_context` carryover fed from the agent's spoken replies
- **TTS**: Workers AI (MeloTTS, `@cf/myshell-ai/melotts`) — runs on the AI binding, no extra API key
- **LLM**: Workers AI (`@cf/zai-org/glm-4.7-flash`), with `get_current_time` / `set_reminder` / `get_weather` tools
- **Transport**: plain WebSocket (browser mic → 16 kHz PCM frames) via the `useVoiceAgent` React hook — no SFU/WebRTC credentials needed

## Run it

You need an [AssemblyAI API key](https://www.assemblyai.com/app/api-keys). The LLM and TTS run on the Workers AI binding, so no other keys are required.

```bash
# from the repo root
cp examples/assemblyai-voice-agent/.dev.vars.example examples/assemblyai-voice-agent/.dev.vars
# edit .dev.vars and set ASSEMBLYAI_API_KEY=...

npm install
npm start --workspace examples/assemblyai-voice-agent
```

Open the local URL, press **Start call**, allow the microphone, and start talking. You can also type a message instead of speaking.

## How it works

```
Browser                          Durable Object (AssemblyAIVoiceAgent)
┌──────────┐   binary WS frames   ┌──────────────────────────┐
│ Mic PCM  │ ────────────────────► │ Audio Buffer             │
│ (16kHz)  │                       │   ↓                      │
│          │                       │ AssemblyAI STT (u3.5-pro) │
│          │   JSON: transcript    │   ↓                      │
│          │ ◄──────────────────── │ LLM (Workers AI, tools)  │
│          │   binary: audio       │   ↓ (sentence chunking)  │
│ Speaker  │ ◄──────────────────── │ TTS (MeloTTS, per-sent.) │
└──────────┘                       └──────────────────────────┘
              single WebSocket connection
```

1. The browser captures mic audio via an AudioWorklet and downsamples to 16 kHz mono PCM.
2. PCM streams to the agent over the WebSocket as binary frames.
3. AssemblyAI detects speech start (`SpeechStarted` → barge-in) and turn completion (`Turn` with `end_of_turn`) server-side.
4. On each completed turn the agent runs the voice pipeline: STT → LLM (with tools) → TTS.
5. TTS audio comes back sentence-by-sentence while the LLM is still generating; the browser plays it and you can interrupt at any time.
6. After the agent speaks, `withVoice` feeds the spoken reply back to AssemblyAI as `agent_context`, so short or contextual next answers (e.g. "yes", "7pm", an email) are transcribed more accurately.

## Notes

- **Tuning** — pass `mode` (`"min_latency"` / `"balanced"` / `"max_accuracy"`), `voiceFocus` noise suppression, or a `prompt` to the `AssemblyAISTT` constructor in `src/server.ts`. See the [provider options](../../voice-providers/assemblyai#options) for the full list.
- **Agent context** — fed automatically by the pipeline (step 6). It's a `universal-3-5-pro` feature; no configuration needed.
- **Conversation persistence** — messages are stored in SQLite and survive restarts; the agent remembers previous conversations per instance.
- **`useVoiceAgent` hook** — the client uses the React hook from `@cloudflare/voice/react`, which encapsulates mic capture, playback, and the voice protocol.
