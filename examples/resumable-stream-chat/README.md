# Resumable Streaming Chat

A real-time AI streaming chat that **automatically resumes** when you disconnect and reconnect. Built with Cloudflare Agents and Durable Objects.

## What this demonstrates

- **Resumable streaming**: Start a long AI response, refresh the page, and watch it pick up exactly where it left off
- **Automatic reconnection**: The WebSocket reconnects automatically, no user action needed
- **Message persistence**: Chat history survives disconnects and page reloads via `useAgentChat`
- **Buffered chunk replay**: All chunks generated while disconnected are replayed on reconnect

## Getting started

1. Copy the environment template and add your OpenAI API key:

   ```sh
   cp .env.example .env
   ```

2. Install dependencies from the repo root:

   ```sh
   npm install
   ```

3. Start the dev server:

   ```sh
   npm start
   ```

## How it works

The server (`src/server.ts`) uses `AIChatAgent` with `streamText` — nothing special is needed. Resumability is built into the agent protocol.

The client (`src/client.tsx`) uses `useAgentChat` which automatically handles:

1. Detecting an active stream on reconnect
2. Sending an ACK to the server
3. Receiving all buffered chunks and continuing the stream

## Configuration

| Variable         | Description         |
| ---------------- | ------------------- |
| `OPENAI_API_KEY` | Your OpenAI API key |

## Stack

- **Runtime**: Cloudflare Workers + Durable Objects
- **UI**: React, Tailwind CSS, [Kumo](https://kumo-ui.com/) (workers theme)
- **AI**: Vercel AI SDK with OpenAI
- **Build**: Vite + `@cloudflare/vite-plugin`
