# Voice Agents on Cloudflare: Talk to Your Agent

**Sunil Pai · [date] · X min read**

Today we're releasing an experimental voice pipeline for the Agents SDK — you can build agents that users talk to in real time, over the web or over the phone. And we're opening it up as a call to collaborate with model vendors and the broader voice AI community.

**In this post:**

- How the voice pipeline works — a single WebSocket carrying audio, transcripts, and control messages between the browser and a Durable Object
- The server-side code: ~30 lines to get a working voice agent with STT, TTS, VAD, streaming, interruption handling, and conversation persistence
- The client-side code: a React hook or vanilla JS class
- Advanced features: streaming STT/TTS for lower latency, telephony via Twilio, pipeline hooks, tool use, and WebRTC
- The provider system: small, stable interfaces that anyone can implement — and the providers we want to build together

---

## What we built

A single WebSocket carries everything: binary audio frames, JSON control messages, transcript updates, and pipeline metrics. No SFU, no meeting infrastructure, no additional servers to manage. Your voice agent is a Durable Object — the same primitive that already handles state, scheduling, RPC, and persistence in the Agents SDK.

```
Browser                             VoiceAgent (Durable Object)
┌──────────┐   binary PCM frames    ┌──────────────────────────────┐
│ Mic      │ ─────────────────────► │ Audio buffer (per connection)│
│ (16kHz)  │                        │   ↓                          │
│          │   JSON: end_of_speech  │ VAD (smart-turn-v2)          │
│          │ ─────────────────────► │   ↓                          │
│          │                        │ STT (deepgram nova-3)        │
│          │   JSON: transcript     │   ↓                          │
│          │ ◄───────────────────── │ onTurn() — your LLM logic    │
│          │   binary: MP3 audio    │   ↓ (sentence chunking)      │
│ Speaker  │ ◄───────────────────── │ TTS (deepgram aura-1)        │
└──────────┘                        └──────────────────────────────┘
```

The pipeline flow:

1. The browser captures mic audio via an AudioWorklet, downsamples to 16 kHz mono PCM, and streams it to the agent as binary WebSocket frames.
2. When the client detects 500ms of silence, it sends `end_of_speech`.
3. The agent optionally runs server-side VAD to confirm the user actually finished speaking.
4. STT transcribes the buffered audio to text.
5. Your `onTurn()` is called with the transcript and conversation history.
6. If you return an `AsyncIterable<string>` (e.g., from `streamText().textStream`), the pipeline chunks the token stream into sentences and synthesizes TTS concurrently — the user hears the first sentence while the LLM is still generating the rest.
7. If the user interrupts by speaking during playback, the client detects it, stops playback, and sends `interrupt`. The server aborts the active pipeline and returns to listening.

All of this runs on Cloudflare Workers. No GPU provisioning, no WebRTC infrastructure, no persistent servers. The Durable Object hibernates between calls (saving billable duration) and stays alive during active calls. Conversation history is persisted in SQLite automatically.

## The code

### Server: 30 lines

```ts
import { Agent, routeAgentRequest } from "agents";
import {
  withVoice,
  WorkersAISTT,
  WorkersAITTS,
  WorkersAIVAD,
  type VoiceTurnContext
} from "agents/experimental/voice";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  stt = new WorkersAISTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);
  vad = new WorkersAIVAD(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const ai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: ai("@cf/meta/llama-4-scout-17b-16e-instruct"),
      system: "You are a helpful voice assistant. Be concise.",
      messages: [
        ...context.messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content: transcript },
      ],
      abortSignal: context.signal,
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
  },
} satisfies ExportedHandler<Env>;
```

That's the entire server. `withVoice(Agent)` is a mixin that adds the full voice pipeline — audio buffering, silence detection, VAD, STT, sentence chunking, streaming TTS, interruption handling, and conversation persistence — to any Agent class. You implement `onTurn()` and set your providers. Everything else is handled.

The default configuration uses Workers AI models with no external API keys:

| Stage | Model | Purpose |
|-------|-------|---------|
| STT | `@cf/deepgram/nova-3` | Speech-to-text |
| TTS | `@cf/deepgram/aura-1` | Text-to-speech (MP3) |
| VAD | `@cf/pipecat-ai/smart-turn-v2` | Turn detection |

### Client: React hook

```tsx
import { useVoiceAgent } from "agents/experimental/voice-react";

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

Or use the `VoiceClient` class directly if you're not using React:

```ts
import { VoiceClient } from "agents/experimental/voice-client";

const client = new VoiceClient({ agent: "my-agent" });
client.addEventListener("statuschange", () => console.log(client.status));
client.connect();
await client.startCall();
```

## Beyond the basics

The minimal example above gets you a working voice agent. Here's what you get out of the box for production use cases.

### Multi-modal: voice + text on the same connection

The same agent handles both voice and text input. Call `sendText("What's the weather?")` on the client — the server bypasses STT and feeds the text directly to `onTurn()`. During a call, the response is both spoken and displayed as text. Outside a call, it's text-only. Conversation history is shared across modalities.

### Streaming STT for lower latency

Instead of waiting until the user stops speaking to transcribe, streaming STT feeds audio to the provider in real time. By the time the user finishes, the transcript is already ready (~50ms flush time vs. 500-2000ms for batch).

```ts
import { DeepgramStreamingSTT } from "@cloudflare/agents-voice-deepgram";

