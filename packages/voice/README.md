# @cloudflare/voice

Voice pipeline for [Cloudflare Agents](https://github.com/cloudflare/agents) -- continuous STT, TTS, streaming, and real-time audio over WebSocket.

> **Experimental.** This API is under active development and will break between releases. Pin your version and expect to rewrite when upgrading.

## Install

```bash
npm install @cloudflare/voice
```

## Exports

| Export path                | What it provides                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@cloudflare/voice`        | Server-side mixins (`withVoice`, `withVoiceInput`), provider types, Workers AI providers, SFU utilities |
| `@cloudflare/voice/react`  | React hooks (`useVoiceAgent`, `useVoiceInput`)                                                          |
| `@cloudflare/voice/client` | Framework-agnostic `VoiceClient` class                                                                  |

## Server: full voice agent (`withVoice`)

Adds the complete voice pipeline: continuous STT, LLM turn handling, streaming TTS, interruption, and conversation persistence. When the transcriber reports speech start, the pipeline aborts active LLM/TTS work and tells the client to stop any queued playback so users can barge in before a final transcript is available.

```typescript
import { Agent } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type VoiceTurnContext
} from "@cloudflare/voice";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    return "Hello! I heard you say: " + transcript;
  }
}
```

`onTurn()` can also return streaming text, including AI SDK `textStream` values:

```typescript
import { streamText } from "ai";

async onTurn(transcript: string) {
  const result = streamText({
    model: myModel,
    system: "You are a helpful voice assistant. Keep replies short.",
    messages: [{ role: "user", content: transcript }]
  });

  return result.textStream;
}
```

### Provider properties

| Property      | Type          | Required | Description                      |
| ------------- | ------------- | -------- | -------------------------------- |
| `transcriber` | `Transcriber` | Yes      | Continuous per-call STT provider |
| `tts`         | `TTSProvider` | Yes      | Text-to-speech provider          |

### Lifecycle hooks

| Method                           | Description                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `onTurn(transcript, context)`    | **Required.** Handle a user utterance. Return `string` or `AsyncIterable<string>`.                             |
| `createTranscriber(connection)`  | Override to create a transcriber dynamically per connection.                                                   |
| `onCallStart(connection)`        | Called when a voice call begins.                                                                               |
| `onCallEnd(connection)`          | Called when a voice call ends.                                                                                 |
| `onInterrupt(connection)`        | Called when user interrupts playback, either from client audio-level detection or model-detected speech start. |
| `beforeCallStart(connection)`    | Return `false` to reject a call.                                                                               |
| `onMessage(connection, message)` | Handle non-voice WebSocket messages (voice protocol is intercepted automatically).                             |

### Pipeline hooks

| Method                                     | Description                                          |
| ------------------------------------------ | ---------------------------------------------------- |
| `afterTranscribe(transcript, connection)`  | Process transcript after STT. Return `null` to skip. |
| `beforeSynthesize(text, connection)`       | Process text before TTS. Return `null` to skip.      |
| `afterSynthesize(audio, text, connection)` | Process audio after TTS. Return `null` to skip.      |

### Convenience methods

- `speak(connection, text)` -- synthesize and send audio to one connection
- `speakAll(text)` -- synthesize and send audio to all connections
- `forceEndCall(connection)` -- programmatically end a call
- `saveMessage(role, content)` -- persist a message to conversation history
- `getConversationHistory()` -- retrieve conversation history from SQLite

## Server: voice input only (`withVoiceInput`)

STT-only mixin -- no TTS, no LLM. Use when you only need speech-to-text (e.g., dictation, transcription).

```typescript
import { Agent } from "agents";
import { withVoiceInput, WorkersAINova3STT } from "@cloudflare/voice";

const InputAgent = withVoiceInput(Agent);

export class DictationAgent extends InputAgent<Env> {
  transcriber = new WorkersAINova3STT(this.env.AI);

  onTranscript(text: string, connection: Connection) {
    console.log("User said:", text);
  }
}
```

## Client: React

```tsx
import { useVoiceAgent } from "@cloudflare/voice/react";

function App() {
  const {
    status, // "idle" | "listening" | "thinking" | "speaking"
    transcript, // TranscriptMessage[]
    interimTranscript, // string | null (real-time partial transcript)
    metrics, // VoicePipelineMetrics | null
    audioLevel, // number (0-1)
    isMuted, // boolean
    connected, // boolean
    error, // string | null
    startCall, // () => Promise<void>
    endCall, // () => void
    toggleMute, // () => void
    sendText, // (text: string) => void
    sendJSON // (data: Record<string, unknown>) => void
  } = useVoiceAgent({
    agent: "my-agent",
    // Set false to delay connecting until async prerequisites are ready.
    enabled: true
  });

  return <div>Status: {status}</div>;
}
```

When `enabled` is `false`, the hook does not create or connect a `VoiceClient`, returns the idle/disconnected state, and action callbacks such as `startCall()`, `sendText()`, and `sendJSON()` are safe no-ops. The first change from disabled to enabled connects with the current options without firing `onReconnect`; later connection identity changes while enabled do fire `onReconnect`.

For voice input only:

```tsx
import { useVoiceInput } from "@cloudflare/voice/react";

const { transcript, interimTranscript, isListening, start, stop, clear } =
  useVoiceInput({ agent: "DictationAgent" });
```

## Client: vanilla JavaScript

```typescript
import { VoiceClient } from "@cloudflare/voice/client";

const client = new VoiceClient({ agent: "my-agent" });

client.addEventListener("statuschange", () => console.log(client.status));
client.connect();
await client.startCall();
```

## Workers AI providers (built-in)

All default providers use Workers AI bindings -- no API keys required:

| Class               | Type           | Workers AI model      | Recommended for  |
| ------------------- | -------------- | --------------------- | ---------------- |
| `WorkersAIFluxSTT`  | Continuous STT | `@cf/deepgram/flux`   | `withVoice`      |
| `WorkersAINova3STT` | Continuous STT | `@cf/deepgram/nova-3` | `withVoiceInput` |
| `WorkersAITTS`      | TTS            | `@cf/deepgram/aura-1` | Both             |

`WorkersAIFluxSTT` uses Flux `StartOfTurn` events for low-latency barge-in and `EndOfTurn` events for final utterances. Custom transcribers can provide the same behavior by calling `onSpeechStart` from `TranscriberSessionOptions` when user speech begins, then `onUtterance` when the turn is complete.

## Third-party providers

| Package                        | What it provides                         |
| ------------------------------ | ---------------------------------------- |
| `@cloudflare/voice-deepgram`   | Continuous STT (Deepgram Nova)           |
| `@cloudflare/voice-elevenlabs` | TTS (ElevenLabs)                         |
| `@cloudflare/voice-twilio`     | Telephony adapter (Twilio Media Streams) |

## Related

- [`examples/voice-agent`](../../examples/voice-agent) -- full voice agent example
- [`examples/voice-input`](../../examples/voice-input) -- voice input (dictation) example
