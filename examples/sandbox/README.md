# Sandbox Agent

A chat agent that lazily spins up a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) with [OpenCode](https://opencode.ai) when you ask it to build something. Normal conversation stays lightweight — the sandbox container only starts when a coding task is needed.

## Prerequisites

- Docker must be running locally (the sandbox container is built with Docker)
- An Anthropic API key (for OpenCode inside the sandbox)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
npm run dev
```

First run builds the Docker container image (~2-3 minutes). Subsequent runs use the cached image.

## What it demonstrates

- **Agents SDK** — `AIChatAgent` with server-side tools and WebSocket chat
- **Sandbox SDK** — on-demand container with `@cloudflare/sandbox`
- **OpenCode integration** — `createOpencode()` for programmatic AI coding inside the sandbox
- **Lazy resource creation** — sandbox only spins up when the AI decides a coding task is needed
