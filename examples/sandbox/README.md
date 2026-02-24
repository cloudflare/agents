# Sandbox Agent

A chat agent with a live terminal panel, powered by [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) and [OpenCode](https://opencode.ai). The UI is split — chat on the left, an interactive xterm.js terminal on the right connected to the same sandbox container. The agent can run commands visibly in the terminal, or silently when it just needs the output.

## Prerequisites

- Docker must be running locally (the sandbox container is built with Docker)
- An Anthropic API key (for OpenCode inside the sandbox)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
npm start
```

First run builds the Docker container image (~2-3 minutes). Subsequent runs use the cached image.

## What it demonstrates

- **Live terminal panel** — xterm.js connected via WebSocket to the sandbox PTY using `SandboxAddon` from `@cloudflare/sandbox/xterm`. Type directly into the terminal or let the agent run commands there.
- **Agent ↔ terminal interaction** — the `run_in_terminal` tool lets the agent type commands into the user's terminal (e.g., starting a dev server). The `exec` tool runs commands silently when the agent needs the output.
- **Agents SDK** — `AIChatAgent` with server-side tools and WebSocket chat
- **Sandbox SDK** — on-demand container with `@cloudflare/sandbox`
- **OpenCode integration** — `createOpencode()` for programmatic AI coding inside the sandbox
- **Lazy resource creation** — sandbox only spins up when the AI decides a coding task is needed

## Architecture

```
Browser                          Worker                        Sandbox Container
┌──────────┬──────────┐
│  Chat    │ Terminal  │
│  Panel   │ (xterm)  │
│          │    ↕ WS   │──── /ws/terminal ──→ sandbox.terminal() ──→ PTY shell
│  Agent ←─┼──→ WS    │──── /agents/*    ──→ ChatAgent DO
│          │          │                        ├─ exec tool     ──→ sandbox.exec()
│          │          │                        ├─ code tool     ──→ OpenCode SDK
│          │          │                        └─ run_in_terminal → client writes to PTY
└──────────┴──────────┘
```
