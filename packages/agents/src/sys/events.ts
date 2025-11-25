// events.ts
export enum AgentEventType {
  THREAD_CREATED = "thread.created",
  REQUEST_ACCEPTED = "request.accepted",

  RUN_STARTED = "run.started",
  RUN_TICK = "run.tick",
  RUN_PAUSED = "run.paused",
  RUN_RESUMED = "run.resumed",
  RUN_CANCELED = "run.canceled",

  AGENT_STARTED = "agent.started",
  AGENT_COMPLETED = "agent.completed",
  AGENT_ERROR = "agent.error",

  CHECKPOINT_SAVED = "checkpoint.saved",

  MODEL_STARTED = "model.started",
  MODEL_DELTA = "model.delta",
  MODEL_COMPLETED = "model.completed",

  MIDDLEWARE_BEFORE_MODEL = "middleware.before_model",
  MIDDLEWARE_AFTER_MODEL = "middleware.after_model",

  TOOL_STARTED = "tool.started",
  TOOL_OUTPUT = "tool.output",
  TOOL_ERROR = "tool.error",

  HITL_INTERRUPT = "hitl.interrupt",
  HITL_RESUME = "hitl.resume",

  SUBAGENT_SPAWNED = "subagent.spawned",
  SUBAGENT_COMPLETED = "subagent.completed"
}

export type AgentEvent = {
  threadId: string;
  ts: string;
  seq?: number;
} & AgentEventData;

export type AgentEventData =
  | { type: AgentEventType.THREAD_CREATED; data: { threadId: string } }
  | { type: AgentEventType.REQUEST_ACCEPTED; data: { idempotencyKey: string } }
  | { type: AgentEventType.RUN_STARTED; data: { runId: string } }
  | { type: AgentEventType.RUN_TICK; data: { runId: string; step: number } }
  | {
      type: AgentEventType.RUN_PAUSED;
      data: {
        runId: string;
        reason: "hitl" | "error" | "exhausted" | "subagent";
      };
    }
  | { type: AgentEventType.RUN_RESUMED; data: { runId: string } }
  | { type: AgentEventType.RUN_CANCELED; data: { runId: string } }
  | { type: AgentEventType.AGENT_STARTED; data: Record<string, never> }
  | { type: AgentEventType.AGENT_COMPLETED; data: { result?: unknown } }
  | {
      type: AgentEventType.AGENT_ERROR;
      data: { error: string; stack?: string };
    }
  | {
      type: AgentEventType.CHECKPOINT_SAVED;
      data: { stateHash: string; size: number };
    }
  | { type: AgentEventType.MODEL_STARTED; data: { model: string } }
  | { type: AgentEventType.MODEL_DELTA; data: { delta: string } }
  | {
      type: AgentEventType.MODEL_COMPLETED;
      data: { usage?: { inputTokens: number; outputTokens: number } };
    }
  | {
      type: AgentEventType.MIDDLEWARE_BEFORE_MODEL;
      data: { middlewareName: string };
    }
  | {
      type: AgentEventType.MIDDLEWARE_AFTER_MODEL;
      data: { middlewareName: string };
    }
  | {
      type: AgentEventType.TOOL_STARTED;
      data: { toolName: string; args: unknown };
    }
  | {
      type: AgentEventType.TOOL_OUTPUT;
      data: { toolName: string; output: unknown };
    }
  | {
      type: AgentEventType.TOOL_ERROR;
      data: { toolName: string; error: string };
    }
  | {
      type: AgentEventType.HITL_INTERRUPT;
      data: {
        proposedToolCalls: Array<{ toolName: string; args: unknown }>;
      };
    }
  | {
      type: AgentEventType.HITL_RESUME;
      data: {
        approved: boolean;
        modifiedToolCalls?: Array<{ toolName: string; args: unknown }>;
      };
    }
  | { type: AgentEventType.SUBAGENT_SPAWNED; data: { childThreadId: string } }
  | {
      type: AgentEventType.SUBAGENT_COMPLETED;
      data: { childThreadId: string; result?: unknown };
    };
