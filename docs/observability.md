# Observability

`Agent` instances use the `observability` property to emit various internal events that can be used for logging, monitoring, and debugging. This provides deep visibility into agent behavior and lifecycle events.

## Default Behavior

The default behavior is to `console.log()` the event value:

```
{
  displayMessage: 'State updated',
  id: 'EnOzrS_tEo_8dHy5oyl8q',
  payload: {},
  timestamp: 1758005142787,
  type: 'state:update'
}
```

## Event Types

The SDK emits the following event types:

### Connection Events

- `connect` - New client connection established
- `disconnect` - Client connection closed
- `error` - Connection error occurred

### State Events

- `state:update` - Agent state was modified
- `state:read` - Agent state was accessed

### Message Events

- `message:sent` - Message sent to client
- `message:received` - Message received from client
- `message:error` - Message processing error

### AI Events

- `ai:request` - AI model request started
- `ai:response` - AI model response received
- `ai:error` - AI model request failed

### Tool Events

- `tool:call` - Tool execution started
- `tool:result` - Tool execution completed
- `tool:error` - Tool execution failed

## Custom Observability

You can configure custom observability by implementing the `Observability` interface:

```ts
import { Agent } from "agents";
import { type Observability } from "agents/observability";

const observability: Observability = {
  emit(event) {
    if (event.type === "connect") {
      console.log(event.timestamp, event.payload.connectionId);
    }
  }
};

class MyAgent extends Agent {
  override observability = observability;
}
```

## Integration Examples

### Logging to External Service

```ts
import { type Observability } from "agents/observability";

const loggingObservability: Observability = {
  async emit(event) {
    // Send to logging service
    await fetch("https://logs.example.com/events", {
      method: "POST",
      body: JSON.stringify({
        service: "my-agent",
        level: event.type.includes("error") ? "error" : "info",
        timestamp: event.timestamp,
        message: event.displayMessage,
        data: event.payload
      })
    });
  }
};
```

### Metrics and Monitoring

```ts
import { type Observability } from "agents/observability";

const metricsObservability: Observability = {
  emit(event) {
    // Track connection metrics
    if (event.type === "connect") {
      // Increment active connections counter
      env.METRICS.writeDataPoint({
        metric: "agent.connections.active",
        value: 1,
        timestamp: event.timestamp
      });
    }

    // Track AI model latency
    if (event.type === "ai:response") {
      const latency = event.payload.duration;
      env.METRICS.writeDataPoint({
        metric: "agent.ai.latency",
        value: latency,
        timestamp: event.timestamp
      });
    }
  }
};
```

### Filtering Events

```ts
import { type Observability } from "agents/observability";

const filteredObservability: Observability = {
  emit(event) {
    // Only log errors and AI events
    if (event.type.includes("error") || event.type.startsWith("ai:")) {
      console.error("[Agent Event]", {
        type: event.type,
        message: event.displayMessage,
        payload: event.payload
      });
    }
  }
};
```

## Disabling Observability

To disable all observability events, set the property to `undefined`:

```ts
import { Agent } from "agents";

class MyAgent extends Agent {
  override observability = undefined;
}
```

## Best Practices

### Performance Considerations

- Observability handlers should be non-blocking
- Use async operations carefully to avoid slowing down agent operations
- Consider batching events for external services

### Security

- Filter sensitive data from event payloads before sending to external services
- Use secure connections for external logging services
- Implement rate limiting for observability endpoints

### Debugging

- Enable full observability in development environments
- Use filtered observability in production to reduce noise
- Include correlation IDs in events for distributed tracing
