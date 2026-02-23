# Callable Methods

Callable methods let clients invoke agent methods over WebSocket using RPC (Remote Procedure Call). Mark methods with `@callable()` to expose them to external clients like browsers, mobile apps, or other services.

## Overview

```typescript
import { Agent, callable } from "agents";

export class MyAgent extends Agent {
  @callable()
  async greet(name: string): Promise<string> {
    return `Hello, ${name}!`;
  }
}
```

```typescript
// Client
const result = await agent.stub.greet("World");
console.log(result); // "Hello, World!"
```

### How It Works

```
┌─────────┐                           ┌─────────┐
│ Client  │                           │  Agent  │
└────┬────┘                           └────┬────┘
     │                                     │
     │  agent.stub.greet("World")          │
     │ ──────────────────────────────────▶ │
     │     WebSocket RPC message           │
     │                                     │
     │                              Check @callable
     │                              Execute method
     │                                     │
     │  ◀────────────────────────────────  │
     │     "Hello, World!"                 │
     │                                     │
```

### When to Use @callable

| Scenario                             | Use                           |
| ------------------------------------ | ----------------------------- |
| Browser/mobile calling agent         | `@callable()`                 |
| External service calling agent       | `@callable()`                 |
| Worker calling agent (same codebase) | DO RPC (no decorator needed)  |
| Agent calling another agent          | DO RPC via `getAgentByName()` |

The `@callable()` decorator is specifically for WebSocket-based RPC from external clients. When calling from within the same Worker or another agent, use standard [Durable Object RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/) directly.

## TypeScript Configuration

The `@callable()` decorator requires TypeScript's decorator support. Set `"target"` to `"ES2021"` or later in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2021"
  }
}
```

Without this, your dev server will fail with `SyntaxError: Invalid or unexpected token`. Setting the target to `ES2021` ensures that Vite's esbuild transpiler downlevels TC39 decorators instead of passing them through as native syntax.

> **Warning:** Do not set `"experimentalDecorators": true` in your `tsconfig.json`. The Agents SDK uses [TC39 standard decorators](https://github.com/tc39/proposal-decorators), not TypeScript legacy decorators. Enabling `experimentalDecorators` applies an incompatible transform that silently breaks `@callable()` at runtime.

## Basic Usage

### Defining Callable Methods

Add the `@callable()` decorator to any method you want to expose:

```typescript
import { Agent, callable } from "agents";

type State = {
  count: number;
  items: string[];
};

export class CounterAgent extends Agent<Env, State> {
  initialState: State = { count: 0, items: [] };

  @callable()
  increment(): number {
    this.setState({ ...this.state, count: this.state.count + 1 });
    return this.state.count;
  }

  @callable()
  decrement(): number {
    this.setState({ ...this.state, count: this.state.count - 1 });
    return this.state.count;
  }

  @callable()
  async addItem(item: string): Promise<string[]> {
    this.setState({ ...this.state, items: [...this.state.items, item] });
    return this.state.items;
  }

  @callable()
  getStats(): { count: number; itemCount: number } {
    return {
      count: this.state.count,
      itemCount: this.state.items.length
    };
  }
}
```

### Calling from the Client

There are two ways to call methods from the client:

**Using `agent.stub` (recommended):**

```typescript
// Clean, typed syntax
const count = await agent.stub.increment();
const items = await agent.stub.addItem("new item");
const stats = await agent.stub.getStats();
```

**Using `agent.call()`:**

```typescript
// Explicit method name as string
const count = await agent.call("increment");
const items = await agent.call("addItem", ["new item"]);
const stats = await agent.call("getStats");
```

The `stub` proxy provides better ergonomics and TypeScript support.

## Method Signatures

### Serializable Types

Arguments and return values must be JSON-serializable:

```typescript
// ✅ Valid - primitives and plain objects
@callable()
processData(input: { name: string; count: number }): { result: boolean } {
  return { result: true };
}

// ✅ Valid - arrays
@callable()
processItems(items: string[]): number[] {
  return items.map(item => item.length);
}

// ❌ Invalid - non-serializable types
@callable()
badMethod(fn: Function, date: Date): Map<string, unknown> {
  // Functions, Dates, Maps, Sets, etc. cannot be serialized
}
```

### Async Methods

Both sync and async methods work:

```typescript
// Sync method
@callable()
add(a: number, b: number): number {
  return a + b;
}

// Async method
@callable()
async fetchUser(id: string): Promise<User> {
  const user = await this.sql`SELECT * FROM users WHERE id = ${id}`;
  return user[0];
}
```

### Void Methods

Methods that don't return a value:

```typescript
@callable()
async logEvent(event: string): Promise<void> {
  await this.sql`INSERT INTO events (name) VALUES (${event})`;
}
```

On the client, these still return a Promise that resolves when the method completes:

```typescript
await agent.stub.logEvent("user-clicked");
// Resolves when the server confirms execution
```

## Streaming Responses

For methods that produce data over time (like AI text generation), use streaming:

### Defining a Streaming Method

```typescript
import { Agent, callable, type StreamingResponse } from "agents";

