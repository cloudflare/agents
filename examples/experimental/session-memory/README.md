# Session Memory Example

Demonstrates the experimental `Session` API for conversation history with automatic compaction.

## Session API

```typescript
import {
  Session,
  AgentSessionProvider
} from "agents/experimental/memory/session";

export class ChatAgent extends Agent<Env> {
  // microCompaction is enabled by default — truncates tool outputs
  // and long text in older messages on every append()
  session = new Session(new AgentSessionProvider(this), {
    compaction: { tokenThreshold: 10000, fn: compactMessages }
  });

  @callable()
  async chat(message: string): Promise<string> {
    await this.session.append({
      id: `user-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: message }]
    });
    const response = await generateResponse(this.session.getMessages());
    await this.session.append({
      id: `asst-${Date.now()}`,
      role: "assistant",
      parts: [{ type: "text", text: response }]
    });
    return response;
  }
}
```

## Setup

```bash
npm install
npm start
```
