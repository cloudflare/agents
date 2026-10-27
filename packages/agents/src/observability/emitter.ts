import type { AgentObservabilityEvent } from "./agent";
import type { MCPObservabilityEvent } from "./mcp";
import { publishDiagnosticsEvent } from "./diagnostics";

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
   */
  emit(event: ObservabilityEvent): void;
}

/**
 * The default observability implementation.
 *
 * Publishes events to diagnostics_channel. Events are silent unless
 * a subscriber is registered or a Tail Worker is attached.
 */
export const genericObservability: Observability = {
  emit(event) {
    publishDiagnosticsEvent(event);
  }
};
