# @cloudflare/voice-plivo

Plivo audio streaming adapter for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline. Connects phone calls to your `VoiceAgent` — the same agent that handles web voice, text chat, and email can now answer the phone.

## How it works

```
Phone call → Plivo → Audio Streaming WebSocket → PlivoAdapter → VoiceAgent (Durable Object)
                                                                      ↓
                                                                STT → LLM → TTS
                                                                      ↓
Phone speaker ← Plivo ← mulaw 8kHz audio ← PlivoAdapter ← VoiceAgent
```

The adapter bridges Plivo's bidirectional audio streaming protocol to VoiceAgent's binary PCM protocol (16kHz, 16-bit LE). Audio resampling and mulaw encoding/decoding happen automatically.

## Install

```bash
npm install @cloudflare/voice-plivo
```

## Usage

### 1. Add the adapter to your Worker

Two endpoints are needed — `/answer` (Plivo fetches this when a call comes in) and `/plivo` (Plivo streams audio here via WebSocket):

```typescript
import { Agent, routeAgentRequest } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { PlivoAdapter } from "@cloudflare/voice-plivo";

const VoiceAgent = withVoice(Agent);

export class MyAgent extends VoiceAgent<Env> {
  async onTurn(transcript: string, context: VoiceTurnContext) {
    return "Hello! How can I help you?";
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Plivo fetches this when someone dials your number. Return XML that
    // tells Plivo to open an audio WebSocket to /plivo.
    if (url.pathname === "/answer") {
      const wsUrl = `wss://${url.host}/plivo`;
      const xml = `<Response><Stream keepCallAlive="true" bidirectional="true" contentType="audio/x-mulaw;rate=8000">${wsUrl}</Stream></Response>`;
      return new Response(xml, {
        headers: { "Content-Type": "application/xml" }
      });
    }

    // Plivo streams call audio here over a WebSocket.
    if (url.pathname === "/plivo") {
      return PlivoAdapter.handleRequest(request, env, "MyAgent");
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

### 2. Point Plivo at your Worker

Provision the Plivo application once per deploy with `setupPlivoApplication`. It finds or creates a `cloudflare-agents-*` application, sets its answer URL, and assigns your phone number to it. It is idempotent and runs against the Plivo REST API, so it belongs in your deploy step, not the request path:

```typescript
import { setupPlivoApplication } from "@cloudflare/voice-plivo";

await setupPlivoApplication({
  authId: process.env.PLIVO_AUTH_ID,
  authToken: process.env.PLIVO_AUTH_TOKEN,
  phoneNumber: process.env.PLIVO_PHONE_NUMBER,
  answerUrl: "https://your-worker.workers.dev/answer"
});
```

Call this helper from your deployment automation after the Worker has a public URL.

### 3. Call

Dial your Plivo number.

## Options

```typescript
PlivoAdapter.handleRequest(request, env, "MyAgent", {
  // Use a custom instance name instead of the Plivo Call ID
  instanceName: "shared-agent"
});
```

By default, each phone call creates a new VoiceAgent instance (using the Plivo Call ID as the instance name). Set `instanceName` to route multiple calls to the same agent instance.

## TTS output format

VoiceAgent's default TTS (`WorkersAITTS`) outputs MP3. The Plivo adapter expects raw PCM to encode as mulaw. For production use, configure a TTS provider that outputs PCM directly:

```typescript
import { type TTSProvider } from "@cloudflare/voice";

class PlivoPCMTTS implements TTSProvider {
  constructor(private ai: Ai) {}

  async synthesize(
    text: string,
    signal?: AbortSignal
  ): Promise<ArrayBuffer | null> {
    const response = (await this.ai.run(
      "@cf/deepgram/aura-2-en",
      {
        text,
        speaker: "asteria",
        encoding: "linear16",
        sample_rate: 16000,
        container: "none"
      },
      { returnRawResponse: true, ...(signal ? { signal } : {}) }
    )) as Response;
    if (!response.ok) {
      // Returning the error body would ship JSON down the audio pipeline
      // and play as silence — fail loud and skip the audio instead.
      console.error("[PlivoPCMTTS] TTS failed:", await response.text());
      return null;
    }
    return response.arrayBuffer();
  }
}

// In your VoiceAgent:
tts = new PlivoPCMTTS(this.env.AI);
```

`WorkersAITTS` outputs MP3, which the Plivo adapter cannot use directly. `PlivoPCMTTS` calls `@cf/deepgram/aura-2-en` with `encoding: "linear16"` and `container: "none"` to get raw PCM instead.

## Interrupt handling

When the caller speaks while the agent is talking, the adapter sends `clearAudio` to Plivo to cut off playback immediately. An inbound energy threshold provides a low-latency local signal without a separate VAD model. The adapter also translates the agent's `playback_interrupt` message into `clearAudio`, so speech detected by Flux STT (`WorkersAIFluxSTT`) interrupts Plivo playback even when it falls below the local threshold.

## Limitations

- **Call end detection**: Plivo does not send an explicit stop event when a call ends. The adapter detects call termination via WebSocket close.

## Credentials

`setupPlivoApplication` needs these to provision the application. They are used
at deploy time only — the adapter Worker itself makes no Plivo REST calls at
runtime, so it needs no Plivo secrets.

| Variable             | Description                                       |
| -------------------- | ------------------------------------------------- |
| `PLIVO_AUTH_ID`      | Plivo Auth ID from cx.plivo.com                   |
| `PLIVO_AUTH_TOKEN`   | Plivo Auth Token from cx.plivo.com                |
| `PLIVO_PHONE_NUMBER` | Phone number in E.164 format, e.g. `+12025551234` |

## Same agent, every channel

The same `VoiceAgent` instance can handle:

- **Web voice** via the `@cloudflare/voice` browser client
- **Phone calls** via this Plivo adapter
- **Text chat** via `sendText()`
- **Email** via `routeAgentEmail()`

All channels share the same conversation history (SQLite), state, tools, and scheduling.
