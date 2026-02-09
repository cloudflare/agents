import { getCurrentAgent } from "../index";
import type { AgentObservabilityEvent } from "./agent";
import type { MCPObservabilityEvent } from "./mcp";

/**
 * Union of all observability event types from different domains
 */
export type ObservabilityEvent =
  | AgentObservabilityEvent
  | MCPObservabilityEvent;

export interface Observability {
  /**
   * Emit an event for the Agent's observability implementation to handle.
   * @param event - The event to emit
   * @param ctx - The execution context of the invocation (optional)
   */
  emit(event: ObservabilityEvent, ctx?: DurableObjectState): void;
}

/**
 * A generic observability implementation that logs events to the console.
 */
export const genericObservability: Observability = {
  emit(event) {
    // In local mode, we display a pretty-print version of the event for easier debugging.
    if (isLocalMode()) {
      console.log(event.displayMessage);
      return;
    }

    console.log(event);
  }
};

let localMode = false;

function isLocalMode() {
  if (localMode) {
    return true;
  }
  const { request } = getCurrentAgent();
  if (!request) {
    return false;
  }

  const url = new URL(request.url);
  localMode = url.hostname === "localhost";
  return localMode;
}
