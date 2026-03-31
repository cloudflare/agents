# Session Multichat Example

Demonstrates the experimental `SessionManager` API for managing multiple independent chat sessions within a single Agent.

## SessionManager API

```typescript
import { SessionManager } from "agents/experimental/memory/session";
import { createCompactFunction } from "agents/experimental/memory/utils";

export class MultiSessionAgent extends Agent<Env> {
  manager = SessionManager.create(this)
    .withContext("soul", { initialContent: "You are helpful.", readonly: true })
    .withContext("memory", { description: "Learned facts", maxTokens: 1100 })
    .onCompaction(createCompactFunction({ summarize, tailTokenBudget: 150 }))
    .compactAfter(1000)
    .withCachedPrompt();

  @callable({ streaming: true })
  async chat(stream: StreamingResponse, chatId: string, message: string) {
    const session = this.manager.getSession(chatId);
    await session.appendMessage({ id, role: "user", parts: [{ type: "text", text: message }] });

    const result = streamText({
      system: await session.freezeSystemPrompt(),
      messages: await convertToModelMessages(session.getHistory()),
      tools: { ...(await session.tools()), ...this.manager.tools() },
    });

    for await (const chunk of result.textStream) {
      stream.send({ type: "text-delta", text: chunk });
    }

    // Build final message from steps and persist
    await session.appendMessage(assistantMsg);
    stream.end({ message: assistantMsg });
  }
}
```

## Setup

```bash
npm install
npm start
```
