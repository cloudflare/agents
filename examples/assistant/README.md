# Assistant

A general-purpose coding assistant with a persistent virtual filesystem (Workspace). The agent can read, write, edit, find, and search files using workspace-backed tools.

## Run it

```bash
npm install && npm start
```

## What it demonstrates

- `Workspace` for durable file storage inside a Durable Object
- `createWorkspaceTools()` to generate AI SDK tools from a Workspace
- Tools: `read`, `write`, `edit`, `list`, `find`, `grep`
- Streaming responses with tool execution visibility

## Key pattern

```ts
import { Workspace } from "agents/workspace";
import { createWorkspaceTools } from "agents/experimental/assistant";

export class AssistantAgent extends AIChatAgent {
  workspace = new Workspace(this);

  async onChatMessage() {
    const tools = createWorkspaceTools(this.workspace);
    const result = streamText({ model, tools, messages });
    return result.toUIMessageStreamResponse();
  }
}
```

## Related

- [AI Chat example](../ai-chat/) — basic chat with tools and approval
- [Workspace docs](../../docs/workspace.md) — Workspace API reference
