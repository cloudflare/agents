<p align="center">
  <a href="https://elevenlabs.io"><img src="https://img.shields.io/badge/ElevenLabs-000?logo=data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMzIgMzIiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3QgeD0iMTEiIHk9IjQiIHdpZHRoPSIzLjUiIGhlaWdodD0iMjQiIHJ4PSIxLjc1IiBmaWxsPSJ3aGl0ZSIvPjxyZWN0IHg9IjE3LjUiIHk9IjQiIHdpZHRoPSIzLjUiIGhlaWdodD0iMjQiIHJ4PSIxLjc1IiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==&logoColor=white&style=for-the-badge" alt="ElevenLabs" height="28"/></a>
  <span>&nbsp;×&nbsp;</span>
  <a href="https://developers.cloudflare.com/agents/"><img src="https://img.shields.io/badge/Cloudflare_Agents-F38020?logo=cloudflare&logoColor=white&style=for-the-badge" alt="Cloudflare Agents" height="28"/></a>
</p>

# ElevenLabs × Cloudflare Agents

Hackathon starter kit combining [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) with [ElevenLabs](https://elevenlabs.io/) APIs. Four demos in one app — voice chat with speech-to-text, soundscape generation, AI character creation, and music composition.

## Quick start

```bash
npm install
```

Create a `.env` file with your ElevenLabs API key (get one free at [elevenlabs.io](https://elevenlabs.io/)):

```
ELEVENLABS_API_KEY=your-key-here
```

```bash
npm start
```

Open [http://localhost:5173](http://localhost:5173).

## Demos

### Voice Chat

AI chat agent powered by Workers AI. Every response is automatically spoken aloud via ElevenLabs TTS. Tap the mic to speak — audio streams to ElevenLabs Realtime STT via a WebSocket proxy through the agent, with live partial transcripts as you talk. Pick from available ElevenLabs voices.

**ElevenLabs APIs:** Text-to-Speech, Realtime Speech-to-Text, Voice Search

### Soundscape Builder

Describe a scene and the AI expands it into narration + ambient sound effect prompts. ElevenLabs generates the narration (TTS) and each ambient layer (Sound Effects API) in parallel. Play them together to hear the full scene.

**ElevenLabs APIs:** Text-to-Speech, Text-to-Sound-Effects

### Character Creator

Design a custom AI character in two steps: describe a personality (Workers AI generates a system prompt) and a voice (ElevenLabs Voice Design generates previews). Pick your favorite voice, name the character, then chat with them — every response spoken in the custom voice.

**ElevenLabs APIs:** Voice Design, Voice Creation, Text-to-Speech

### Music Studio

Compose original music from a text prompt. Choose duration (15s–2min), toggle instrumental mode, and ElevenLabs generates a full track. Build a library of saved tracks.

**ElevenLabs APIs:** Music Composition

## Project structure

```
src/
  server.ts              # Worker entry — exports agents, routes requests
  agents/
    voice-chat.ts        # AIChatAgent + TTS + realtime STT WebSocket proxy
    soundscape.ts        # Agent with scene expansion + SFX generation
    character.ts         # AIChatAgent with voice design + character chat
    music.ts             # Agent with music composition + track library
  lib/
    elevenlabs.ts        # Shared client factory + audio encoding
  components/
    audio-player.tsx     # Reusable play/speak buttons
  tabs/
    voice-chat.tsx       # Chat UI with mic input + auto-speak
    soundscape.tsx       # Scene builder with layered audio
    character.tsx        # Two-phase: design then chat
    music.tsx            # Compose + library UI
  app.tsx                # Tab shell
  client.tsx             # React entry
  styles.css             # Tailwind + Kumo
```

## Agents SDK features used

- **`AIChatAgent`** — persistent AI chat with streaming (Voice Chat, Character)
- **`Agent`** — stateful Durable Object with RPC (Soundscape, Music)
- **`@callable()`** — typed server methods callable from the browser
- **`setState` / `useAgent`** — real-time state sync between agent and UI
- **`useAgentChat`** — React hook for chat with streaming, history, and stop/resume
- **`onMessage`** — custom WebSocket message handling for audio chunk streaming

## Hackathon ideas

- **Text-to-Dialogue** — use `textToDialogue.convert` to generate multi-speaker podcasts
- **Speech-to-Speech** — record yourself and transform into a character voice
- **Dubbing** — transcribe → translate → re-voice in another language
- **Collaborative soundscapes** — multiple users build a scene via shared agent name
- **Character gallery** — save and share characters via URL
- **AI DJ** — compose mood-appropriate background music during conversations

## Deploy

```bash
npx wrangler r2 bucket create elevenlabs-audio
npx wrangler secret put ELEVENLABS_API_KEY
npm run deploy
```

## Links

- [Agents SDK docs](https://developers.cloudflare.com/agents/)
- [ElevenLabs API reference](https://elevenlabs.io/docs/api-reference)
- [ElevenLabs JS SDK](https://github.com/elevenlabs/elevenlabs-js)
