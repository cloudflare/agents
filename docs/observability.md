# Observability

`Agent` instances uses the `observability` property to emit various internal events that can be used for logging and monitoring.

The default behavior is to `console.log()` the event value.

```
{
  displayMessage: 'State updated',
  id: 'EnOzrS_tEo_8dHy5oyl8q',
  payload: {},
  timestamp: 1758005142787,
  type: 'state:update'
}
```

This can be configured by overriding the property with an implementation of the `Observability` interface. This interface has a single `emit()` method that takes an `ObservabilityEvent`.

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

Or, alternatively, you can set the property to `undefined` to ignore all events.

```ts
import { Agent } from "agents";

class MyAgent extends Agent {
  override observability = undefined;
}
```
