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
- **Voice activity detection** — optional server-side VAD confirms end-of-turn
- **Streaming STT** — optional real-time transcription with interim results
- **Pipeline hooks** — intercept and transform audio/text at every stage

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
  WorkersAISTT,
  WorkersAITTS,
  WorkersAIVAD,
  type VoiceTurnContext
} from "@cloudflare/voice";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  stt = new WorkersAISTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);
  vad = new WorkersAIVAD(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // Return a string for single-shot TTS
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
┌──────────┐   binary PCM (16kHz)    ┌──────────────────────────┐
│ Mic      │ ──────────────────────► │ Audio buffer             │
│          │                         │   ↓                      │
│          │   JSON: end_of_speech   │ VAD (optional)           │
│          │ ──────────────────────► │   ↓                      │
│          │                         │ STT                      │
│          │   JSON: transcript      │   ↓                      │
│          │ ◄────────────────────── │ onTurn() → your LLM code │
│          │   binary: audio         │   ↓ (sentence chunking)  │
│ Speaker  │ ◄────────────────────── │ TTS                      │
└──────────┘                         └──────────────────────────┘
```

1. The client captures mic audio and sends it as binary WebSocket frames (16kHz mono 16-bit PCM)
2. Client-side silence detection sends `end_of_speech` after 500ms of silence
3. Server-side VAD (if configured) confirms end-of-turn
4. STT transcribes the audio (batch or streaming)
5. Your `onTurn()` method runs — typically an LLM call
6. The response is sentence-chunked and synthesized via TTS
7. Audio streams back to the client for playback

## Server API: `withVoice`

`withVoice(Agent)` adds the full voice pipeline to an Agent class.

### Providers

Set providers as class properties. Class field initializers run after `super()`, so `this.env` is available.

| Property       | Type                   | Required | Description                             |
| -------------- | ---------------------- | -------- | --------------------------------------- |
| `stt`          | `STTProvider`          | Yes\*    | Batch speech-to-text                    |
| `tts`          | `TTSProvider`          | Yes      | Text-to-speech                          |
| `vad`          | `VADProvider`          | No       | Voice activity detection                |
| `streamingStt` | `StreamingSTTProvider` | No       | Streaming STT (replaces `stt` when set) |

\*Not required if `streamingStt` is set.

```typescript
import {
  withVoice,
  WorkersAISTT,
  WorkersAITTS,
  WorkersAIVAD
} from "@cloudflare/voice";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  stt = new WorkersAISTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);
  vad = new WorkersAIVAD(this.env.AI);
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
    model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
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

| Method                                     | Receives          | Can skip? |
| ------------------------------------------ | ----------------- | --------- |
| `beforeTranscribe(audio, connection)`      | Raw PCM after VAD | Yes       |
| `afterTranscribe(transcript, connection)`  | STT text          | Yes       |
| `beforeSynthesize(text, connection)`       | Text before TTS   | Yes       |
| `afterSynthesize(audio, text, connection)` | Audio after TTS   | Yes       |

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
  maxMessageCount: 1000, // Max messages in SQLite (default: 1000)
  minAudioBytes: 16000, // Min audio to process, 0.5s (default: 16000)
  vadThreshold: 0.5, // VAD probability threshold (default: 0.5)
  vadPushbackSeconds: 2, // Audio pushed back on VAD reject (default: 2)
  vadRetryMs: 3000 // Retry delay after VAD reject (default: 3000)
});
```

## Server API: `withVoiceInput`

`withVoiceInput(Agent)` adds STT-only voice input — no TTS, no LLM, no response generation. Use this for dictation, search-by-voice, or any UI where you need speech-to-text without a conversational agent.

```typescript
import { Agent } from "agents";
import { withVoiceInput, WorkersAIFluxSTT } from "@cloudflare/voice";

const InputAgent = withVoiceInput(Agent);

export class DictationAgent extends InputAgent<Env> {
  streamingStt = new WorkersAIFluxSTT(this.env.AI);

  onTranscript(text: string, connection: Connection) {
    console.log("User said:", text);
    // Save to storage, trigger a search, forward to another service, etc.
  }
}
```

### `onTranscript(text, connection)`

Called after each utterance is transcribed. Override this to process the transcript.

### Hooks

`withVoiceInput` supports the same lifecycle and STT pipeline hooks as `withVoice`:

- `beforeCallStart(connection)` — return `false` to reject
- `onCallStart(connection)`, `onCallEnd(connection)`, `onInterrupt(connection)`
- `beforeTranscribe(audio, connection)`, `afterTranscribe(transcript, connection)`

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
  host: window.location.host // Host to connect to
});
```

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