export class AIAgent extends Agent {
  @callable({ streaming: true })
  async generateText(stream: StreamingResponse, prompt: string) {
    // First parameter is always StreamingResponse for streaming methods

    for await (const chunk of this.llm.stream(prompt)) {
      stream.send(chunk); // Send each chunk to the client
    }

    stream.end(); // Signal completion
  }

  @callable({ streaming: true })
  async streamNumbers(stream: StreamingResponse, count: number) {
    for (let i = 0; i < count; i++) {
      stream.send(i);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    stream.end(count); // Optional final value
  }
}
```

### Consuming Streams on the Client

```typescript
// Preferred format (supports timeout and other options)
await agent.call("generateText", [prompt], {
  stream: {
    onChunk: (chunk) => {
      // Called for each chunk
      appendToOutput(chunk);
    },
    onDone: (finalValue) => {
      // Called when stream ends
      console.log("Stream complete", finalValue);
    },
    onError: (error) => {
      // Called if an error occurs
      console.error("Stream error:", error);
    }
  }
});

// Legacy format (still supported for backward compatibility)
await agent.call("generateText", [prompt], {
  onChunk: (chunk) => appendToOutput(chunk),
  onDone: (finalValue) => console.log("Done", finalValue),
  onError: (error) => console.error("Error:", error)
});
```

### StreamingResponse API

| Method             | Description                                      |
| ------------------ | ------------------------------------------------ |
| `send(chunk)`      | Send a chunk to the client                       |
| `end(finalChunk?)` | End the stream, optionally with a final value    |
| `error(message)`   | Send an error to the client and close the stream |

```typescript
@callable({ streaming: true })
async processWithProgress(stream: StreamingResponse, items: string[]) {
  for (let i = 0; i < items.length; i++) {
    await this.process(items[i]);
    stream.send({ progress: (i + 1) / items.length, item: items[i] });
  }
  stream.end({ completed: true, total: items.length });
}
```

## TypeScript Integration

### Typed Client Calls

Pass your agent class as a type parameter for full type safety:

```typescript
import { useAgent } from "agents/react";
import type { MyAgent } from "./server";

function App() {
  const agent = useAgent<MyAgent, MyState>({
    agent: "MyAgent",
    name: "default"
  });

  // ✅ TypeScript knows the method signature
  const result = await agent.stub.greet("World");
  //    ^? string

  // ✅ TypeScript catches errors
  await agent.stub.greet(123); // Error: Argument of type 'number' is not assignable
  await agent.stub.nonExistent(); // Error: Property 'nonExistent' does not exist
}
```

### Excluding Non-Callable Methods

If you have methods that aren't decorated with `@callable()`, you can exclude them from the type:

```typescript
class MyAgent extends Agent {
  @callable()
  publicMethod(): string {
    return "public";
  }

