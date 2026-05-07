# Voice Agents

Build real-time voice agents with speech-to-text, text-to-speech, and conversation persistence. Audio streams over WebSocket — no SFU or meeting infrastructure required.

## Overview

`@cloudflare/voice` provides two server-side mixins and matching React hooks:

| Export           | Import                     | Purpose                                      |
| ---------------- | -------------------------- | -------------------------------------------- |
| `withVoice`      | `@cloudflare/voice`        | Full voice agent: STT, LLM, TTS, persistence |
| `withVoiceInput` | `@cloudflare/voice`        | STT-only: transcription without response     |
| `useVoiceAgent`  | `@cloudflare/voice/react`  | React hook for `withVoice` agents            |
| `useVoiceInput`  | `@cloudflare/voice/react`  | React hook for `withVoiceInput` agents       |
| `VoiceClient`    | `@cloudflare/voice/client` | Framework-agnostic client                    |

Built on Cloudflare Durable Objects, you get:

- **Real-time audio** — mic audio streams as binary WebSocket frames, TTS audio streams back
- **Automatic conversation persistence** — messages stored in SQLite, survive restarts
- **Streaming TTS** — LLM tokens are sentence-chunked and synthesized concurrently
- **Interruption handling** — user speech during playback cancels the current response
- **Continuous STT** — per-call transcriber session, model handles turn detection
- **Pipeline hooks** — intercept and transform text at every stage

> **Experimental.** This API is under active development and will break between releases. Pin your version.

## Quick Start

### Install

```sh
npm install @cloudflare/voice agents
```

### Server

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

### Client (React)

```tsx
import { useVoiceAgent } from "@cloudflare/voice/react";

function VoiceUI() {
  const {
    status,
    transcript,
    interimTranscript,
    audioLevel,
    isMuted,
    startCall,
    endCall,
    toggleMute
  } = useVoiceAgent({ agent: "MyAgent" });

  return (
    <div>
      <p>Status: {status}</p>

      <button onClick={status === "idle" ? startCall : endCall}>
        {status === "idle" ? "Start Call" : "End Call"}
      </button>

      <button onClick={toggleMute}>{isMuted ? "Unmute" : "Mute"}</button>

      {interimTranscript && (
        <p>
          <em>{interimTranscript}</em>
        </p>
      )}

      {transcript.map((msg, i) => (
        <p key={i}>
          <strong>{msg.role}:</strong> {msg.text}
        </p>
      ))}
    </div>
  );
}
```

### Wrangler Config

```jsonc
// wrangler.jsonc
{
  "ai": { "binding": "AI" },
  "durable_objects": {
    "bindings": [{ "name": "MyAgent", "class_name": "MyAgent" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyAgent"] }]
}
```

## How It Works

```
Browser                              Durable Object (withVoice)
┌──────────┐                         ┌──────────────────────────┐
│ Mic      │   binary PCM (16kHz)    │ Transcriber session      │
│          │ ──────────────────────► │ (per-call, continuous)   │
│          │                         │   ↓ model detects turn   │
│          │   JSON: transcript      │ onTurn() → your LLM code │
│          │ ◄────────────────────── │   ↓ (sentence chunking)  │
│          │   binary: audio         │ TTS                      │
│ Speaker  │ ◄────────────────────── │                          │
└──────────┘                         └──────────────────────────┘
```

1. The client captures mic audio and sends it as binary WebSocket frames (16kHz mono 16-bit PCM)
2. Audio streams continuously to the transcriber session (created at `start_call`, lives for the entire call)
3. The STT model detects when the user finishes an utterance and fires `onUtterance`
4. Your `onTurn()` method runs — typically an LLM call
5. The response is sentence-chunked and synthesized via TTS
6. Audio streams back to the client for playback

## Server API: `withVoice`

`withVoice(Agent)` adds the full voice pipeline to an Agent class.

### Providers

Set providers as class properties. Class field initializers run after `super()`, so `this.env` is available.

| Property      | Type          | Required | Description                      |
| ------------- | ------------- | -------- | -------------------------------- |
| `transcriber` | `Transcriber` | Yes      | Continuous per-call STT provider |
| `tts`         | `TTSProvider` | Yes      | Text-to-speech                   |

