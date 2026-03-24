# Workspace Chat

An AI chat agent with a persistent virtual filesystem. Demonstrates `Workspace` from `@cloudflare/shell` integrated with `AIChatAgent` from `@cloudflare/ai-chat`, using `@cloudflare/codemode` for sandboxed multi-file JS execution with `state.*`.

## What it shows

- **Workspace as tool backend** — The AI has tools to read, write, list, delete files, create directories, glob search, and run sandboxed state scripts
- **Persistent storage** — Files survive across conversations (backed by Durable Object SQLite)
- **File browser sidebar** — Browse workspace contents in real-time alongside the chat
- **Streaming responses** — Uses Workers AI with streaming via the AI SDK
- **Sandboxed JS refactors** — Multi-file edits run through `@cloudflare/codemode` with `state.*` instead of bash

## Run it

```sh
npm install
npm start
```

## Key pattern

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { Workspace } from "@cloudflare/shell";
import { stateTools } from "@cloudflare/shell/workers";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";

export class WorkspaceChatAgent extends AIChatAgent {
  workspace = new Workspace({ sql: this.ctx.storage.sql, namespace: "ws" });

  async onChatMessage(_onFinish, options) {
    return streamText({
      tools: {
        readFile: tool({
          execute: async ({ path }) => this.workspace.readFile(path)
        }),
        writeFile: tool({
          execute: async ({ path, content }) =>
            this.workspace.writeFile(path, content)
        }),
        runStateCode: tool({
          execute: async ({ code }) => {
            const executor = new DynamicWorkerExecutor({
              loader: this.env.LOADER
            });
            return executor.execute(code, [
              resolveProvider(stateTools(this.workspace))
            ]);
          }
        })
      }
    }).toUIMessageStreamResponse();
  }
}
```

## Try these prompts

- "Create a hello world HTML page at /index.html"
- "Show me what files are in the workspace"
- "Create a Node.js project with package.json and src/index.ts"
- "Find all .ts files in the workspace"
- "Use the state runtime to rename `foo` to `bar` across all files in /src"
- "Plan edits for /src/config.json and /src/index.ts, preview them, then apply the plan"
