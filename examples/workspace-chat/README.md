# Workspace Chat

An AI chat agent with a persistent virtual filesystem. Demonstrates a `Workspace` from [`@cloudflare/computer`](https://github.com/cloudflare/computer) integrated with `AIChatAgent` from `@cloudflare/ai-chat`, using Computer's AI SDK tools for file work and a Dynamic Worker backend for running code.

## What it shows

- **Workspace tools** — `createAITools()` gives the model `read`, `ls`, `find`, `grep`, `write`, `edit`, and `delete`, plus `exec` because the Workspace has a backend
- **Code execution** — `exec` runs a JavaScript module against the workspace in a Dynamic Worker, with `node:fs/promises` and git through the `ws:git` module
- **Persistent storage** — Files survive across conversations (backed by Durable Object SQLite)
- **File browser sidebar** — Browse workspace contents alongside the chat
- **Streaming responses** — Uses Workers AI with streaming via the AI SDK

## Run it

```sh
npm install
npm start
```

## Key pattern

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { Workspace } from "@cloudflare/computer";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { createGitClient } from "@cloudflare/computer/git";
import { createGitModule } from "@cloudflare/computer/modules/git";
import { createAITools } from "@cloudflare/computer/tools/ai-sdk";

export class WorkspaceChatAgent extends AIChatAgent {
  workspace = new Workspace({
    storage: this.ctx.storage,
    git: createGitClient(),
    backends: [
      new WorkerJavaScriptBackend({
        id: "js",
        loader: this.env.LOADER,
        access: "read-write",
        modules: { "ws:git": createGitModule({ allowNetwork: true }) }
      })
    ]
  });

  async onChatMessage(_onFinish, options) {
    return streamText({
      model,
      messages: await convertToModelMessages(this.messages),
      tools: createAITools({ workspace: this.workspace })
    }).toUIMessageStreamResponse();
  }
}
```

## Try these prompts

- "Create a hello world HTML page at /workspace/index.html"
- "Show me what files are in the workspace"
- "Create a Node.js project with package.json and src/index.ts"
- "Find all .ts files in the workspace"
- "Rename `foo` to `bar` across every file in /workspace/src"
- "Initialise a git repo, commit everything, and show me the log"