```typescript
import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "@cloudflare/voice";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);
}
```

For runtime model switching (e.g. Flux vs Nova 3 dropdown), override `createTranscriber`:

```typescript
export class MyAgent extends VoiceAgent<Env> {
  tts = new WorkersAITTS(this.env.AI);

  createTranscriber(connection: Connection): Transcriber {
    return new WorkersAIFluxSTT(this.env.AI);
  }
}
```

### `onTurn(transcript, context)`

**Required.** Called when the user finishes speaking and the transcript is ready.

Return a `string`, `AsyncIterable<string>`, or `ReadableStream` for streaming responses:

**Simple response:**

```typescript
async onTurn(transcript: string, context: VoiceTurnContext) {
  return "You said: " + transcript;
}
```

**Streaming response (recommended for LLM):**

```typescript
import { streamText, convertToModelMessages } from "ai";
import { createWorkersAI } from "workers-ai-provider";

async onTurn(transcript: string, context: VoiceTurnContext) {
  const workersai = createWorkersAI({ binding: this.env.AI });

  const result = streamText({
    model: workersai("@cf/moonshotai/kimi-k2.6"),
    system: "You are a helpful voice assistant. Keep responses concise.",
    messages: [
      ...context.messages.map(m => ({
        role: m.role as "user" | "assistant",
        content: m.content
      })),
      { role: "user", content: transcript }
    ],
    abortSignal: context.signal
  });

  return result.textStream;
}
```

The `context` object provides:

| Field        | Type                                       | Description                        |
| ------------ | ------------------------------------------ | ---------------------------------- |
| `connection` | `Connection`                               | The WebSocket connection           |
| `messages`   | `Array<{ role: string; content: string }>` | Conversation history from SQLite   |
| `signal`     | `AbortSignal`                              | Aborted on interrupt or disconnect |

### Lifecycle Hooks

| Method                        | Description                                 |
| ----------------------------- | ------------------------------------------- |
| `beforeCallStart(connection)` | Return `false` to reject the call           |
| `onCallStart(connection)`     | Called after a call is accepted             |
| `onCallEnd(connection)`       | Called when a call ends                     |
| `onInterrupt(connection)`     | Called when user interrupts during playback |

### Pipeline Hooks

Intercept and transform data at each pipeline stage. Return `null` to skip the current utterance.

| Method                                     | Receives        | Can skip? |
| ------------------------------------------ | --------------- | --------- |
| `afterTranscribe(transcript, connection)`  | STT text        | Yes       |
| `beforeSynthesize(text, connection)`       | Text before TTS | Yes       |
| `afterSynthesize(audio, text, connection)` | Audio after TTS | Yes       |

```typescript
export class MyAgent extends VoiceAgent<Env> {
  // Filter out short/noise transcripts
  afterTranscribe(transcript: string, connection: Connection) {
    if (transcript.length < 3) return null; // skip
    return transcript;
  }

  // Add SSML or modify text before TTS
  beforeSynthesize(text: string, connection: Connection) {
    return text.replace(/\bAI\b/g, "A.I."); // improve pronunciation
  }
}
```

### Convenience Methods

| Method                     | Description                                  |
| -------------------------- | -------------------------------------------- |
| `speak(connection, text)`  | Synthesize and send audio to one connection  |
| `speakAll(text)`           | Synthesize and send audio to all connections |
| `forceEndCall(connection)` | Programmatically end a call                  |
| `saveMessage(role, text)`  | Persist a message to conversation history    |
| `getConversationHistory()` | Retrieve conversation history from SQLite    |

### Configuration Options

Pass options to `withVoice()` as the second argument:

```typescript
const VoiceAgent = withVoice(Agent, {
  historyLimit: 20, // Max messages loaded for context (default: 20)
  audioFormat: "mp3", // Audio format sent to client (default: "mp3")
  maxMessageCount: 1000 // Max messages in SQLite (default: 1000)
});
```

## Server API: `withVoiceInput`

