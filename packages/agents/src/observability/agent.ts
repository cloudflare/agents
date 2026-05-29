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
      "schedule:duplicate_warning",
      { callback: string; count: number; type: string }
    >
  | BaseEvent<"queue:create", { callback: string; id: string }>
  | BaseEvent<
      "queue:retry",
      { callback: string; id: string; attempt: number; maxAttempts: number }
    >
  | BaseEvent<
      "queue:error",
      { callback: string; id: string; error: string; attempts: number }
    >
  | BaseEvent<
      "submission:create",
      { submissionId: string; requestId?: string; idempotencyKey?: string }
    >
  | BaseEvent<
      "submission:status",
      { submissionId: string; requestId?: string; status: string }
    >
  | BaseEvent<
      "submission:error",
      { submissionId: string; requestId?: string; error: string }
    >
  | BaseEvent<
      "fiber:run:started",
      { fiberId: string; fiberName: string; managed?: boolean }
    >
  | BaseEvent<
      "fiber:run:completed",
      {
        fiberId: string;
        fiberName: string;
        elapsedMs?: number;
        managed?: boolean;
      }
    >
  | BaseEvent<
      "fiber:run:failed",
      {
        fiberId: string;
        fiberName: string;
        error: string;
        elapsedMs?: number;
        managed?: boolean;
      }
    >
  | BaseEvent<
      "fiber:run:interrupted",
      {
        fiberId: string;
        fiberName: string;
        elapsedMs?: number;
        managed?: boolean;
        recoveryReason: "interrupted";
      }
    >
  | BaseEvent<
      "fiber:recovery:detected",
      {
        fiberId: string;
        fiberName: string;
        elapsedMs?: number;
        managed?: boolean;
        recoveryReason: "interrupted";
      }
    >
  | BaseEvent<
      "fiber:recovery:attempt",
      {
        fiberId: string;
        fiberName: string;
        managed?: boolean;
        recoveryReason: "interrupted";
      }
    >
  | BaseEvent<
      "fiber:recovery:handled",
      {
        fiberId: string;
        fiberName: string;
        status?: string;
        elapsedMs?: number;
        managed?: boolean;
      }
    >
  | BaseEvent<
      "fiber:recovery:skipped",
      {
        fiberId: string;
        fiberName: string;
        reason: string;
        elapsedMs?: number;
        managed?: boolean;
      }
    >
  | BaseEvent<
      "fiber:recovery:failed",
      {
        fiberId: string;
        fiberName: string;
        error: string;
        elapsedMs?: number;
        reason?: string;
      }
    >
  | BaseEvent<
      "chat:request:failed",
      {
        requestId?: string;
        stage:
          | "parse"
          | "persist"
          | "turn"
          | "stream"
          | "recovery"
          | "transcript";
        messagesPersisted?: boolean;
        error: string;
      }
    >
  | BaseEvent<
      "chat:recovery:detected",
      {
        incidentId: string;
        requestId: string;
        attempt: number;
        maxAttempts: number;
        recoveryKind: "retry" | "continue";
      }
    >
  | BaseEvent<
      "chat:recovery:scheduled",
      {
        incidentId: string;
        requestId: string;
        attempt: number;
        maxAttempts: number;
        recoveryKind: "retry" | "continue";
      }
    >
  | BaseEvent<
      "chat:recovery:attempt",
      {
        incidentId: string;
        requestId: string;
        attempt: number;
        maxAttempts: number;
        recoveryKind: "retry" | "continue";
      }
    >
  | BaseEvent<
      "chat:recovery:completed",
      {
        incidentId: string;
        requestId: string;
        attempt: number;
        maxAttempts: number;
        recoveryKind: "retry" | "continue";
      }
    >
  | BaseEvent<
      "chat:recovery:skipped",
      {
        incidentId: string;
        requestId: string;
        attempt: number;
        maxAttempts: number;
        recoveryKind: "retry" | "continue";
        reason?: string;
      }
    >
  | BaseEvent<
      "chat:recovery:exhausted",
      {
        incidentId: string;
        requestId: string;
        attempt: number;
        maxAttempts: number;
        recoveryKind: "retry" | "continue";
        reason: string;
      }
    >
  | BaseEvent<
      "chat:recovery:failed",
      {
        incidentId: string;
        requestId: string;
        attempt: number;
        maxAttempts: number;
        recoveryKind: "retry" | "continue";
        reason?: string;
      }
    >
  | BaseEvent<
      "chat:transcript:repaired",
      {
        requestId?: string;
        removedToolCalls: number;
        normalizedInputs: number;
        toolCallIds?: string[];
      }
    >
  | BaseEvent<
      "agent_tool:recovery:begin",
      { runCount: number; totalTimeoutMs?: number }
    >
  | BaseEvent<
      "agent_tool:recovery:row",
      {
        runId: string;
        agentType: string;
        status: string;
        reason?: string;
        elapsedMs?: number;
      }
    >
  | BaseEvent<
      "agent_tool:recovery:deadline",
      { runId: string; agentType: string; elapsedMs?: number }
    >
  | BaseEvent<
      "agent_tool:recovery:complete",
      { runCount: number; elapsedMs?: number }
    >
  | BaseEvent<"agent_tool:recovery:failed", { error: string }>
  | BaseEvent<"destroy">
  | BaseEvent<"connect", { connectionId: string }>
  | BaseEvent<
      "disconnect",
      { connectionId: string; code: number; reason: string }
    >
  | BaseEvent<"email:receive", { from: string; to: string; subject?: string }>
  | BaseEvent<"email:reply", { from: string; to: string; subject?: string }>
  | BaseEvent<
      "email:send",
      { from: string; to: string | string[]; subject: string }
    >
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
