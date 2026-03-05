# Workspace Chat

An AI chat agent with a persistent virtual filesystem. Demonstrates `Workspace` from `agents/experimental/workspace` integrated with `AIChatAgent` from `@cloudflare/ai-chat`.

## What it shows

- **Workspace as tool backend** — The AI has tools to read, write, list, delete files, create directories, run bash commands, and glob search
- **Persistent storage** — Files survive across conversations (backed by Durable Object SQLite)
- **File browser sidebar** — Browse workspace contents in real-time alongside the chat
- **Streaming responses** — Uses Workers AI with streaming via the AI SDK

## Run it

```sh
npm install
npm start
```

## Key pattern

```typescript
import { AIChatAgent } from "@cloudflare/ai-chat";
import { Workspace } from "agents/experimental/workspace";

export class WorkspaceChatAgent extends AIChatAgent {
  workspace = new Workspace(this, { namespace: "ws" });

  async onChatMessage(_onFinish, options) {
    return streamText({
      // ...
      tools: {
        readFile: tool({
          execute: async ({ path }) => {
            return await this.workspace.readFile(path);
          }
        }),
        writeFile: tool({
          execute: async ({ path, content }) => {
            await this.workspace.writeFile(path, content);
          }
        }),
        bash: tool({
          execute: async ({ command }) => {
            return await this.workspace.bash(command);
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
- "Run `ls -la /` in the terminal"
