# Client Tool Auto-Continuation

## Overview

By default, client-executed tools and server-executed tools behave differently:

- **Server tools**: Execute and continue responding in the same turn
- **Client tools**: Execute, then require a new request to continue

The `autoContinueAfterToolResult` option lets client tools behave like server tools - the assistant can call a tool and immediately follow up with a response in one seamless turn.

## How It Works

```typescript
import { useAgentChat } from "@cloudflare/ai-chat/react";

const { messages, addToolResult } = useAgentChat({
  agent,
  tools: myClientTools,
  autoContinueAfterToolResult: true
});
```

When enabled:

1. Client executes the tool and sends the result to the server
2. Server automatically calls `onChatMessage()` to continue
3. The LLM's continuation is merged into the same assistant message
4. User sees a single, seamless response