| Class              | Type          | Default Model                  |
| ------------------ | ------------- | ------------------------------ |
| `WorkersAISTT`     | Batch STT     | `@cf/deepgram/nova-3`          |
| `WorkersAIFluxSTT` | Streaming STT | `@cf/deepgram/nova-3`          |
| `WorkersAITTS`     | TTS           | `@cf/deepgram/aura-1`          |
| `WorkersAIVAD`     | VAD           | `@cf/pipecat-ai/smart-turn-v2` |

```typescript
import {
  WorkersAISTT,
  WorkersAITTS,
  WorkersAIVAD,
  WorkersAIFluxSTT
} from "@cloudflare/voice";

// Default options
stt = new WorkersAISTT(this.env.AI);
tts = new WorkersAITTS(this.env.AI);
vad = new WorkersAIVAD(this.env.AI);

// Custom options
stt = new WorkersAISTT(this.env.AI, {
  model: "@cf/deepgram/nova-3",
  language: "en"
});
tts = new WorkersAITTS(this.env.AI, {
  model: "@cf/deepgram/aura-1",
  speaker: "asteria"
});
```

### Third-Party Providers

| Package                        | Class                  | Description             |
| ------------------------------ | ---------------------- | ----------------------- |
| `@cloudflare/voice-deepgram`   | `DeepgramStreamingSTT` | Real-time streaming STT |
| `@cloudflare/voice-elevenlabs` | `ElevenLabsTTS`        | High-quality TTS        |
| `@cloudflare/voice-twilio`     | Twilio adapter         | Telephony (phone calls) |

**ElevenLabs TTS:**

```typescript
import { ElevenLabsTTS } from "@cloudflare/voice-elevenlabs";

export class MyAgent extends VoiceAgent<Env> {
  stt = new WorkersAISTT(this.env.AI);
  tts = new ElevenLabsTTS({
    apiKey: this.env.ELEVENLABS_API_KEY,
    voiceId: "21m00Tcm4TlvDq8ikWAM"
  });
}
```

**Deepgram Streaming STT:**

```typescript
import { DeepgramStreamingSTT } from "@cloudflare/voice-deepgram";

export class MyAgent extends VoiceAgent<Env> {
  streamingStt = new DeepgramStreamingSTT({
    apiKey: this.env.DEEPGRAM_API_KEY
  });
  tts = new WorkersAITTS(this.env.AI);
}
```

### Custom Providers

Any object satisfying the provider interface works:

```typescript
export class MyAgent extends VoiceAgent<Env> {
  stt = {
    transcribe: async (audio: ArrayBuffer, signal?: AbortSignal) => {
      const resp = await fetch("https://my-stt.example.com/v1/transcribe", {
        method: "POST",
        body: audio,
        signal
      });
      return ((await resp.json()) as { text: string }).text;
    }
  };

  tts = {
    synthesize: async (text: string, signal?: AbortSignal) => {
      const resp = await fetch("https://my-tts.example.com/v1/synthesize", {
        method: "POST",
        body: JSON.stringify({ text }),
        headers: { "Content-Type": "application/json" },
        signal
      });
      return resp.arrayBuffer();
    }
  };
}
```

## Streaming STT

Streaming STT transcribes audio in real time as the user speaks, eliminating the latency of batch transcription. When a streaming STT provider is set, the pipeline creates a per-utterance session that receives audio chunks incrementally.

The client receives `transcript_interim` messages with partial results as the user speaks. By the time the user stops, the transcript is already (nearly) ready — `session.finish()` typically takes ~50ms.

```typescript
export class MyAgent extends VoiceAgent<Env> {
  // Streaming STT replaces batch stt when set
  streamingStt = new DeepgramStreamingSTT({
    apiKey: this.env.DEEPGRAM_API_KEY
  });
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // transcript is the final, stable text
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

Some streaming STT providers (like Deepgram) support **provider-driven end-of-turn**: the provider detects when the user has finished speaking and triggers the LLM pipeline immediately, bypassing client-side silence detection. This further reduces latency.

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
//   vad_ms: 45,          // VAD check time
//   stt_ms: 120,         // STT transcription time
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

History survives Durable Object restarts, hibernation, and client reconnections.

## Examples

- [`examples/voice-agent`](https://github.com/cloudflare/agents/tree/main/examples/voice-agent) — full voice agent with Workers AI
- [`examples/voice-input`](https://github.com/cloudflare/agents/tree/main/examples/voice-input) — voice input (dictation) example

## Related

- [Agent Class](./agent-class.md) — understanding the base Agent class
- [Chat Agents](./chat-agents.md) — text-based AI chat agents
- [State Management](./state.md) — managing agent state