export class MyAgent extends VoiceAgent<Env> {
  streamingStt = new DeepgramStreamingSTT({
    apiKey: this.env.DEEPGRAM_API_KEY,
  });
  tts = new WorkersAITTS(this.env.AI);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // ...
  }
}
```

The client also receives interim transcripts in real time — so you can show what the user is saying before they've finished speaking.

### Streaming TTS for faster first audio

When your TTS provider supports streaming, the pipeline sends audio chunks to the client as they're generated within each sentence — reducing time-to-first-audio even further.

```ts
import { ElevenLabsTTS } from "@cloudflare/agents-voice-elevenlabs";

export class MyAgent extends VoiceAgent<Env> {
  tts = new ElevenLabsTTS({ apiKey: this.env.ELEVENLABS_API_KEY });
  // ElevenLabsTTS implements both synthesize() and synthesizeStream()
  // The pipeline uses synthesizeStream() automatically when available

  async onTurn(transcript: string, context: VoiceTurnContext) {
    // ...
  }
}
```

### Telephony

Connect phone calls to the same agent using the Twilio adapter. The same `onTurn()` logic handles web, mobile, and phone.

```ts
import { TwilioAdapter } from "@cloudflare/agents-voice-twilio";

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/twilio") {
      return TwilioAdapter.handleRequest(request, env, "MyAgent");
    }
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
};
```

The adapter bridges Twilio's mulaw 8kHz audio to the agent's 16kHz PCM protocol automatically. Conversation history, state, tools, and scheduling are shared across all channels.

### Pipeline hooks

Four interception points let you transform data between pipeline stages:

| Hook | Receives | Can skip by returning |
|------|----------|----------------------|
| `beforeTranscribe(audio, connection)` | Raw PCM after VAD | `null` |
| `afterTranscribe(transcript, connection)` | STT text | `null` |
| `beforeSynthesize(text, connection)` | Text before TTS | `null` |
| `afterSynthesize(audio, text, connection)` | Audio after TTS | `null` |

Use these for content filtering, language detection, translation, custom logging, or anything that needs to sit between stages.

### Agent greetings, reminders, and tool use

Your agent is a Durable Object. It has scheduling, state, RPC, and everything else from the Agents SDK. Combine voice with tools naturally:

```ts
async onCallStart(connection: Connection) {
  await this.speak(connection, "Hi! How can I help you today?");
}

// Called by the scheduler
async speakReminder(payload: { message: string }) {
  await this.speakAll(`Reminder: ${payload.message}`);
}
```

Tools work exactly as you'd expect with the Vercel AI SDK:

```ts
tools: {
  set_reminder: tool({
    description: "Set a spoken reminder after a delay",
    inputSchema: z.object({
      message: z.string(),
      delay_seconds: z.number(),
    }),
    execute: async ({ message, delay_seconds }) => {
      await this.schedule(delay_seconds, "speakReminder", { message });
      return { confirmed: true };
    },
  }),
}
```

### WebRTC via SFU

For use cases requiring WebRTC-grade audio quality (unreliable mobile networks, NAT traversal, packet loss concealment), you can use the Cloudflare Realtime SFU with the voice pipeline. The client captures audio via WebRTC and sends it through the SFU, while a WebSocket carries control messages to your VoiceAgent. Most applications don't need this — the default WebSocket transport works well for 1:1 conversations — but it's there when you do.

## The provider system — and why we're opening this up

The voice pipeline is deliberately provider-agnostic. Each stage of the pipeline — STT, TTS, VAD, and streaming STT — is defined by a simple interface:

```ts
interface STTProvider {
  transcribe(audioData: ArrayBuffer, signal?: AbortSignal): Promise<string>;
}

interface TTSProvider {
  synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null>;
}

interface StreamingTTSProvider {
  synthesizeStream(
    text: string,
    signal?: AbortSignal
  ): AsyncGenerator<ArrayBuffer>;
}

interface VADProvider {
  checkEndOfTurn(
    audioData: ArrayBuffer
  ): Promise<{ isComplete: boolean; probability: number }>;
}

