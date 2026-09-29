import {
  subscribe as dcSubscribe,
  unsubscribe as dcUnsubscribe
} from "node:diagnostics_channel";
import type { AgentObservabilityEvent } from "./agent";
import type { MCPObservabilityEvent } from "./mcp";
import { publishDiagnosticsEvent } from "./diagnostics";
export { channels } from "./diagnostics";

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
 * Channel keys whose diagnostics channel name differs from `agents:${key}`.
 * Keep this in sync with {@link channels} for any camelCase key that maps to a
 * snake_case diagnostics channel.
 */
const CHANNEL_DIAGNOSTIC_NAME_OVERRIDES: Partial<Record<string, string>> = {
  agentTool: "agents:agent_tool"
};

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

/**
 * Maps each channel key to the observability events it carries.
 */
export type ChannelEventMap = {
  state: Extract<ObservabilityEvent, { type: `state:${string}` }>;
  rpc: Extract<ObservabilityEvent, { type: "rpc" | `rpc:${string}` }>;
  message: Extract<
    ObservabilityEvent,
    {
      type:
        | `message:${string}`
        | `tool:${string}`
        | `submission:${string}`
        | `action:${string}`;
    }
  >;
  chat: Exclude<
    Extract<ObservabilityEvent, { type: `chat:${string}` }>,
    { type: `chat:transcript:${string}` }
  >;
  transcript: Extract<
    ObservabilityEvent,
    { type: `transcript:${string}` | `chat:transcript:${string}` }
  >;
  fiber: Extract<ObservabilityEvent, { type: `fiber:${string}` }>;
  agentTool: Extract<ObservabilityEvent, { type: `agent_tool:${string}` }>;
  schedule: Extract<
    ObservabilityEvent,
    { type: `schedule:${string}` | `queue:${string}` }
  >;
  lifecycle: Extract<
    ObservabilityEvent,
    { type: "connect" | "disconnect" | "destroy" }
  >;
  workflow: Extract<ObservabilityEvent, { type: `workflow:${string}` }>;
  mcp: Extract<ObservabilityEvent, { type: `mcp:${string}` }>;
  email: Extract<ObservabilityEvent, { type: `email:${string}` }>;
  channel: Extract<
    ObservabilityEvent,
    { type: `channel:${string}` | `notice:${string}` }
  >;
};

/**
 * Subscribe to a typed observability channel.
 *
 * ```ts
 * import { subscribe } from "agents/observability";
 *
 * const unsub = subscribe("rpc", (event) => {
 *   console.log(event.payload.method); // fully typed
 * });
 * ```
 *
 * @returns A function that unsubscribes the callback.
 */
export function subscribe<K extends keyof ChannelEventMap>(
  channelKey: K,
  callback: (event: ChannelEventMap[K]) => void
): () => void {
  const name =
    CHANNEL_DIAGNOSTIC_NAME_OVERRIDES[channelKey] ?? `agents:${channelKey}`;
  const handler = (message: unknown, _name: string | symbol) =>
    callback(message as ChannelEventMap[K]);
  dcSubscribe(name, handler);
  return () => dcUnsubscribe(name, handler);
}
