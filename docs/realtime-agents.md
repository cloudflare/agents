# Realtime Agents

The `agents/realtime` module helps you build low-latency, voice-first Agents by connecting:

- a realtime audio transport (RealtimeKit)
- speech-to-text (STT)
- your AI logic
- text-to-speech (TTS)

At runtime, you configure a pipeline (an ordered list of components). When you start the pipeline, the SDK provisions a corresponding pipeline in the Realtime Agents service, connects to your Worker over WebSocket, and delivers transcripts to your `RealtimeAgent`.

In a typical voice agent:

1. RealtimeKit streams participant audio into the pipeline.
2. An STT component converts audio to text.
3. Your `RealtimeAgent` receives the text via `onRealtimeTranscript`.
4. Your agent returns a `SpeakResponse` (string or stream).
5. A TTS component turns the response back into audio.
6. RealtimeKit plays the audio back into the meeting.

```ts
import {
  DeepgramSTT,
  ElevenLabsTTS,
  RealtimeAgent,
  RealtimeKitTransport,
  type SpeakResponse
} from "agents/realtime";
import { type AgentContext } from "agents";

const GATEWAY_ID = "my-ai-gateway";

export class VoiceAgent extends RealtimeAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env, env.AI, GATEWAY_ID);

    const rtk = new RealtimeKitTransport({ meetingId: "<meeting-id>" });
    // These are convenience components; the underlying service supports
    // multiple STT/TTS providers.
    const stt = new DeepgramSTT();
    const tts = new ElevenLabsTTS();

    // Audio -> Text -> (your agent) -> Text -> Audio
    this.setPipeline([rtk, stt, this, tts, rtk]);
  }

  async onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined> {
    return { text: `You said: ${text}`, canInterrupt: true };
  }
}
```

## Public API

### `RealtimeAgent<Env, State>`

Extend this class to implement your realtime logic.

Constructor:

```ts
new RealtimeAgent(ctx: AgentContext, env: Env, ai: Ai, gatewayId: string)
```

`gatewayId` is will be used as the default AI Gateway id for some provider components (for example `DeepgramSTT` / `ElevenLabsTTS`) when you call `setPipeline()`.

Callbacks to override:

- `onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined>`: called for each transcript message.
- `onRealtimeMeeting?(meeting: RealtimeKitClient): void | Promise<void>`: called after the RealtimeKit client is initialized and before it joins the room. You can attach listeners to the meeting client here like participant joined, left, etc.

Key methods/properties:

- `setPipeline(pipeline: RealtimePipelineComponent[])`: define the pipeline; adjacent `output_kind()` / `input_kind()` must match.
- `startRealtimePipeline(meetingId: string | null)`: provisions + starts the pipeline.
- `stopRealtimePipeline()`: stops the running pipeline.
- `pipelineState: RealtimeState`: `"idle" | "initializing" | "running" | "stopping" | "stopped"`.
- `speak(text: string)`: send text into the pipeline (typically into TTS and back to the meeting).
- `rtkMeeting: RealtimeKitClient | undefined`: set after the pipeline starts (only if you included `RealtimeKitTransport`).
- `transcriptHistory: TranscriptEntry[]`: persisted transcript entries (Durable Object SQLite).
- `addTranscript(role, text)`, `clearTranscriptHistory()`, `getFormattedHistory(maxEntries?)`: helpers around `transcriptHistory`.
- `getFormattedTranscript(maxEntries?)`: returns the transcript history as a string like "User/Assistant : \<textHistory>"

The default implementation automatically records the user transcript before calling `onRealtimeTranscript`, and records your final response (including after streaming).

Built-in HTTP routes (under your Agent instance):

- `/agents/<agent>/<id>/realtime/start`: start the pipeline.
- `/agents/<agent>/<id>/realtime/stop`: stop the pipeline.
- `/agents/<agent>/<id>/realtime/get-transcripts`: return persisted transcripts.
- `/agents/<agent>/<id>/realtime/clear-transcripts`: clear transcripts.

`<id>` is the unique Agent instance id used by the SDK's routing (i.e. which Durable Object instance you are talking to). Each instance has its own pipeline, meeting connection, and persisted transcript history and `<agent>` is kebab case of the Agent class name.

Notes:

- Your Agent must appear in the pipeline (usually `this`) so it can be represented as a websocket element.
- `startRealtimePipeline(null)` starts the pipeline using the meeting configuration from `RealtimeKitTransport`.
- If you return `SpeakResponse.text` as a `ReadableStream` (for example from Workers AI with `stream: true`), the agent streams partial text to the meeting as it arrives.
- `speak()` also accepts an optional second argument for advanced interruption behavior; most agents should omit it.

### `SpeakResponse`

```ts
export type SpeakResponse = {
  text: string | ReadableStream<Uint8Array>;
  canInterrupt?: boolean;
};
```

`canInterrupt` controls whether user speech is allowed to barge-in while the agent is speaking.

### `TranscriptEntry`

```ts
export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};
```

### Pipeline primitives

- `DataKind`: `Text | Media | Audio`.
- `RealtimePipelineComponent`: `name`, `input_kind()`, `output_kind()`, `schema()`, `validate()`.

Provided components:

- `RealtimeKitTransport(config: RealtimeKitMeetingConfig)`: meeting I/O. If `authToken` is omitted, it is filled during pipeline provisioning.
- `DeepgramSTT(gatewayId?, apiKey?, config?)`: audio -> text (convenience provider component).
- `ElevenLabsTTS(gatewayId?, apiKey?, config?)`: text -> audio (convenience provider component).
