# Custom Message Types in AIChatAgent

The `AIChatAgent` class now supports custom message types through generic type parameters, allowing you to extend the base `UIMessage` type with additional fields for enhanced functionality.

## Overview

The `AIChatAgent` class accepts three generic parameters:

```typescript
AIChatAgent<Env, State, Message>;
```

- `Env`: Environment type containing bindings (default: `unknown`)
- `State`: State type for the agent (default: `unknown`)
- `Message`: Message type extending `UIMessage` (default: `UIMessage`)

## Basic Usage (Backward Compatible)

Existing code continues to work without changes:

```typescript
import { AIChatAgent } from "agents/ai-chat-agent";

export class MyAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish) {
    // this.messages is UIMessage[]
    const messageCount = this.messages.length;
    // ... rest of implementation
  }
}
```

## Custom Message Types

### Defining a Custom Message Type

Create an interface that extends `UIMessage`:

```typescript
import type { UIMessage } from "ai";

interface CustomMessage extends UIMessage {
  priority: "high" | "medium" | "low";
  category: string;
  tags?: string[];
  metadata?: {
    source: string;
    timestamp: number;
    [key: string]: any;
  };
}
```

### Using Custom Message Types

Specify your custom message type as the third generic parameter:

```typescript
import { AIChatAgent } from "agents/ai-chat-agent";

export class CustomAgent extends AIChatAgent<Env, State, CustomMessage> {
  async onChatMessage(onFinish) {
    // this.messages is now CustomMessage[] with full type safety
    const highPriorityMessages = this.messages.filter(
      (msg) => msg.priority === "high"
    );

    return createDataStreamResponse({
      execute: async (dataStream) => {
        const stream = streamText({
          model: openai("gpt-4o"),
          messages: convertToModelMessages(this.messages),
          onFinish
        });
        stream.mergeIntoDataStream(dataStream);
      }
    });
  }

  // Custom methods with full type safety
  getMessagesByCategory(category: string): CustomMessage[] {
    return this.messages.filter((msg) => msg.category === category);
  }

  getHighPriorityMessages(): CustomMessage[] {
    return this.messages.filter((msg) => msg.priority === "high");
  }

  async saveCustomMessages(messages: CustomMessage[]) {
    // Type-safe message saving
    await this.saveMessages(messages);
  }
}
```

## Advanced Examples

### Multi-level Message Inheritance

```typescript
interface BaseCustomMessage extends UIMessage {
  priority: "high" | "medium" | "low";
  category: string;
}

interface ExtendedMessage extends BaseCustomMessage {
  workflow: {
    stage: string;
    assignee: string;
    dueDate?: Date;
  };
  attachments?: Array<{
    type: string;
    url: string;
    size: number;
  }>;
}

export class WorkflowAgent extends AIChatAgent<Env, State, ExtendedMessage> {
  async processWorkflowMessages() {
    for (const message of this.messages) {
      // Full type safety for all properties
      console.log(`Stage: ${message.workflow.stage}`);
      console.log(`Assignee: ${message.workflow.assignee}`);
      console.log(`Priority: ${message.priority}`);
    }
  }

  getMessagesByStage(stage: string): ExtendedMessage[] {
    return this.messages.filter((msg) => msg.workflow.stage === stage);
  }
}
```

### Message Filtering and Processing

```typescript
interface AnalyticsMessage extends UIMessage {
  analytics: {
    sentiment: "positive" | "negative" | "neutral";
    confidence: number;
    topics: string[];
  };
  userContext: {
    userId: string;
    sessionId: string;
    location?: string;
  };
}

export class AnalyticsAgent extends AIChatAgent<Env, State, AnalyticsMessage> {
  async analyzeSentiment() {
    const sentimentData = this.messages.map((msg) => ({
      sentiment: msg.analytics.sentiment,
      confidence: msg.analytics.confidence,
      userId: msg.userContext.userId
    }));

    return this.generateSentimentReport(sentimentData);
  }

  getMessagesByTopic(topic: string): AnalyticsMessage[] {
    return this.messages.filter((msg) => msg.analytics.topics.includes(topic));
  }
}
```

## Migration from Standard Messages

Existing agents can be gradually migrated:

1. Define your custom message interface
2. Update the agent class declaration to use the generic parameter
3. Add type assertions where needed during transition
4. Implement custom methods that leverage the new fields

```typescript
// Before
export class MyAgent extends AIChatAgent<Env> {
  // messages: UIMessage[]
}

// After
export class MyAgent extends AIChatAgent<Env, State, CustomMessage> {
  // messages: CustomMessage[]
}
```