`withVoiceInput(Agent)` adds STT-only voice input — no TTS, no LLM, no response generation. Use this for dictation, search-by-voice, or any UI where you need speech-to-text without a conversational agent.

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

### `onTranscript(text, connection)`

Called after each utterance is transcribed. Override this to process the transcript.

### Hooks

`withVoiceInput` supports the same lifecycle hooks as `withVoice`:

- `beforeCallStart(connection)` — return `false` to reject
- `onCallStart(connection)`, `onCallEnd(connection)`, `onInterrupt(connection)`
- `createTranscriber(connection)` — override for runtime model switching
- `afterTranscribe(transcript, connection)` — filter or transform transcripts

It does **not** have TTS hooks (`beforeSynthesize`, `afterSynthesize`) or `onTurn`.

## Client API: React Hooks

### `useVoiceAgent`

Wraps `VoiceClient` for `withVoice` agents. Manages connection, mic capture, playback, silence detection, and interrupt detection.

```tsx
import { useVoiceAgent } from "@cloudflare/voice/react";

const {
  status, // "idle" | "listening" | "thinking" | "speaking"
  transcript, // TranscriptMessage[] — conversation history
  interimTranscript, // string | null — real-time partial transcript
  metrics, // VoicePipelineMetrics | null
  audioLevel, // number (0–1) — current mic RMS level
  isMuted, // boolean
  connected, // boolean — WebSocket connected
  error, // string | null
  startCall, // () => Promise<void>
  endCall, // () => void
  toggleMute, // () => void
  sendText, // (text: string) => void — bypass STT
  sendJSON, // (data: Record<string, unknown>) => void
  lastCustomMessage // unknown — last non-voice message from server
} = useVoiceAgent({
  agent: "MyAgent", // Required: Durable Object class name
  name: "default", // Instance name (default: "default")
  host: window.location.host, // Host to connect to
  enabled: true // Set false to delay connecting until prerequisites are ready
});
```

Use `enabled: false` when the app must wait for async connection prerequisites, such as a user-scoped capability token. While disabled, the hook does not create or connect a `VoiceClient` and returns the idle/disconnected state. When `enabled` changes to `true`, the hook connects with the current options.

#### Tuning Options

| Option               | Type     | Default | Description                                      |
| -------------------- | -------- | ------- | ------------------------------------------------ |
| `silenceThreshold`   | `number` | `0.04`  | RMS below this is silence                        |
| `silenceDurationMs`  | `number` | `500`   | Silence duration before `end_of_speech` (ms)     |
| `interruptThreshold` | `number` | `0.05`  | RMS to detect speech during playback             |
| `interruptChunks`    | `number` | `2`     | Consecutive high-RMS chunks to trigger interrupt |

Changing tuning options triggers a client reconnect (the connection key includes them).

### `useVoiceInput`

Lightweight hook for dictation / voice-to-text. Accumulates user transcripts into a single string.

```tsx
import { useVoiceInput } from "@cloudflare/voice/react";

function Dictation() {
  const {
    transcript, // string — accumulated text from all utterances
    interimTranscript, // string | null — current partial transcript
    isListening, // boolean
    audioLevel, // number (0–1)
    isMuted, // boolean
    error, // string | null
    start, // () => Promise<void>
    stop, // () => void
    toggleMute, // () => void
    clear // () => void — clear accumulated transcript
  } = useVoiceInput({ agent: "DictationAgent" });

  return (
    <div>
      <textarea
        value={transcript + (interimTranscript ? " " + interimTranscript : "")}
        readOnly
      />
      <button onClick={isListening ? stop : start}>
        {isListening ? "Stop" : "Dictate"}
      </button>
    </div>
  );
}
```

## Client API: `VoiceClient`

Framework-agnostic client for environments without React.

```typescript
import { VoiceClient } from "@cloudflare/voice/client";

const client = new VoiceClient({ agent: "MyAgent" });

client.addEventListener("statuschange", (status) => {
  console.log("Status:", status);
});

client.addEventListener("transcriptchange", (messages) => {
  console.log("Transcript:", messages);
});

client.addEventListener("error", (err) => {
  console.error("Error:", err);
});

client.connect();
await client.startCall();

// Later:
client.endCall();
client.disconnect();
```

