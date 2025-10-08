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
  SUBAGENT_COMPLETED = "subagent.completed",

  VFS_WRITE = "vfs.write",
  VFS_EDIT = "vfs.edit",
  VFS_DELETE = "vfs.delete"
}

export type AgentEvent = {
  thread_id: string;
  ts: string;
  seq?: number;
} & AgentEventData;

export type AgentEventData =
  | { type: AgentEventType.THREAD_CREATED; data: { thread_id: string } }
  | { type: AgentEventType.REQUEST_ACCEPTED; data: { idempotency_key: string } }
  | { type: AgentEventType.RUN_STARTED; data: { run_id: string } }
  | { type: AgentEventType.RUN_TICK; data: { run_id: string; step: number } }
  | {
      type: AgentEventType.RUN_PAUSED;
      data: { run_id: string; reason: "hitl" | "error" | "exhausted" };
    }
  | { type: AgentEventType.RUN_RESUMED; data: { run_id: string } }
  | { type: AgentEventType.RUN_CANCELED; data: { run_id: string } }
  | { type: AgentEventType.AGENT_STARTED; data: Record<string, never> }
  | { type: AgentEventType.AGENT_COMPLETED; data: { result?: unknown } }
  | {
      type: AgentEventType.AGENT_ERROR;
      data: { error: string; stack?: string };
    }
  | {
      type: AgentEventType.CHECKPOINT_SAVED;
      data: { state_hash: string; size: number };
    }
  | { type: AgentEventType.MODEL_STARTED; data: { model: string } }
  | { type: AgentEventType.MODEL_DELTA; data: { delta: string } }
  | {
      type: AgentEventType.MODEL_COMPLETED;
      data: { usage?: { input_tokens: number; output_tokens: number } };
    }
  | {
      type: AgentEventType.MIDDLEWARE_BEFORE_MODEL;
      data: { middleware_name: string };
    }
  | {
      type: AgentEventType.MIDDLEWARE_AFTER_MODEL;
      data: { middleware_name: string };
    }
  | {
      type: AgentEventType.TOOL_STARTED;
      data: { tool_name: string; args: unknown };
    }
  | {
      type: AgentEventType.TOOL_OUTPUT;
      data: { tool_name: string; output: unknown };
    }
  | {
      type: AgentEventType.TOOL_ERROR;
      data: { tool_name: string; error: string };
    }
  | {
      type: AgentEventType.HITL_INTERRUPT;
      data: {
        proposed_tool_calls: Array<{ tool_name: string; args: unknown }>;
      };
    }
  | {
      type: AgentEventType.HITL_RESUME;
      data: {
        approved: boolean;
        modified_tool_calls?: Array<{ tool_name: string; args: unknown }>;
      };
    }
  | { type: AgentEventType.SUBAGENT_SPAWNED; data: { child_thread_id: string } }
  | {
      type: AgentEventType.SUBAGENT_COMPLETED;
      data: { child_thread_id: string; result?: unknown };
    }
  | { type: AgentEventType.VFS_WRITE; data: { path: string } }
  | { type: AgentEventType.VFS_EDIT; data: { path: string } }
  | { type: AgentEventType.VFS_DELETE; data: { path: string } };
