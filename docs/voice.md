# Voice Agents

Build voice agents that users can talk to in real time. The Agents SDK provides a complete voice pipeline — speech-to-text, text-to-speech, turn detection, streaming audio, interruption handling, and conversation persistence — so you can focus on your agent's logic.

All AI models run via Workers AI bindings. No external API keys are required for the default configuration.

## Quick start

### Server

Extend `VoiceAgent` from `agents/voice` and implement `onTurn()`:

```ts
import { VoiceAgent, type VoiceTurnContext } from "agents/voice";
import { routeAgentRequest } from "agents";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export class MyAgent extends VoiceAgent<Env> {
  async onTurn(transcript: string, context: VoiceTurnContext) {
    const ai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: ai("@cf/meta/llama-4-scout-17b-16e-instruct"),
      system: "You are a helpful voice assistant. Be concise.",
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      abortSignal: context.signal
    });

    return result.textStream;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
```

### Client (React)

Use the `useVoiceAgent` hook from `agents/voice-react`:

```tsx
import { useVoiceAgent } from "agents/voice-react";

function App() {
  const { status, transcript, connected, startCall, endCall, toggleMute } =
    useVoiceAgent({ agent: "my-agent" });

  return (
    <div>
      <p>Status: {status}</p>
      <button onClick={startCall} disabled={!connected || status !== "idle"}>
        Start Call
      </button>
      <button onClick={endCall} disabled={status === "idle"}>
        End Call
      </button>
      <button onClick={toggleMute}>Mute / Unmute</button>
      <ul>
        {transcript.map((msg, i) => (
          <li key={i}>
            <strong>{msg.role}:</strong> {msg.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### Client (vanilla JavaScript)

Use the `VoiceClient` class from `agents/voice-client`:

```ts
import { VoiceClient } from "agents/voice-client";

const client = new VoiceClient({ agent: "my-agent" });

client.addEventListener("statuschange", () => {
  console.log("Status:", client.status);
});

client.addEventListener("transcriptchange", () => {
  console.log("Transcript:", client.transcript);
});

client.connect();

