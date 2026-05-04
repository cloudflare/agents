# Telnyx Voice Agent

A small starter that uses Telnyx STT and TTS with `@cloudflare/voice` and a Workers AI LLM.

Browser microphone audio flows to a Cloudflare Agent, Telnyx transcribes it, Workers AI generates a response, and Telnyx synthesizes the response back to browser audio.

## Setup

```bash
npm install
cp examples/telnyx-voice-agent/.env.example examples/telnyx-voice-agent/.dev.vars
```

Edit `.dev.vars` and set:

```bash
TELNYX_API_KEY=...
```

For deployed Workers, store the API key as a secret:

```bash
cd examples/telnyx-voice-agent
wrangler secret put TELNYX_API_KEY
```

## Run locally

```bash
npm run start -w @cloudflare/agents-telnyx-voice-agent
```

Open the local URL, click **Start talking**, and speak into your microphone.

## Deploy

```bash
npm run deploy -w @cloudflare/agents-telnyx-voice-agent
```

## Optional telephony

This starter includes a `/api/telnyx-token` endpoint for browser-side Telnyx WebRTC/PSTN experiments, but the default UI only demonstrates STT/TTS.

To use the telephony helpers from `@cloudflare/voice-telnyx/telephony`, also set:

```bash
TELNYX_CREDENTIAL_CONNECTION_ID=...
```

When routing server audio to a Telnyx phone call, configure your server voice agent with `withVoice(Agent, { audioFormat: "pcm16" })` and create the client with `preferredFormat: "pcm16"`, because phone playback expects 16 kHz mono PCM16 audio.
