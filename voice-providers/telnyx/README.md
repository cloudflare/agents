# @cloudflare/voice-telnyx

Telnyx voice providers for the Cloudflare Agents voice pipeline.

This package includes:

- **STT** — real-time speech-to-text via Telnyx's WebSocket transcription API.
- **TTS** — text-to-speech via Telnyx REST and Workers WebSocket backends.
- **Telephony** — Telnyx WebRTC/PSTN helpers for routing phone-call audio into a `@cloudflare/voice` agent.

## Installation

```bash
npm install @cloudflare/voice @cloudflare/voice-telnyx
```

## Subpath imports

Use subpaths to keep STT/TTS imports independent of browser telephony code:

```ts
import { TelnyxSTT } from "@cloudflare/voice-telnyx/stt";
import { TelnyxTTS } from "@cloudflare/voice-telnyx/tts";
import { TelnyxCallBridge } from "@cloudflare/voice-telnyx/telephony";

// Or import everything:
import {
  TelnyxSTT,
  TelnyxTTS,
  TelnyxCallBridge
} from "@cloudflare/voice-telnyx";
```

## Browser voice agent

```ts
import { Agent, routeAgentRequest } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { TelnyxSTT, TelnyxTTS } from "@cloudflare/voice-telnyx";

const VoiceAgent = withVoice(Agent);

export class MyVoiceAgent extends VoiceAgent<Env> {
  transcriber = new TelnyxSTT({ apiKey: this.env.TELNYX_API_KEY });
  tts = new TelnyxTTS({
    apiKey: this.env.TELNYX_API_KEY,
    voice: "Telnyx.NaturalHD.astra"
  });

  async onTurn(transcript: string, context: VoiceTurnContext) {
    return `You said: ${transcript}`;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
};
```

## API

### `TelnyxSTT`

Implements `Transcriber` from `@cloudflare/voice`.

```ts
const stt = new TelnyxSTT({
  apiKey: env.TELNYX_API_KEY,
  engine: "Telnyx", // or "Deepgram"
  language: "en",
  transcriptionModel: "nova-3", // optional, useful with Deepgram engine
  interimResults: true
});
```

The Cloudflare voice pipeline feeds raw 16 kHz mono PCM16 audio. Telnyx STT expects a container, so the default `inputFormat: "wav"` prepends a WAV header before streaming audio chunks.

### `TelnyxTTS`

Implements `TTSProvider` and `StreamingTTSProvider` from `@cloudflare/voice`.

```ts
const tts = new TelnyxTTS({
  apiKey: env.TELNYX_API_KEY,
  voice: "Telnyx.NaturalHD.astra",
  backend: "rest" // default; use "websocket" only in Workers runtime
});
```

- `backend: "rest"` works anywhere and returns one complete audio buffer per sentence.
- `backend: "websocket"` streams chunks with lower time-to-first-audio, but requires Cloudflare Workers' fetch-upgrade WebSocket pattern because authentication uses request headers.

### Telephony / PSTN bridge

```ts
import {
  TelnyxJWTEndpoint,
  createTelnyxVoiceConfig,
  TelnyxPhoneTransport
} from "@cloudflare/voice-telnyx/telephony";
import { WebSocketVoiceTransport, VoiceClient } from "@cloudflare/voice/client";
```

Create a server-side endpoint that keeps your Telnyx API key secret:

```ts
const jwt = new TelnyxJWTEndpoint({
  apiKey: env.TELNYX_API_KEY,
  credentialConnectionId: env.TELNYX_CREDENTIAL_CONNECTION_ID
});

return jwt.handleRequest(request);
```

Create a browser bridge and route server audio back to the phone call:

```ts
const telnyx = await createTelnyxVoiceConfig({
  jwtEndpoint: "/api/telnyx-token",
  autoAnswer: true
});

const transport = new TelnyxPhoneTransport({
  inner: new WebSocketVoiceTransport({ agent: "my-voice-agent" }),
  bridge: telnyx.bridge
});

const client = new VoiceClient({
  agent: "my-voice-agent",
  audioInput: telnyx.audioInput,
  transport,
  preferredFormat: "pcm16"
});
```

> **Important:** Phone playback expects 16 kHz mono PCM16 server audio. Configure your server agent with `withVoice(Agent, { audioFormat: "pcm16" })` when routing agent responses to Telnyx PSTN through `TelnyxPhoneTransport`.

## Environment variables

| Variable                          | Required       | Description                                                                   |
| --------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `TELNYX_API_KEY`                  | Yes            | Telnyx API key. Store as a Worker secret.                                     |
| `TELNYX_CREDENTIAL_CONNECTION_ID` | Telephony only | Credential connection ID used by `TelnyxJWTEndpoint` for WebRTC login tokens. |

Set secrets with Wrangler:

```bash
wrangler secret put TELNYX_API_KEY
wrangler secret put TELNYX_CREDENTIAL_CONNECTION_ID
```

## Attribution

This package is adapted from Telnyx's `@telnyx/voice-cloudflare` implementation, whose npm package metadata declares the MIT license.
