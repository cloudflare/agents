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

export class VoiceAgent extends RealtimeAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    const rtk = new RealtimeKitTransport();

    const stt = new DeepgramSTT({ apiKey: env.DEEPGRAM_API_KEY });
    const tts = new ElevenLabsTTS({ apiKey: env.ELEVENLABS_API_KEY });

    // Audio -> STT -> Agent [Transcript -> Response Text] -> TTS -> Audio
    this.setPipeline([rtk, stt, this, tts, rtk], env.AI, env.AI_GATEWAY_ID);
  }

  async onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined> {
    return { text: `You said: ${text}`, canInterrupt: true };
  }
}
```

## Starting the Agent

The code above defines the pipeline, but doesn't start it. To start the agent, you need to specify which RealtimeKit meeting to connect to. There are several ways to do this:

### Automatic Start via RealtimeKit Dashboard

You can configure your agent to start automatically whenever a RealtimeKit meeting begins:

1. Go to the [RealtimeKit dashboard](https://dash.cloudflare.com/?to=/:account/realtime/kit)
2. Select your app
3. Navigate to the "Agents" tab
4. Create a mapping to bind your agent to all meetings in the app

### Manual Start via HTTP Endpoint

Start the agent by sending a request to the built-in HTTP endpoint:

```
GET /agents/<agent-name>/<meeting-id>/realtime/start?meetingId=<meeting-id>
```

### Manual Programmatic Start

You can also start the agent programmatically using the `startRealtimePipeline` method:

```ts
const agent = getAgentByName(env.VoiceAgent, "meeting-id");
agent.startRealtimePipeline(meetingId);
```

## Public API

### `RealtimeAgent<Env, State>`

Extend this class to implement your realtime logic.

Constructor:

```ts
new RealtimeAgent(ctx: AgentContext, env: Env)
```

Callbacks to override:

- `onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined>`: called for each transcript message.
- `onRealtimeMeeting?(meeting: RealtimeKitClient): void | Promise<void>`: called after the RealtimeKit client is initialized and before it joins the room. You can attach listeners to the meeting client here like participant joined, left, etc.
- `onRealtimeAudio(frame: Buffer): Promise<void>`: called when a raw audio frame is received from the pipeline. Override this to handle audio frames directly. Use `this.speak()` to send a response.
- `onRealtimeVideoFrame(frame: Buffer): Promise<void>`: called when a video frame is received from the pipeline. Override this to handle video frames. Use `this.speak()` to send a response.

Key methods/properties:

- `setPipeline(pipeline: RealtimePipelineComponent[], ai: Ai, gatewayId?: string)`: define the pipeline; adjacent `output_kind()` / `input_kind()` must match. The `ai` parameter is the Cloudflare AI binding, and `gatewayId` is optional (defaults to `:default`).
- `startRealtimePipeline(meetingId: string | null)`: provisions + starts the pipeline.
- `stopRealtimePipeline()`: stops the running pipeline.
- `dispose()`: clean up the pipeline resources.
- `pipelineState: RealtimeState`: `"idle" | "initializing" | "running" | "stopping" | "stopped"`.
- `speak(text: string, contextId?: string)`: send text into the pipeline (typically into TTS and back to the meeting). The optional `contextId` can be used for advanced interruption behavior.
- `rtkMeeting: RealtimeKitClient | undefined`: set after the pipeline starts (only if you included `RealtimeKitTransport`).
- `lastAudioFrame: Buffer | undefined`: the most recently received audio frame.
- `lastVideoFrame: Buffer | undefined`: the most recently received video frame.

Built-in HTTP routes (under your Agent instance):

- `/agents/<agent-name>/<instance-name>/realtime/start`: start the pipeline (accepts optional `?meetingId=...` query parameter).
- `/agents/<agent-name>/<instance-name>/realtime/stop`: stop the pipeline.

`<instance-name>` is the unique Agent instance id used by the SDK's routing (i.e. which Durable Object instance you are talking to). Each instance has its own pipeline and meeting connection.

> **Note:** `RealtimeAgent` extends `Agent`, which is a Cloudflare Durable Object. You never construct it directly -- the Workers runtime instantiates it when accessed via `routeAgentRequest()` or a Durable Object namespace binding.

[Read more about Routing](https://developers.cloudflare.com/agents/api-reference/routing/#how-routing-works)

### `SpeakResponse`

```ts
export type SpeakResponse = {
  text:
    | string
    | ReadableStream<Uint8Array>
    | (AsyncIterable<string> & ReadableStream<string>);
  canInterrupt?: boolean;
};
```

`text` can be a plain string, a `ReadableStream<Uint8Array>` (NDJSON format), or an AI SDK `textStream` (which is both an `AsyncIterable<string>` and `ReadableStream<string>`).

`canInterrupt` controls whether user speech is allowed to barge-in while the agent is speaking.

### Pipeline primitives

- `DataKind`: `Text | Audio | Video` (enum values: `"TEXT"`, `"AUDIO"`, `"VIDEO"`).
- `RealtimePipelineComponent`: `name`, `input_kind()`, `output_kind()`, `schema()`, and optional `setGatewayId()`.

Provided components:

- `RealtimeKitTransport(config?: RealtimeKitMeetingConfig)`: meeting I/O. If `authToken` is omitted, it is filled during pipeline provisioning.
- `DeepgramSTT(config?: DeepgramConfig)`: audio -> text (convenience provider component).
- `ElevenLabsTTS(config?: ElevenLabsConfig)`: text -> audio (convenience provider component).

### `DeepgramConfig`

```ts
export type DeepgramConfig = {
  language?: string;
  model?: string;
  apiKey?: string;
};
```

### `ElevenLabsConfig`

```ts
export type ElevenLabsConfig = {
  model?: string;
  voice_id?: string;
  language_code?: string;
  apiKey?: string;
};
```

Note: API keys for Deepgram and ElevenLabs can also be stored inside the AI Gateway with [BYOK (Bring Your Own Key)](https://developers.cloudflare.com/ai-gateway/providers/byok/). When using BYOK, you can omit the `apiKey` field in the component config.

## Media Configuration

By default, `RealtimeKitTransport` only consumes audio from microphones. To receive raw audio frames, video, or screenshare frames, configure the `media` option.

### `RealtimeKitMediaConfig`

```ts
export interface RealtimeKitMediaConfig {
  /** Whether to consume audio from participants (defaults to true) */
  consumeAudio?: boolean;
  /** Whether to consume video from participants' webcams */
  consumeVideo?: boolean;
  /** Whether to consume screen share streams */
  consumeScreenshare?: boolean;
}
```

### Receiving Raw Audio Frames

When an STT component is in the pipeline, transcripts are delivered to `onRealtimeTranscript`. If you also need access to the raw audio frames (e.g., for custom audio analysis or VAD), override `onRealtimeAudio`:

```ts
export class AudioAgent extends RealtimeAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    const rtk = new RealtimeKitTransport();
    const stt = new DeepgramSTT({ apiKey: env.DEEPGRAM_API_KEY });
    const tts = new ElevenLabsTTS({ apiKey: env.ELEVENLABS_API_KEY });

    this.setPipeline([rtk, stt, this, tts, rtk], env.AI, env.AI_GATEWAY_ID);
  }

  async onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined> {
    return { text: `You said: ${text}`, canInterrupt: true };
  }

  async onRealtimeAudio(frame: Buffer): Promise<void> {
    // frame is base64-decoded raw audio data
    // Process the audio frame (e.g., custom VAD, audio analysis)
    // Use this.speak() to send a text response if needed
  }
}
```

The most recent audio frame is also available via `this.lastAudioFrame`.

### Receiving Video Frames

To receive video frames in your agent, configure the `RealtimeKitTransport` with `consumeVideo: true` and override the `onRealtimeVideoFrame` callback:

```ts
import {
  DeepgramSTT,
  ElevenLabsTTS,
  RealtimeAgent,
  RealtimeKitTransport,
  type SpeakResponse
} from "agents/realtime";
import { type AgentContext } from "agents";

export class VisionAgent extends RealtimeAgent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Configure media to receive both audio and video
    const rtk = new RealtimeKitTransport({
      media: {
        consumeAudio: true,
        consumeVideo: true
      }
    });

    const stt = new DeepgramSTT({ apiKey: env.DEEPGRAM_API_KEY });
    const tts = new ElevenLabsTTS({ apiKey: env.ELEVENLABS_API_KEY });

    this.setPipeline([rtk, stt, this, tts, rtk], env.AI, env.AI_GATEWAY_ID);
  }

  async onRealtimeTranscript(text: string): Promise<SpeakResponse | undefined> {
    // Handle audio transcripts
    return { text: `You said: ${text}`, canInterrupt: true };
  }

  async onRealtimeVideoFrame(frame: Buffer): Promise<void> {
    // frame is base64-decoded video frame data
    // Process the frame with a vision model, etc.
    // Use this.speak() to send a text response if needed
  }
}
```

The most recent video frame is also available via `this.lastVideoFrame`.

To receive screenshare streams, set `consumeScreenshare: true` in the media config.
