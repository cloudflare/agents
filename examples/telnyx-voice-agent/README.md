# Telnyx Phone Voice Agent

A phone/PSTN voice agent that uses a browser-side Telnyx WebRTC bridge to route a live phone call through a Cloudflare Agent.

**Flow:** phone call → Telnyx WebRTC bridge in the browser → Cloudflare Agent → Telnyx STT → Workers AI → Telnyx TTS → audio injected back into the phone call.

## Prerequisites

1. A Telnyx account
2. A Telnyx API key
3. A Telnyx SIP Credential Connection
4. A Telnyx phone number assigned to that SIP connection

## Setup

```bash
npm install
cp examples/telnyx-voice-agent/.env.example examples/telnyx-voice-agent/.env
```

Edit `.env` and set:

```bash
TELNYX_API_KEY=...
TELNYX_CREDENTIAL_CONNECTION_ID=...
```

For deployed Workers, store both values as secrets:

```bash
cd examples/telnyx-voice-agent
wrangler secret put TELNYX_API_KEY
wrangler secret put TELNYX_CREDENTIAL_CONNECTION_ID
```

## Run locally

```bash
npm run start -w @cloudflare/agents-telnyx-voice-agent
```

Open the local URL and click **Connect phone bridge**. The browser fetches a short-lived Telnyx WebRTC token, opens a WebSocket to the Cloudflare Agent, then waits for an inbound phone call. Call the phone number assigned to your Telnyx SIP connection; inbound calls are auto-answered and routed through the AI agent.

The browser acts as a control panel and bridge. Audio comes from the phone call and returns to the phone call — it does not use the browser microphone or speakers.
Keep the browser tab open for the duration of the call; closing it closes the live WebRTC bridge.

## Deploy

```bash
npm run deploy -w @cloudflare/agents-telnyx-voice-agent
```

This example intentionally allows unauthenticated token creation for local demos.
Before deploying publicly, replace `allowUnauthenticated: true` with an
`authorize()` callback so arbitrary visitors cannot mint Telnyx credentials on
your account.

## Key pattern

The Worker exposes a JWT endpoint that creates browser Telnyx credentials without exposing the API key:

```ts
if (url.pathname === "/api/telnyx-token") {
  const endpoint = new TelnyxJWTEndpoint({
    apiKey: env.TELNYX_API_KEY,
    credentialConnectionId: env.TELNYX_CREDENTIAL_CONNECTION_ID,
    allowUnauthenticated: true // local demo only
  });
  return endpoint.handleRequest(request);
}
```

The browser creates the Telnyx bridge and gives it to `TelnyxPhoneClient`:

```ts
const telnyx = await createTelnyxVoiceConfig({
  jwtEndpoint: "/api/telnyx-token",
  autoAnswer: true
});

const phoneClient = new TelnyxPhoneClient({
  transport: new WebSocketVoiceTransport({ agent: "my-voice-agent" }),
  bridge: telnyx.bridge
});

phoneClient.connect();
```

For production, replace `allowUnauthenticated: true` with an `authorize()` callback before exposing browser-created Telnyx credentials.

## Related examples

- `examples/voice-agent` — browser microphone/speaker voice agent
- `examples/voice-input` — reusable voice input component
