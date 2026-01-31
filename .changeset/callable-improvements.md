---
"agents": patch
---

# Callable System Improvements

This release includes several improvements to the `@callable` decorator and RPC system:

## New Features

### Client-side RPC Timeout

You can now specify a timeout for RPC calls that will reject if the call doesn't complete in time:

```typescript
await agent.call("slowMethod", [], { timeout: 5000 });
```

### StreamingResponse.error()

New method to gracefully signal an error during streaming and close the stream:

```typescript
@callable({ streaming: true })
async processItems(stream: StreamingResponse, items: string[]) {
  for (const item of items) {
    try {
      const result = await this.process(item);
      stream.send(result);
    } catch (e) {
      stream.error(`Failed to process ${item}: ${e.message}`);
      return;
    }
  }
  stream.end();
}
```

### getCallableMethods() API

New method on the Agent class to introspect all callable methods and their metadata:

```typescript
const methods = agent.getCallableMethods();
// Returns Map<string, CallableMetadata>

for (const [name, meta] of methods) {
  console.log(`${name}: ${meta.description || "(no description)"}`);
}
```

### Connection Close Handling

Pending RPC calls are now automatically rejected with a "Connection closed" error when the WebSocket connection closes unexpectedly.

## Internal Improvements

- **WeakMap for metadata storage**: Changed `callableMetadata` from `Map` to `WeakMap` to prevent memory leaks when function references are garbage collected.
- **UUID for RPC IDs**: Replaced `Math.random().toString(36)` with `crypto.randomUUID()` for more robust and unique RPC call identifiers.
- **Streaming observability**: Added observability events for streaming RPC calls.

## API Enhancements

The `agent.call()` method now accepts a unified `CallOptions` object with timeout support:

```typescript
// New format (preferred, supports timeout)
await agent.call("method", [args], {
  timeout: 5000,
  stream: { onChunk, onDone, onError }
});

// Legacy format (still fully supported for backward compatibility)
await agent.call("method", [args], { onChunk, onDone, onError });
```

Both formats work seamlessly - the client auto-detects which format you're using.
