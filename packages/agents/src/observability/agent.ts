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
  // Task lifecycle events
  | BaseEvent<
      | "task:created"
      | "task:started"
      | "task:progress"
      | "task:completed"
      | "task:failed"
      | "task:aborted"
      | "task:event",
      {
        taskId: string;
        method?: string;
        input?: unknown;
        timeoutMs?: number;
        deadline?: number | null;
        progress?: number;
        result?: unknown;
        error?: string;
        reason?: string;
        duration?: number;
        eventType?: string;
        eventData?: unknown;
      }
    >;
