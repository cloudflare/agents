import type { BaseEvent } from "./base";

/**
 * Agent-specific observability events
 * These track the lifecycle and operations of an Agent
 */
export type AgentObservabilityEvent =
  | BaseEvent<"state:update", {}>
  | BaseEvent<
      "rpc",
      {
        method: string;
        streaming?: boolean;
      }
    >
  | BaseEvent<"message:request" | "message:response", {}>
  | BaseEvent<"message:clear">
  | BaseEvent<
      "schedule:create" | "schedule:execute" | "schedule:cancel",
      {
        callback: string;
        id: string;
      }
    >
  | BaseEvent<"destroy">
  | BaseEvent<
      "connect",
      {
        connectionId: string;
      }
    >
  | BaseEvent<
      | "workflow:start"
      | "workflow:event"
      | "workflow:approved"
      | "workflow:rejected"
      | "workflow:terminated"
      | "workflow:paused"
      | "workflow:resumed"
      | "workflow:restarted",
      {
        workflowId: string;
        workflowName?: string;
        eventType?: string;
        reason?: string;
      }
    >;
