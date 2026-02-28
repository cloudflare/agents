import {
  channel,
  subscribe as dcSubscribe,
  unsubscribe as dcUnsubscribe,
  type Channel
} from "node:diagnostics_channel";
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
   */
  emit(event: ObservabilityEvent): void;
}

/**
 * Diagnostics channels for agent observability.
 *
 * Events are published to named channels using the Node.js diagnostics_channel API.
 * By default, publishing to a channel with no subscribers is a no-op (zero overhead).
 *
 * To observe events, subscribe to the channels you care about:
 * ```ts
 * import { subscribe } from "node:diagnostics_channel";
 * subscribe("agents:rpc", (event) => console.log(event));
 * ```
 *
 * In production, all published messages are automatically forwarded to
 * Tail Workers via `event.diagnosticsChannelEvents` — no subscription needed.
 */
export const channels = {
  state: channel("agents:state"),
  rpc: channel("agents:rpc"),
  message: channel("agents:message"),
  schedule: channel("agents:schedule"),
  lifecycle: channel("agents:lifecycle"),
  workflow: channel("agents:workflow"),
  mcp: channel("agents:mcp")
} as const;

/**
 * Map event type prefixes to their diagnostics channel.
 */
function getChannel(type: string): Channel {
  if (type.startsWith("mcp:")) return channels.mcp;
  if (type.startsWith("workflow:")) return channels.workflow;
  if (type.startsWith("schedule:") || type.startsWith("queue:"))
    return channels.schedule;
  if (type.startsWith("message:") || type.startsWith("tool:"))
    return channels.message;
  if (type === "rpc" || type.startsWith("rpc:")) return channels.rpc;
  if (type.startsWith("state:")) return channels.state;
  // connect, destroy
  return channels.lifecycle;
}

/**
 * The default observability implementation.
 *
 * Publishes events to diagnostics_channel. Events are silent unless
 * a subscriber is registered or a Tail Worker is attached.
 */
export const genericObservability: Observability = {
  emit(event) {
    getChannel(event.type).publish(event);
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
    { type: `message:${string}` | `tool:${string}` }
  >;
  schedule: Extract<
    ObservabilityEvent,
    { type: `schedule:${string}` | `queue:${string}` }
  >;
  lifecycle: Extract<ObservabilityEvent, { type: "connect" | "destroy" }>;
  workflow: Extract<ObservabilityEvent, { type: `workflow:${string}` }>;
  mcp: Extract<ObservabilityEvent, { type: `mcp:${string}` }>;
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
  const name = `agents:${channelKey}`;
  const handler = (message: unknown, _name: string | symbol) =>
    callback(message as ChannelEventMap[K]);
  dcSubscribe(name, handler);
  return () => dcUnsubscribe(name, handler);
}