// Later:
await client.startCall();
// client.toggleMute();
// client.endCall();
// client.disconnect();
```

### Configuration (wrangler.jsonc)

The agent needs an AI binding and a Durable Object with SQLite:

```jsonc
{
  "name": "my-voice-agent",
  "main": "src/server.ts",
  "compatibility_date": "2026-01-28",
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI" },
  "durable_objects": {
    "bindings": [{ "class_name": "MyAgent", "name": "MyAgent" }]
  },
  "migrations": [{ "new_sqlite_classes": ["MyAgent"], "tag": "v1" }]
}
```

## How it works

A single WebSocket connection carries everything: binary audio frames, JSON status messages, transcript updates, and pipeline metrics. No SFU, no meeting infrastructure.

```
Browser                             VoiceAgent (Durable Object)
┌──────────┐   binary PCM frames   ┌──────────────────────────────┐
│ Mic      │ ─────────────────────► │ Audio buffer (per connection) │
│ (16kHz)  │                        │   ↓                          │
│          │   JSON: end_of_speech  │ VAD: smart-turn-v2           │
│          │ ─────────────────────► │   ↓                          │
│          │                        │ STT: deepgram nova-3         │
│          │   JSON: transcript     │   ↓                          │
│          │ ◄───────────────────── │ onTurn() — your LLM logic    │
│          │   binary: MP3 audio    │   ↓ (sentence chunking)      │
│ Speaker  │ ◄───────────────────── │ TTS: deepgram aura-1         │
└──────────┘                        └──────────────────────────────┘
```

### Pipeline flow

1. The browser captures microphone audio via an AudioWorklet, downsamples to 16 kHz mono PCM, and streams it to the agent as binary WebSocket frames.
2. When the client detects 500 ms of silence, it sends `end_of_speech`.
3. The agent runs server-side VAD (`smart-turn-v2`) to confirm the user actually finished speaking.
4. STT transcribes the audio to text.
5. `onTurn()` is called with the transcript and conversation history.
6. If `onTurn()` returns an `AsyncIterable<string>` (streaming), the pipeline chunks the token stream into sentences and synthesizes TTS concurrently — the user hears the first sentence while the LLM is still generating.
7. If `onTurn()` returns a plain `string`, the full text is synthesized at once.

### Interruption handling

If the user speaks while the agent is talking, the client detects it (sustained audio above a threshold), stops playback, and sends an `interrupt` message. The server aborts the active pipeline and switches back to listening.

### Conversation persistence

`VoiceAgent` automatically creates a SQLite table (`cf_voice_messages`) and saves every user and assistant message. Conversation history survives restarts and hibernation. The `context.messages` array passed to `onTurn()` contains the most recent messages (configurable via `voiceOptions.historyLimit`, default 20).

## VoiceAgent reference

### onTurn(transcript, context) — required

The core hook. Called when the user finishes speaking and the audio has been transcribed.

```ts
async onTurn(
  transcript: string,
  context: VoiceTurnContext
): Promise<string | AsyncIterable<string>>
```

**Parameters:**

- `transcript` — The user's transcribed speech.
- `context.connection` — The WebSocket `Connection` that sent the audio.
- `context.messages` — Conversation history from SQLite (chronological order).
- `context.signal` — An `AbortSignal` that fires if the user interrupts or disconnects. Pass it to your LLM call.

**Return value:**

- `string` — The agent's full response. Synthesized as a single TTS call.
- `AsyncIterable<string>` — A token stream (e.g. from `streamText().textStream`). The pipeline chunks it into sentences and synthesizes TTS per-sentence for lower latency.

### Lifecycle hooks — optional

```ts
onCallStart(connection: Connection): void | Promise<void>
```

Called when the user sends `start_call`. Use it for greetings:

```ts
async onCallStart(connection) {
  await this.speak(connection, "Hi! How can I help you?");
}
```

```ts
onCallEnd(connection: Connection): void | Promise<void>
```

Called when the user sends `end_call`.

```ts
onInterrupt(connection: Connection): void | Promise<void>
```

Called when the user interrupts agent speech.

```ts
onNonVoiceMessage(connection: Connection, message: WSMessage): void | Promise<void>
```

Called for any WebSocket message that is not part of the voice protocol (not `start_call`, `end_call`, `end_of_speech`, `interrupt`, and not binary audio). Use this for text chat on the same connection.

### Convenience methods

```ts
async speak(connection: Connection, text: string): Promise<void>
```

Synthesize and send audio to a single connection. Sends transcript protocol messages and saves to conversation history. Use for greetings, one-off announcements, etc.

```ts
async speakAll(text: string): Promise<void>
```

Speak to all connected clients. Useful for scheduled reminders:

```ts
async speakReminder(payload: { message: string }) {
  await this.speakAll(`Reminder: ${payload.message}`);
}
```

### Conversation history

```ts
saveMessage(role: "user" | "assistant", text: string): void
```

Save a message to the conversation history table. The pipeline calls this automatically for user and assistant messages during `onTurn` — call it manually for out-of-band messages (greetings, reminders).

```ts
getConversationHistory(limit?: number): Array<{ role: string; content: string }>
```

Load the most recent messages from SQLite. Defaults to `voiceOptions.historyLimit` (20).

### STT / TTS / VAD — overridable

The default implementations use Workers AI. Override these methods to use custom providers:

```ts
async transcribe(audioData: ArrayBuffer): Promise<string>
```

Speech-to-text. Default: `@cf/deepgram/nova-3`.

```ts
async synthesize(text: string): Promise<ArrayBuffer | null>
```

Text-to-speech. Default: `@cf/deepgram/aura-1` with speaker `asteria`.

```ts
async checkEndOfTurn(audioData: ArrayBuffer): Promise<VADResult>
```

Voice activity detection. Default: `@cf/pipecat-ai/smart-turn-v2`. Returns `{ isComplete: boolean, probability: number }`.

Example using a custom TTS provider:

```ts
class MyAgent extends VoiceAgent<Env> {
  async synthesize(text: string): Promise<ArrayBuffer | null> {
    const response = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/...",
      {
        method: "POST",
        headers: { "xi-api-key": this.env.ELEVENLABS_KEY },
        body: JSON.stringify({ text })
      }
    );
    return response.arrayBuffer();
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // ...
  }
}
```

### voiceOptions

Override as a class property to configure defaults:

```ts
class MyAgent extends VoiceAgent<Env> {
  voiceOptions = {
    sttModel: "@cf/deepgram/nova-3", // STT model
    ttsModel: "@cf/deepgram/aura-1", // TTS model
    ttsSpeaker: "asteria", // TTS voice
    vadModel: "@cf/pipecat-ai/smart-turn-v2", // VAD model
    vadThreshold: 0.5, // VAD probability threshold
    minAudioBytes: 16000, // Skip audio shorter than 0.5s
    vadWindowSeconds: 2, // VAD uses last N seconds of audio
    historyLimit: 20 // Max messages in context
  };
}
```

## Client SDK reference

### useVoiceAgent (React)

```ts
import { useVoiceAgent } from "agents/voice-react";