### Events

| Event               | Data Type              | Description                           |
| ------------------- | ---------------------- | ------------------------------------- |
| `statuschange`      | `VoiceStatus`          | Pipeline state changed                |
| `transcriptchange`  | `TranscriptMessage[]`  | Transcript updated                    |
| `interimtranscript` | `string \| null`       | Interim transcript from streaming STT |
| `metricschange`     | `VoicePipelineMetrics` | Pipeline timing metrics               |
| `audiolevelchange`  | `number`               | Mic audio level (0–1)                 |
| `connectionchange`  | `boolean`              | WebSocket connected/disconnected      |
| `mutechange`        | `boolean`              | Mute state changed                    |
| `error`             | `string \| null`       | Error occurred                        |
| `custommessage`     | `unknown`              | Non-voice message from server         |

### Advanced Options

| Option            | Type               | Description                                           |
| ----------------- | ------------------ | ----------------------------------------------------- |
| `transport`       | `VoiceTransport`   | Custom transport (default: WebSocket via PartySocket) |
| `audioInput`      | `VoiceAudioInput`  | Custom mic capture (default: built-in AudioWorklet)   |
| `preferredFormat` | `VoiceAudioFormat` | Hint for server audio format (advisory only)          |

## Providers

### Built-in (Workers AI)

No API keys required — use your Workers AI binding:

| Class               | Type           | Default Model         | Recommended for  |
| ------------------- | -------------- | --------------------- | ---------------- |
| `WorkersAIFluxSTT`  | Continuous STT | `@cf/deepgram/flux`   | `withVoice`      |
| `WorkersAINova3STT` | Continuous STT | `@cf/deepgram/nova-3` | `withVoiceInput` |
| `WorkersAITTS`      | TTS            | `@cf/deepgram/aura-1` | Both             |

```typescript
import {
  WorkersAIFluxSTT,
  WorkersAINova3STT,
  WorkersAITTS
} from "@cloudflare/voice";

transcriber = new WorkersAIFluxSTT(this.env.AI);
tts = new WorkersAITTS(this.env.AI);

// Custom options
transcriber = new WorkersAIFluxSTT(this.env.AI, {
  eotThreshold: 0.8,
  keyterms: ["Cloudflare", "Workers"]
});
tts = new WorkersAITTS(this.env.AI, {
  model: "@cf/deepgram/aura-1",
  speaker: "asteria"
});
```

### Third-Party Providers

| Package                        | Class           | Description             |
| ------------------------------ | --------------- | ----------------------- |
| `@cloudflare/voice-deepgram`   | `DeepgramSTT`   | Continuous STT          |
| `@cloudflare/voice-elevenlabs` | `ElevenLabsTTS` | High-quality TTS        |
| `@cloudflare/voice-twilio`     | Twilio adapter  | Telephony (phone calls) |

**ElevenLabs TTS:**

```typescript
import { ElevenLabsTTS } from "@cloudflare/voice-elevenlabs";

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new ElevenLabsTTS({
    apiKey: this.env.ELEVENLABS_API_KEY,
    voiceId: "21m00Tcm4TlvDq8ikWAM"
  });
}
```

**Deepgram STT:**

```typescript
import { DeepgramSTT } from "@cloudflare/voice-deepgram";

export class MyAgent extends VoiceAgent<Env> {
  transcriber = new DeepgramSTT({
    apiKey: this.env.DEEPGRAM_API_KEY
  });
  tts = new WorkersAITTS(this.env.AI);
}
```

## Continuous STT

The transcriber session is created at `start_call` and lives for the entire call. All audio is fed continuously — the model handles speech boundary detection (turn detection). The client receives `transcript_interim` messages with partial results as the user speaks.

```typescript
export class MyAgent extends VoiceAgent<Env> {
  transcriber = new DeepgramSTT({
    apiKey: this.env.DEEPGRAM_API_KEY
  });
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    return "You said: " + transcript;
  }
}
```

The client displays interim transcripts automatically:

```tsx
const { interimTranscript, transcript } = useVoiceAgent({ agent: "MyAgent" });

// interimTranscript updates in real time as the user speaks
// transcript contains finalized messages
```

