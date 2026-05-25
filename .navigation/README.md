# Cloudflare Agents SDK — Maintainer Navigation Index

This directory is a structured reading guide for new maintainers. Each file covers one logical slice of the codebase, in an order that builds from fundamentals toward specialised features. All links open specific line ranges in the source so you can jump straight to what matters.

## How to read this

Work through the files in order. Each section starts with the "why" before pointing at the "what". Within a section, follow the links top-to-bottom — they are sequenced so each file's concepts rest on the ones already introduced.

## Sections

| File | What you will learn |
|---|---|
| [00-foundations.md](./00-foundations.md) | Core abstractions, wire types, utilities shared by everything |
| [01-agent-core.md](./01-agent-core.md) | The `Agent` class: lifecycle, state, SQL, scheduling, fibers, queues |
| [02-mcp.md](./02-mcp.md) | Model Context Protocol — server side (McpAgent) and client side (MCPClientManager) |
| [03-chat-protocol.md](./03-chat-protocol.md) | Streaming chat internals: wire protocol, chunk processing, concurrency control |
| [04-ai-chat-think.md](./04-ai-chat-think.md) | High-level chat agents: `AIChatAgent` and `Think` |
| [05-voice.md](./05-voice.md) | Voice pipeline: STT, TTS, SFU, and voice providers |
| [06-codemode-shell.md](./06-codemode-shell.md) | Sandboxed code execution and the virtual filesystem |
| [07-worker-bundler.md](./07-worker-bundler.md) | Runtime bundling: esbuild-wasm, module resolution, NPM installation |
| [08-integrations.md](./08-integrations.md) | Routing, email, workflows, Hono middleware, browser automation |
| [09-observability-experimental.md](./09-observability-experimental.md) | Observability channels, experimental memory/session system, WebMCP |

## Repository layout (quick reference)

```
packages/
  agents/          Core SDK — Agent class, MCP, chat protocol, browser tools
  ai-chat/         @cloudflare/ai-chat — higher-level chat agent
  think/           @cloudflare/think   — opinionated agent with agentic loop
  voice/           @cloudflare/voice   — voice pipeline
  codemode/        @cloudflare/codemode — LLM-generated code execution
  shell/           @cloudflare/shell   — virtual filesystem + git
  worker-bundler/  @cloudflare/worker-bundler — build Workers at runtime
  hono-agents/     hono-agents — Hono framework integration

voice-providers/
  deepgram/   ElevenLabs/   twilio/   telnyx/

examples/          40+ self-contained demo Workers
guides/            Narrative walkthroughs (Anthropic patterns, human-in-the-loop)
experimental/      WIP features (memory, gadgets, WebMCP)
```

## Coverage script

To see how much of the source code this index covers:

```bash
node .navigation/coverage.js
node .navigation/coverage.js --uncovered   # list files not yet referenced
node .navigation/coverage.js --verbose     # per-file coverage bars
```