const {
  status, // "idle" | "listening" | "thinking" | "speaking"
  transcript, // TranscriptMessage[]
  metrics, // PipelineMetrics | null
  audioLevel, // number (0-1, current mic RMS)
  isMuted, // boolean
  connected, // boolean
  error, // string | null
  startCall, // () => Promise<void>
  endCall, // () => void
  toggleMute // () => void
} = useVoiceAgent({
  agent: "my-agent", // Agent class name (kebab-cased)
  name: "default", // Instance name (optional)
  silenceThreshold: 0.01, // RMS below this = silence
  silenceDurationMs: 500, // Silence duration before end_of_speech
  interruptThreshold: 0.02, // RMS above this during playback = interrupt
  interruptChunks: 2 // Consecutive high-RMS chunks to trigger interrupt
});
```

### VoiceClient (vanilla JavaScript)

```ts
import { VoiceClient } from "agents/voice-client";

const client = new VoiceClient({
  agent: "my-agent",
  name: "default",
  silenceThreshold: 0.01,
  silenceDurationMs: 500,
  interruptThreshold: 0.02,
  interruptChunks: 2
});

// State (getters)
client.status; // VoiceStatus
client.transcript; // TranscriptMessage[]
client.metrics; // PipelineMetrics | null
client.audioLevel; // number
client.isMuted; // boolean
client.connected; // boolean
client.error; // string | null

// Actions
client.connect();
client.disconnect();
await client.startCall();
client.endCall();
client.toggleMute();

// Events
client.addEventListener("statuschange", () => {
  /* ... */
});
client.addEventListener("transcriptchange", () => {
  /* ... */
});
client.addEventListener("metricschange", () => {
  /* ... */
});
client.addEventListener("audiolevelchange", () => {
  /* ... */
});
client.addEventListener("connectionchange", () => {
  /* ... */
});
client.addEventListener("mutechange", () => {
  /* ... */
});
client.addEventListener("error", () => {
  /* ... */
});
```

## WebSocket protocol

The voice protocol uses the same WebSocket connection as the Agent. Binary frames are audio; text frames are JSON control messages.

### Client to server

| Message                     | Description                                             |
| --------------------------- | ------------------------------------------------------- |
| `{ type: "start_call" }`    | Begin a voice session                                   |
| `{ type: "end_call" }`      | End the voice session                                   |
| `{ type: "end_of_speech" }` | Client detected silence — process the audio buffer      |
| `{ type: "interrupt" }`     | User spoke during playback — abort the current pipeline |
| Binary (ArrayBuffer)        | Raw PCM audio (16 kHz, mono, 16-bit signed LE)          |

### Server to client

| Message                              | Description                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `{ type: "status", status }`         | Pipeline status: `"idle"`, `"listening"`, `"thinking"`, `"speaking"`                   |
| `{ type: "transcript", role, text }` | Complete transcript message (user)                                                     |
| `{ type: "transcript_start", role }` | Streaming transcript begins (assistant)                                                |
| `{ type: "transcript_delta", text }` | Incremental text token                                                                 |
| `{ type: "transcript_end", text }`   | Final full text                                                                        |
| `{ type: "metrics", ... }`           | Pipeline latency: `vad_ms`, `stt_ms`, `llm_ms`, `tts_ms`, `first_audio_ms`, `total_ms` |
| `{ type: "error", message }`         | Pipeline error                                                                         |
| Binary (ArrayBuffer)                 | MP3 audio for playback (streamed per-sentence)                                         |

## Workers AI models

The default pipeline uses these Workers AI models, all accessed via the `AI` binding (no API keys):

| Stage | Model                          | Purpose                                   |
| ----- | ------------------------------ | ----------------------------------------- |
| STT   | `@cf/deepgram/nova-3`          | Speech-to-text                            |
| TTS   | `@cf/deepgram/aura-1`          | Text-to-speech (MP3 output)               |
| VAD   | `@cf/pipecat-ai/smart-turn-v2` | Turn detection / end-of-speech validation |

Override any model via `voiceOptions` or by overriding the corresponding method (`transcribe`, `synthesize`, `checkEndOfTurn`).
