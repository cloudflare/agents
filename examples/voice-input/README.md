# Voice Input

Voice-to-text dictation example using the `useVoiceInput` hook from `@cloudflare/voice`.

Captures microphone audio, streams it to an Agent Durable Object for real-time speech-to-text using Workers AI, and displays the transcript in a text area.

## Run it

```bash
npm install && npm start
```

No API keys needed — uses Workers AI (bound via `wrangler.jsonc`).

## How it works

### Server (`src/server.ts`)

Uses `withVoiceInput` — a lightweight mixin that only does STT. No TTS provider, no `onTurn` handler needed:

```typescript
import { Agent } from "agents";
import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";

const InputAgent = withVoiceInput(Agent);

export class VoiceInputAgent extends InputAgent<Env> {
  transcriber = new WorkersAINova3STT(this.env.AI);

  onTranscript(text, connection) {
    console.log("User said:", text);
  }
}
```

### Client (`src/client.tsx`)

Uses `useVoiceInput` — a lightweight React hook that accumulates transcripts into a single string:

```tsx
import { useVoiceInput } from "@cloudflare/voice/react";

const { transcript, interimTranscript, isListening, start, stop, clear } =
  useVoiceInput({ agent: "VoiceInputAgent" });
```

Returns:

- **`transcript`** — accumulated final text from all utterances
- **`interimTranscript`** — real-time partial transcript (updates as you speak)
- **`isListening`** — whether the mic is active
- **`audioLevel`** — current audio level for visual feedback
- **`start()` / `stop()`** — control listening
- **`toggleMute()`** — mute without stopping
- **`clear()`** — reset the transcript

## Related

- [`examples/playground`](../playground) — full voice agent with conversation
- [`@cloudflare/voice`](../../packages/voice) — the voice package