All transcriber providers use **model-driven turn detection** — the model detects when the user has finished speaking and triggers the pipeline. The client does not need to send `end_of_speech` for STT; `start_of_speech` and `end_of_speech` are only used for client-side UI state (speaking indicators, audio level).

## Text Messages

`withVoice` agents can also receive text messages, bypassing STT entirely. This is useful for chat-style input alongside voice.

**Client:**

```tsx
const { sendText } = useVoiceAgent({ agent: "MyAgent" });

// Send text — goes straight to onTurn() without STT
sendText("What is the weather like today?");
```

Text messages work both during and outside of active calls. During a call, the response is spoken aloud via TTS. Outside a call, the response is sent as text-only transcript messages.

## Custom Messages

Send and receive application-level JSON messages alongside voice protocol messages. Non-voice messages pass through to your `onMessage` handler on the server and emit `custommessage` events on the client.

**Server:**

```typescript
export class MyAgent extends VoiceAgent<Env> {
  onMessage(connection: Connection, message: WSMessage) {
    const data = JSON.parse(message as string);
    if (data.type === "kick_speaker") {
      this.forceEndCall(connection);
    }
  }
}
```

**Client:**

```tsx
const { sendJSON, lastCustomMessage } = useVoiceAgent({ agent: "MyAgent" });

// Send custom JSON
sendJSON({ type: "kick_speaker" });

// Receive custom messages
useEffect(() => {
  if (lastCustomMessage) {
    console.log("Custom message:", lastCustomMessage);
  }
}, [lastCustomMessage]);
```

## Single-Speaker Enforcement

Use `beforeCallStart` to restrict who can start a call. This example enforces single-speaker — only one connection can be the active speaker at a time:

```typescript
export class MyAgent extends VoiceAgent<Env> {
  #speakerId: string | null = null;

  beforeCallStart(connection: Connection) {
    if (this.#speakerId !== null) {
      return false; // reject — someone else is speaking
    }
    this.#speakerId = connection.id;
    return true;
  }

  onCallEnd(connection: Connection) {
    if (this.#speakerId === connection.id) {
      this.#speakerId = null;
    }
  }
}
```

## Telephony (Twilio)

Connect phone calls to your voice agent using the Twilio adapter:

```sh
npm install @cloudflare/voice-twilio
```

The adapter bridges Twilio Media Streams to your VoiceAgent:

```
Phone → Twilio → WebSocket → TwilioAdapter → WebSocket → VoiceAgent
```

**Important:** `WorkersAITTS` returns MP3, which cannot be decoded to PCM in the Workers runtime. When using the Twilio adapter, use a TTS provider that outputs raw PCM (for example, ElevenLabs with `outputFormat: "pcm_16000"`).

## Pipeline Metrics

`withVoice` agents emit timing metrics after each turn:

```tsx
const { metrics } = useVoiceAgent({ agent: "MyAgent" });

// metrics: {
//   llm_ms: 850,         // LLM response time
//   tts_ms: 200,         // Cumulative TTS synthesis time
//   first_audio_ms: 950, // Time to first audio byte
//   total_ms: 1200       // Total pipeline time
// }
```

## Conversation History

`withVoice` automatically persists conversation messages to SQLite. Access history in your `onTurn` via `context.messages`, or directly:

```typescript
// Get history (most recent N messages)
const history = this.getConversationHistory(20);

// Manually save a message
this.saveMessage("assistant", "Welcome! How can I help?");
```

History survives Durable Object restarts and client reconnections. Voice agents use `keepAlive` to prevent eviction during active calls.

## Examples

- [`examples/voice-agent`](https://github.com/cloudflare/agents/tree/main/examples/voice-agent) — full voice agent with Workers AI
- [`examples/voice-input`](https://github.com/cloudflare/agents/tree/main/examples/voice-input) — voice input (dictation) example

## Related

- [Agent Class](./agent-class.md) — understanding the base Agent class
- [Chat Agents](./chat-agents.md) — text-based AI chat agents
- [State Management](./state.md) — managing agent state
