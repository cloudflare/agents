import type { BaseEvent } from "./base";

/**
 * Agent-specific observability events
 * These track the lifecycle and operations of an Agent
 */
export type AgentObservabilityEvent =
  | BaseEvent<"state:update">
  | BaseEvent<"rpc", { method: string; streaming?: boolean }>
  | BaseEvent<"rpc:error", { method: string; error: string }>
  | BaseEvent<"message:request">
  | BaseEvent<"message:response">
  | BaseEvent<"message:clear">
  | BaseEvent<"message:cancel", { requestId: string }>
  | BaseEvent<"message:error", { error: string }>
  | BaseEvent<"tool:result", { toolCallId: string; toolName: string }>
  | BaseEvent<"tool:approval", { toolCallId: string; approved: boolean }>
  | BaseEvent<"schedule:create", { callback: string; id: string }>
  | BaseEvent<"schedule:execute", { callback: string; id: string }>
  | BaseEvent<"schedule:cancel", { callback: string; id: string }>
  | BaseEvent<
      "schedule:retry",
      { callback: string; id: string; attempt: number; maxAttempts: number }
    >
  | BaseEvent<
      "schedule:error",
      { callback: string; id: string; error: string; attempts: number }
    >
  | BaseEvent<
      "queue:retry",
      { callback: string; id: string; attempt: number; maxAttempts: number }
    >
  | BaseEvent<
      "queue:error",
      { callback: string; id: string; error: string; attempts: number }
    >
  | BaseEvent<"destroy">
  | BaseEvent<"connect", { connectionId: string }>
  | BaseEvent<"workflow:start", { workflowId: string; workflowName?: string }>
  | BaseEvent<"workflow:event", { workflowId: string; eventType?: string }>
  | BaseEvent<"workflow:approved", { workflowId: string; reason?: string }>
  | BaseEvent<"workflow:rejected", { workflowId: string; reason?: string }>
  | BaseEvent<
      "workflow:terminated",
      { workflowId: string; workflowName?: string }
    >
  | BaseEvent<"workflow:paused", { workflowId: string; workflowName?: string }>
  | BaseEvent<"workflow:resumed", { workflowId: string; workflowName?: string }>
  | BaseEvent<
      "workflow:restarted",
      { workflowId: string; workflowName?: string }
    >;
