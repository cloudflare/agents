# @cloudflare/agents-opencode

OpenCode integration for Cloudflare Agents — session management, streaming, file watching, and provider detection.

## Installation

```bash
npm install @cloudflare/agents-opencode
```

## Quick Start

Drop the high-level `opencodeTask()` tool into any `streamText` call:

```typescript
import { opencodeTask } from "@cloudflare/agents-opencode";

const result = streamText({
  model: workersai("@cf/moonshotai/kimi-k2.5"),
  tools: {
    opencode: opencodeTask({
      sandbox: env.Sandbox,
      name: this.name,
      env,
      storage: this.ctx.storage
    })
  }
});
```

For full lifecycle control, use `OpenCodeSession` directly:

```typescript
import { OpenCodeSession } from "@cloudflare/agents-opencode";

const session = new OpenCodeSession(env.Sandbox, agentName);
await session.start(env, storage);

for await (const snapshot of session.run("Build a TODO app")) {
  // snapshot: OpenCodeRunOutput with UIMessage[], status, files, etc.
}

await session.backup(storage);
```

## Peer Dependencies

- `@cloudflare/sandbox` (>=0.8.0) — sandbox container management
- `@opencode-ai/sdk` (>=0.1.0) — OpenCode client and types
- `ai` (>=6.0.0) — AI SDK for tool/message primitives
- `zod` (>=4.0.0) — schema validation

See the [OpenCode example](../../examples/opencode) for a full working demo, or the [AGENTS.md](./AGENTS.md) for detailed architecture and event handling docs.