interface StreamingSTTProvider {
  createSession(options?: StreamingSTTSessionOptions): StreamingSTTSession;
}
```

That's the entire contract. Any object that satisfies one of these interfaces works. You don't need a package, a class, or even a dependency:

```ts
stt = {
  transcribe: async (audio: ArrayBuffer) => {
    const resp = await fetch("https://my-stt.example.com/v1/transcribe", {
      method: "POST",
      body: audio,
    });
    return (await resp.json()).text;
  },
};
```

We ship three provider packages today:

- **`@cloudflare/agents-voice-elevenlabs`** — TTS + streaming TTS via ElevenLabs
- **`@cloudflare/agents-voice-deepgram`** — Streaming STT via Deepgram's real-time WebSocket API
- **`@cloudflare/agents-voice-twilio`** — Telephony adapter bridging Twilio Media Streams

Plus the built-in Workers AI providers (`WorkersAISTT`, `WorkersAITTS`, `WorkersAIVAD`) that require no API keys.

### What we want to build together

This is where the call for collaboration comes in. The provider interfaces are small and stable. We'd love to see:

- **STT providers** — Whisper, AssemblyAI, Rev.ai, Speechmatics, or any service with a transcription API. Batch or streaming.
- **TTS providers** — PlayHT, LMNT, Cartesia, Coqui, Amazon Polly, Google Cloud TTS. If it returns audio bytes, it can be a provider.
- **VAD providers** — Silero VAD, custom models, or any end-of-turn detector that returns a probability.
- **Streaming STT providers** — Anyone with a real-time WebSocket API. The `DeepgramStreamingSTT` implementation is 300 lines — it's a good template.
- **Telephony adapters** — Vonage, Telnyx, Bandwidth, or any platform that bridges phone calls to WebSockets.
- **Transport implementations** — Custom `VoiceTransport` implementations for WebRTC data channels, SFU bridges, or other audio transports.

If you maintain an AI voice service and want to see a first-class integration, open a PR or reach out. The interfaces are designed to be implemented without understanding the rest of the SDK — you implement `transcribe()` or `synthesize()`, we handle the pipeline.

We're also interested in collaborations that go beyond individual providers:

- **Latency benchmarking** across provider combinations (which STT + TTS + LLM stack gives the best time-to-first-audio?)
- **Multi-language support** — the pipeline is language-agnostic but the default models are English-first. Help us test and document other languages.
- **Accessibility** — how do voice agents work for people with speech impairments? The multi-modal text+voice support is a start, but there's more to explore.

## Architecture decisions worth noting

A few choices we made that are worth calling out:

**WebSocket-native, not WebRTC by default.** A voice agent is a 1:1 conversation. The browser has `getUserMedia()` for the mic and Web Audio API for playback. Audio flows as binary WebSocket frames over the connection the Agent already has. You give up WebRTC-grade network resilience (TCP head-of-line blocking on bad networks), but you gain simplicity, no STUN/TURN infrastructure, and the ability to run the entire system on Workers. For applications that need WebRTC, we support it via the Cloudflare Realtime SFU.

**Sentence-level streaming TTS.** The pipeline doesn't wait for the full LLM response before starting TTS. It chunks the token stream into sentences and synthesizes them concurrently — sentence N+1 starts synthesizing while sentence N is being delivered. This is the single biggest latency win.

**Hibernation works.** Durable Objects hibernate between calls (saving you money). During active calls, a keepalive timer prevents hibernation. If the DO does evict mid-call (rare), the pipeline auto-recovers when the next audio chunk arrives. Conversation history survives in SQLite across hibernation and reconnects.

**Mixin pattern.** `withVoice(Agent)` produces a class with the full pipeline mixed in. This means you keep all existing Agent capabilities — state sync, RPC, scheduling, MCP, workflows — and add voice on top. A voice agent isn't a different kind of agent; it's an agent that can also talk.

## Try it now

The voice pipeline is experimental — the API will change between releases. But it works today.

```bash
npm create cloudflare@latest -- --template cloudflare/agents-starter
```

Add voice to your agent, deploy it, and talk to it. We want to hear what you build (literally). If you're a provider that wants to integrate, open an issue on [github.com/cloudflare/agents](https://github.com/cloudflare/agents) or reach out directly. The interfaces are intentionally small — implementing a provider is an afternoon's work, not a quarter-long project.

We're building this in the open because voice AI is too important to be locked into any single provider's stack. The best voice agent should be the one where you pick the best STT, the best TTS, the best LLM, and the best turn detection — and have them all work together seamlessly on infrastructure that scales to zero when nobody's talking.

---

## Cloudflare

Cloudflare's connectivity cloud protects [entire corporate networks](https://www.cloudflare.com/network-services/), helps customers build [Internet-scale applications efficiently](https://workers.cloudflare.com/), enhances any [website or Internet application](https://www.cloudflare.com/performance/accelerate-internet-applications/), [wards off DDoS attacks](https://www.cloudflare.com/ddos/), keeps [hackers at bay](https://www.cloudflare.com/application-security/), and can help you on [your journey to Zero Trust](https://www.cloudflare.com/products/zero-trust/).

Visit [1.1.1.1](https://one.one.one.one/) from any device to get started with our free app that makes your Internet faster and safer.

To learn more about our mission to help build a better Internet, [start here](https://www.cloudflare.com/learning/what-is-cloudflare/). If you're looking for a new career direction, check out [our open positions](https://www.cloudflare.com/careers).