  // Not callable from clients
  internalMethod(): void {
    // internal logic
  }
}

// Exclude internal methods from the client type
const agent = useAgent<Omit<MyAgent, "internalMethod">, {}>({
  agent: "MyAgent"
});

agent.stub.publicMethod(); // ✅ Works
agent.stub.internalMethod(); // ✅ TypeScript error
```

### Type Inference for State

When methods return `this.state`, TypeScript correctly infers the type:

```typescript
type MyState = { count: number; name: string };

class MyAgent extends Agent<Env, MyState> {
  @callable()
  async getState(): Promise<MyState> {
    return this.state;
  }
}

// Client
const state = await agent.stub.getState();
//    ^? MyState
```

## Error Handling

### Throwing Errors in Callable Methods

Errors thrown in callable methods are propagated to the client:

```typescript
@callable()
async riskyOperation(data: unknown): Promise<void> {
  if (!isValid(data)) {
    throw new Error("Invalid data format");
  }

  try {
    await this.processData(data);
  } catch (e) {
    throw new Error("Processing failed: " + e.message);
  }
}
```

### Client-Side Error Handling

```typescript
try {
  const result = await agent.stub.riskyOperation(data);
} catch (error) {
  // Error thrown by the agent method
  console.error("RPC failed:", error.message);
}
```

### Streaming Error Handling

For streaming methods, use the `onError` callback:

```typescript
await agent.call("streamData", [input], {
  stream: {
    onChunk: (chunk) => handleChunk(chunk),
    onError: (errorMessage) => {
      console.error("Stream error:", errorMessage);
      showErrorUI(errorMessage);
    },
    onDone: (result) => handleComplete(result)
  }
});
```

Server-side, you can use `stream.error()` to gracefully send an error mid-stream:

```typescript
@callable({ streaming: true })
async processItems(stream: StreamingResponse, items: string[]) {
  for (const item of items) {
    try {
      const result = await this.process(item);
      stream.send(result);
    } catch (e) {
      stream.error(`Failed to process ${item}: ${e.message}`);
      return; // Stream is now closed
    }
  }
  stream.end();
}
```

### Connection Errors

If the WebSocket connection closes while RPC calls are pending, they automatically reject with a "Connection closed" error:

```typescript
try {
  const result = await agent.call("longRunningMethod", []);
} catch (error) {
  if (error.message === "Connection closed") {
    // Handle disconnection
    console.log("Lost connection to agent");
  }
}
```

#### Retrying After Reconnection

PartySocket automatically reconnects after disconnection. To retry a failed call after reconnection, await `agent.ready` before retrying:

```typescript
async function callWithRetry<T>(
  agent: AgentClient,
  method: string,
  args: unknown[] = []
): Promise<T> {
  try {
    return await agent.call(method, args);
  } catch (error) {
    if (error.message === "Connection closed") {
      await agent.ready; // Wait for reconnection
      return await agent.call(method, args); // Retry once
    }
    throw error;
  }
}

// Usage
const result = await callWithRetry(agent, "processData", [data]);
```

> **Note:** Only retry idempotent operations. If the server received the request but the connection dropped before the response arrived, retrying could cause duplicate execution.

## When NOT to Use @callable

### Worker-to-Agent Calls

When calling an agent from the same Worker (e.g., in your `fetch` handler), use Durable Object RPC directly:

```typescript
import { getAgentByName } from "agents";

export default {
  async fetch(request: Request, env: Env) {
    // Get the agent stub
    const agent = await getAgentByName(env.MyAgent, "instance-name");

    // Call methods directly - no @callable needed
    const result = await agent.processData(data);

    return Response.json(result);
  }
};
```

### Agent-to-Agent Calls

When one agent needs to call another:

```typescript
class OrchestratorAgent extends Agent {
  async delegateWork(taskId: string) {
    // Get another agent
    const worker = await getAgentByName(this.env.WorkerAgent, taskId);

    // Call its methods directly
    const result = await worker.doWork();

    return result;
  }
}
```

### Why the Distinction?

| RPC Type    | Transport | Use Case                          |
| ----------- | --------- | --------------------------------- |
| `@callable` | WebSocket | External clients (browsers, apps) |
| DO RPC      | Internal  | Worker ↔ Agent, Agent ↔ Agent     |

DO RPC is more efficient for internal calls since it doesn't go through WebSocket serialization. The `@callable` decorator adds the necessary WebSocket RPC handling for external clients.

## API Reference

### `@callable(metadata?)` Decorator

Marks a method as callable from external clients.

```typescript
import { callable } from "agents";

@callable()
method(): void {}

@callable({ streaming: true })
streamingMethod(stream: StreamingResponse): void {}

@callable({ description: "Fetches user data" })
getUser(id: string): User {}
```

### `CallableMetadata` Type

```typescript
type CallableMetadata = {
  /** Optional description of what the method does */
  description?: string;
  /** Whether the method supports streaming responses */
  streaming?: boolean;
};
```

### `StreamingResponse` Class

Used in streaming callable methods to send data to the client.

```typescript
import { type StreamingResponse } from "agents";

@callable({ streaming: true })
async streamData(stream: StreamingResponse, input: string) {
  stream.send("chunk 1");
  stream.send("chunk 2");
  stream.end("final");
}
```

| Method  | Signature                        | Description                        |
| ------- | -------------------------------- | ---------------------------------- |
| `send`  | `(chunk: unknown) => void`       | Send a chunk to the client         |
| `end`   | `(finalChunk?: unknown) => void` | End the stream                     |
| `error` | `(message: string) => void`      | Send an error and close the stream |

### Client Methods

| Method       | Signature                              | Description           |
| ------------ | -------------------------------------- | --------------------- |
| `agent.call` | `(method, args?, options?) => Promise` | Call a method by name |
| `agent.stub` | `Proxy`                                | Typed method calls    |

```typescript
// Using call()
await agent.call("methodName", [arg1, arg2]);
await agent.call("streamMethod", [arg], {
  stream: { onChunk, onDone, onError }
});

// With timeout (rejects if call doesn't complete in time)
await agent.call("slowMethod", [], { timeout: 5000 });

// Using stub
await agent.stub.methodName(arg1, arg2);
```

### `CallOptions` Type

```typescript
type CallOptions = {
  /** Timeout in milliseconds. Rejects if call doesn't complete in time. */
  timeout?: number;
  /** Streaming options */
  stream?: {
    onChunk?: (chunk: unknown) => void;
    onDone?: (finalChunk: unknown) => void;
    onError?: (error: string) => void;
  };
};
```

> **Backward Compatibility**: The legacy format `{ onChunk, onDone, onError }` (without nesting under `stream`) is still supported. The client auto-detects which format you're using.

### `getCallableMethods()` Method

Returns a map of all callable methods on the agent with their metadata. Useful for introspection and auto-documentation.

```typescript
const methods = agent.getCallableMethods();
// Map<string, CallableMetadata>

for (const [name, meta] of methods) {
  console.log(`${name}: ${meta.description || "(no description)"}`);
  if (meta.streaming) console.log("  (streaming)");
}
```
