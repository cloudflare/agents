# @cloudflare/agents-voice-twilio

Twilio Media Streams adapter for the [Cloudflare Agents](https://github.com/cloudflare/agents) voice pipeline. Connects phone calls to your `VoiceAgent` — the same agent that handles web voice, text chat, and email can now answer the phone.

## How it works

```
Phone call → Twilio → Media Streams WebSocket → TwilioAdapter → VoiceAgent (Durable Object)
                                                                    ↓
                                                              STT → LLM → TTS
                                                                    ↓
Phone speaker ← Twilio ← mulaw 8kHz audio ← TwilioAdapter ← VoiceAgent
```

The adapter bridges Twilio's bidirectional Media Streams protocol (mulaw 8kHz, base64 JSON) to VoiceAgent's binary PCM protocol (16kHz, 16-bit LE). Audio resampling and encoding conversion happen automatically.

## Install

```bash
npm install @cloudflare/agents-voice-twilio
```

## Usage

### 1. Add the adapter to your Worker

```typescript
import { VoiceAgent, type VoiceTurnContext } from "agents/voice";
import { routeAgentRequest } from "agents";
import { TwilioAdapter } from "@cloudflare/agents-voice-twilio";

export class MyAgent extends VoiceAgent<Env> {
  async onTurn(transcript: string, context: VoiceTurnContext) {
    // Same agent handles both web and phone calls
    return "Hello! How can I help you?";
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Twilio sends WebSocket connections to this path
    if (url.pathname === "/twilio") {
      return TwilioAdapter.handleRequest(request, env, "MyAgent");
    }

    // Normal agent routing for web clients
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
};
```

### 2. Configure Twilio

In your Twilio console, set up a TwiML Bin or webhook that streams media to your Worker:

```xml
<Response>
  <Connect>
    <Stream url="wss://your-worker.your-account.workers.dev/twilio" />
  </Connect>
</Response>
```

### 3. Assign a phone number

Attach the TwiML to a Twilio phone number. When someone calls that number, Twilio streams the audio to your Worker, which routes it to your VoiceAgent.

## Options

```typescript
TwilioAdapter.handleRequest(request, env, "MyAgent", {
  // Use a custom instance name instead of the Twilio Call SID
  instanceName: "shared-agent"
});
```

By default, each phone call creates a new VoiceAgent instance (using the Twilio Call SID as the instance name). Set `instanceName` to route multiple calls to the same agent instance.

## Limitations

- **TTS output format**: VoiceAgent's default TTS (Workers AI Deepgram Aura) outputs MP3. Twilio expects mulaw 8kHz. The adapter currently handles inbound audio conversion (mulaw → PCM) but outbound audio conversion (MP3 → mulaw) requires an MP3 decoder. For production use, configure a TTS provider that outputs mulaw or PCM directly, or use the `beforeSynthesize`/`afterSynthesize` hooks to handle format conversion.

## Same agent, every channel

The same `VoiceAgent` instance can handle:

- **Web voice** via `VoiceClient` / `useVoiceAgent`
- **Phone calls** via this Twilio adapter
- **Text chat** via `sendText()`
- **Email** via `routeAgentEmail()`

All channels share the same conversation history (SQLite), state, tools, and scheduling.
