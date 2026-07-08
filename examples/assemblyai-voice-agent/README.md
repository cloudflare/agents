# Luna Rossa — AssemblyAI Voice Reservation Agent

A real-time phone-style reservation desk for a (fictional) Italian restaurant, running entirely inside a Durable Object with [AssemblyAI Universal 3.5 Pro Realtime](https://www.assemblyai.com/docs/speech-to-text/streaming) speech-to-text. Book a table by voice: the agent asks one question at a time, checks availability, reads your reservation back, and gives you a confirmation code — with streaming responses, interruption (barge-in) support, and reservations that persist across calls.

The reservation flow is deliberately the hard case for conversational STT: terse answers right after an agent question ("four", "Friday", "seven thirty", a spelled-out name). Two AssemblyAI features carry it:

- **`agent_context` carryover** — after each spoken reply, `withVoice` feeds the agent's words back to AssemblyAI automatically, so the model knows the question you're answering ("table for **four** at **seven**", not "table **for** Four at Seven").
- **`prompt` + `keyterms`** — the transcriber is told this is a restaurant-reservation call and taught the venue's vocabulary (`cacio e pepe`, `branzino`), so menu talk transcribes cleanly. See the constructor in `src/server.ts`.

The stack:

- **STT**: AssemblyAI `universal-3-5-pro` via [`@cloudflare/voice-assemblyai`](../../voice-providers/assemblyai) — turn detection + barge-in server-side
- **TTS**: Cartesia `sonic-3.5` via a small in-example `TTSProvider` adapter (see `CartesiaTTS` in `src/server.ts` for the bring-your-own-vendor pattern)
- **LLM**: OpenAI `gpt-4.1-mini` via the AI SDK, with reservation tools: `check_availability`, `create_reservation`, `find_reservation`, `cancel_reservation`, `get_menu_highlights`
- **Storage**: reservations live in the Durable Object's SQLite — call back later and the agent greets you as a returning caller
- **Transport**: plain WebSocket (browser mic → 16 kHz PCM frames) via the `useVoiceAgent` React hook — no SFU/WebRTC credentials needed

## Run it

You need an [AssemblyAI API key](https://www.assemblyai.com/app/api-keys) for STT, an [OpenAI API key](https://platform.openai.com/api-keys) for the LLM, and a [Cartesia API key](https://play.cartesia.ai/keys) for TTS. No Cloudflare login is needed for local dev — the example uses no remote bindings.

```bash
# from the repo root
cp examples/assemblyai-voice-agent/.dev.vars.example examples/assemblyai-voice-agent/.dev.vars
# edit .dev.vars and set ASSEMBLYAI_API_KEY, OPENAI_API_KEY, and CARTESIA_API_KEY

npm install
npm start --workspace examples/assemblyai-voice-agent
```

Open the local URL, press **Start call**, allow the microphone, and start talking. You can also type a message instead of speaking.

### Try this call

> **You:** I'd like a table for four this Friday at seven.
> **Agent:** _checks availability_ … "Seven is open on Friday. What name should I put it under?"
> **You:** Lange. L-A-N-G-E.
> **Agent:** "A table for four this Friday at seven under Lange — shall I book it?"
> **You:** Yes.
> **Agent:** "You're all set! Your confirmation code is L-R, one-zero-zero-one."

Then hang up, call again, and ask "can you look up my reservation?" — it's still there. Ask "what's on the menu tonight?" to hear the keyterms-boosted dishes, or interrupt the agent mid-sentence to feel the barge-in.

## How it works

```
Browser                          Durable Object (AssemblyAIVoiceAgent)
┌──────────┐   binary WS frames   ┌──────────────────────────┐
│ Mic PCM  │ ────────────────────► │ Audio Buffer             │
│ (16kHz)  │                       │   ↓                      │
│          │                       │ AssemblyAI STT (u3.5-pro) │
│          │   JSON: transcript    │   ↓                      │
│          │ ◄──────────────────── │ LLM (gpt-4.1-mini, tools)│
│          │   binary: audio       │   ↓ (sentence chunking)  │
│ Speaker  │ ◄──────────────────── │ TTS (Cartesia, per-sent.)│
└──────────┘                       └──────────────────────────┘
              single WebSocket connection
```

1. The browser captures mic audio via an AudioWorklet and downsamples to 16 kHz mono PCM.
2. PCM streams to the agent over the WebSocket as binary frames.
3. AssemblyAI detects speech start (`SpeechStarted` → barge-in) and turn completion (`Turn` with `end_of_turn`) server-side.
4. On each completed turn the agent runs the voice pipeline: STT → LLM (with reservation tools against the DO's SQLite) → TTS.
5. TTS audio comes back sentence-by-sentence while the LLM is still generating; the browser plays it and you can interrupt at any time.
6. After the agent speaks, `withVoice` feeds the spoken reply back to AssemblyAI as `agent_context`, so short or contextual next answers (e.g. "yes", "seven thirty", a spelled name) are transcribed more accurately.

## Notes

- **Tuning** — pass `mode` (`"min_latency"` / `"balanced"` / `"max_accuracy"`) or `voiceFocus` noise suppression to the `AssemblyAISTT` constructor in `src/server.ts`; this example already sets `prompt` and `keyterms`. See the [provider options](../../voice-providers/assemblyai#options) for the full list.
- **Agent context** — fed automatically by the pipeline (step 6). It's a `universal-3-5-pro` feature; no configuration needed.
- **Reservation persistence** — reservations (and conversation history) are stored in the Durable Object's SQLite and survive restarts, per agent instance.
- **`useVoiceAgent` hook** — the client uses the React hook from `@cloudflare/voice/react`, which encapsulates mic capture, playback, and the voice protocol.
