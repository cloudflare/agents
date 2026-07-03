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
  chat: channel("agents:chat"),
  transcript: channel("agents:transcript"),
  fiber: channel("agents:fiber"),
  agentTool: channel("agents:agent_tool"),
  schedule: channel("agents:schedule"),
  lifecycle: channel("agents:lifecycle"),
  workflow: channel("agents:workflow"),
  mcp: channel("agents:mcp"),
  email: channel("agents:email"),
  channel: channel("agents:channel")
} as const;

/**
 * Channel keys whose diagnostics channel name differs from `agents:${key}`.
 * Keep this in sync with {@link channels} for any camelCase key that maps to a
 * snake_case diagnostics channel.
 */
const CHANNEL_DIAGNOSTIC_NAME_OVERRIDES: Partial<Record<string, string>> = {
  agentTool: "agents:agent_tool"
};

/**
 * Map event type prefixes to their diagnostics channel.
 */
function getChannel(type: string): Channel {
  if (type.startsWith("mcp:")) return channels.mcp;
  if (type.startsWith("workflow:")) return channels.workflow;
  if (type.startsWith("fiber:")) return channels.fiber;
  if (type.startsWith("transcript:") || type.startsWith("chat:transcript:"))
    return channels.transcript;
  if (type.startsWith("chat:")) return channels.chat;
  if (type.startsWith("agent_tool:")) return channels.agentTool;
  if (type.startsWith("schedule:") || type.startsWith("queue:"))
    return channels.schedule;
  if (
    type.startsWith("message:") ||
    type.startsWith("tool:") ||
    type.startsWith("submission:") ||
    type.startsWith("action:")
  )
    return channels.message;
  if (type === "rpc" || type.startsWith("rpc:")) return channels.rpc;
  if (type.startsWith("state:")) return channels.state;
  if (type.startsWith("email:")) return channels.email;
  if (type.startsWith("channel:") || type.startsWith("notice:"))
    return channels.channel;
  // connect, disconnect, destroy
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
