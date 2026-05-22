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

The package root is server-safe and does not import browser WebRTC code. Use
`/browser` only when you need the browser-side PSTN bridge:

```ts
import { TelnyxSTT } from "@cloudflare/voice-telnyx/stt";
import { TelnyxTTS } from "@cloudflare/voice-telnyx/tts";
import { TelnyxJWTEndpoint } from "@cloudflare/voice-telnyx";
import { TelnyxCallBridge } from "@cloudflare/voice-telnyx/browser";
```

## Worker voice agent

```ts
import { Agent, routeAgentRequest } from "agents";
import { withVoice, type VoiceTurnContext } from "@cloudflare/voice";
import { TelnyxSTT } from "@cloudflare/voice-telnyx/stt";
import { TelnyxTTS } from "@cloudflare/voice-telnyx/tts";

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

Server-side token helpers are available from the package root. Browser-side
WebRTC/PSTN helpers are exported from `@cloudflare/voice-telnyx/browser`.

```ts
import { TelnyxJWTEndpoint } from "@cloudflare/voice-telnyx";
import {
  createTelnyxVoiceConfig,
  TelnyxPhoneClient
} from "@cloudflare/voice-telnyx/browser";
import { WebSocketVoiceTransport } from "@cloudflare/voice/client";
```

Create a server-side endpoint that keeps your Telnyx API key secret. The endpoint requires an `authorize` callback by default so a public route cannot mint Telnyx credentials for arbitrary clients:

```ts
const jwt = new TelnyxJWTEndpoint({
  apiKey: env.TELNYX_API_KEY,
  credentialConnectionId: env.TELNYX_CREDENTIAL_CONNECTION_ID,
  allowedOrigins: ["https://your-app.example"],
  authorize: async (request) => {
    // Check your app session, signed token, or other auth state here.
    return Boolean(request.headers.get("Authorization"));
  }
});

return jwt.handleRequest(request);
```

Create a browser bridge and connect it with `TelnyxPhoneClient`:

```ts
const telnyx = await createTelnyxVoiceConfig({
  jwtEndpoint: "/api/telnyx-token",
  autoAnswer: true
});

const client = new TelnyxPhoneClient({
  transport: new WebSocketVoiceTransport({ agent: "my-voice-agent" }),
  bridge: telnyx.bridge
});
```

`TelnyxPhoneClient` sends phone-call audio to the agent as PCM16. For playback,
it routes PCM16 responses directly to the phone bridge and decodes formats such
as MP3 in the browser before playback. If you use the lower-level
`TelnyxPhoneTransport`, configure your server agent to send PCM16 audio because
that transport does not decode non-PCM formats.

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
