# Plivo Phone Voice Agent

A phone voice agent built on the Cloudflare Agents voice pipeline. Dial a Plivo number and have a real-time conversation with an AI agent. All models run on Workers AI; no third-party AI keys are required.

## How it works

```
Caller dials Plivo number
        ↓
Plivo fetches /answer → returns Stream XML → Plivo opens WebSocket to /plivo
        ↓
PlivoAdapter bridges the audio stream to MyVoiceAgent (Durable Object)
        ↓
STT: Workers AI Flux (@cf/deepgram/flux)
        ↓
LLM: Workers AI Kimi K2.6 (@cf/moonshotai/kimi-k2.6)
        ↓
TTS: Workers AI Deepgram Aura 2 (@cf/deepgram/aura-2-en, linear16 PCM)
        ↓
Audio back to caller via Plivo
```

## Prerequisites

1. A Plivo account with a voice-enabled phone number ([cx.plivo.com](https://cx.plivo.com))
2. A Cloudflare account with [Workers AI](https://developers.cloudflare.com/workers-ai/) access
3. Wrangler authenticated with your Cloudflare account (`npx wrangler login`)

## Setup

### 1. Install and build

From the repository root:

```bash
pnpm install
pnpm run build
```

The build compiles the workspace packages the example imports.

### 2. Configure credentials

```bash
cd examples/plivo-voice-agent
cp .env.example .env
```

Fill in `.env` with the values from [cx.plivo.com](https://cx.plivo.com) → Account → Overview. The phone number uses E.164 format, e.g. `+12025551234`. The deploy and dev commands read `.env` to provision Plivo — the Worker itself stores no Plivo secrets.

### 3. Deploy

```bash
pnpm run deploy
```

This runs `wrangler deploy`, reads the deployed Worker URL, and points your Plivo application and phone number at it automatically.

### 4. Call

Dial the Plivo number. The agent greets the caller and responds in real time. Speaking over the agent interrupts playback.

## Local development

```bash
pnpm run dev
```

Plivo's cloud can't reach localhost, so `pnpm run dev` starts the Worker, opens a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) tunnel, and points your Plivo application at the tunnel URL — the same one-command flow as deploy. Install `cloudflared` first; the script prints a link if it's missing. Run `pnpm run deploy` afterward to point Plivo back at your deployed Worker.
