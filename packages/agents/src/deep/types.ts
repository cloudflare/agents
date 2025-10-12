import type { env } from "cloudflare:workers";
import type { AgentEvent, AgentEventType } from "./events";
import type { ModelPlanBuilder } from "./middleware/plan";
import type { Store } from "./agent/store";
import type { DeepAgent } from "./agent";
import type { Provider } from "./providers";

export type Effect =
  | { type: "append_messages"; messages: ChatMessage[] }
  | { type: "set_meta"; patch: Partial<AgentState["meta"]> }
  | { type: "enqueue_tool_calls"; calls: ToolCall[] }
  | {
      type: "pause";
      reason: "hitl" | "subagent" | "exhausted" | string;
      payload?: any;
    }
  | { type: "resume" }
  | {
      type: "spawn_subagents";
      tasks: Array<{
        description: string;
        subagent_type?: string;
        link_to_tool_call_id?: string;
        timeout_ms?: number;
      }>;
    }
  | {
      type: "emit_event";
      event: { type: AgentEventType; data: AgentEvent["data"] };
    }
  | { type: "quota"; toolsPerTick?: number; modelMaxTokens?: number };

export type Effects = { list: Effect[]; push: (...e: Effect[]) => void };

export type RunStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "canceled"
  | "error";

export interface RunState {
  run_id: string;
  status: RunStatus;
  step: number; // how many steps executed
  reason?: string; // pause/cancel reason
  next_alarm_at?: number | null; // ms epoch
}

export interface ApproveBody {
  approved: boolean;
  modified_tool_calls?: Array<{ tool_name: string; args: unknown }>;
}

export type Todo = {
  content: string;
  status: "pending" | "in_progress" | "completed";
};

export type ToolCall = {
  name: string;
  args: unknown;
  id: string;
};

export type ToolJsonSchema = Record<string, unknown>;

export type ToolMeta = {
  name: string;
  description?: string; // this is where *_TOOL_DESCRIPTION goes
  parameters?: ToolJsonSchema; // JSON Schema for the args (OpenAI/Anthropic)
};

export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface InvokeBody {
  thread_id?: string;
  messages?: ChatMessage[]; // optional new user messages
  files?: Record<string, string>; // optional files to merge into VFS
  idempotencyKey?: string; // dedupe protection
  meta?: Partial<AgentState["meta"]>;
}

export interface ModelRequest {
  model: string; // provider:model-id (adapter resolves)
  systemPrompt?: string; // big system prompt (may be dynamic)
  messages: ChatMessage[]; // excludes systemPrompt
  tools?: string[]; // exposed tool names
  toolDefs?: ToolMeta[];
  toolChoice?: "auto" | { type: "function"; function: { name: string } };
  responseFormat?: "text" | "json" | { schema: unknown };
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

export interface ParentInfo {
  thread_id: string;
  token: string;
}

export interface AgentState {
  messages: ChatMessage[];
  files?: Record<string, string>;
  meta?: {
    model?: string;
    systemPrompt?: string;
    userId?: string;
    usdSpent?: number;
    pendingToolCalls?: ToolCall[];
    runStatus?: RunStatus;
    lastReadPaths?: string[];
    parent?: ParentInfo;
    subagent_type?: string;
    waitingSubagents?: Array<{
      token: string;
      child_thread_id: string;
      tool_call_id: string;
    }>;
    toolDefs?: ToolMeta[];
  };
  todos?: Todo[];
  jumpTo?: "model" | "tools" | "end";
}

export type Persisted = {
  state: AgentState;
  run: RunState | null;
  thread_id?: string; // human-readable thread identifier
  // ring buffer of recent events for dashboard
  events: AgentEvent[];
  events_seq: number; // monotonically increasing sequence
};

export type SubagentDescriptor = {
  name: string;
  description: string;
  prompt: string;
  tools?: Record<string, ToolHandler>;
  model?: string;
  middleware?: AgentMiddleware[];
};

export type MWContext = {
  provider: Provider;
  // snapshotted, read-only view if you want one
  store: Store;
  // the good stuff
  agent: DeepAgent;
  // TODO: tool registry for dynamic additions, prolly mcp
  // registerTool: (name: string, handler: ToolHandler) => void;
};

// Middleware lifecycle
export interface AgentMiddleware {
  name: string;
  // optional, to inject into shared state
  state?: (ctx: MWContext) => Record<string, unknown>;

  onInit?(ctx: MWContext): Promise<void>; // optional, run once per DO

  onTick?(ctx: MWContext): Promise<void>; // before building the model request

  beforeModel?(ctx: MWContext, plan: ModelPlanBuilder): Promise<void>;

  onModelResult?(ctx: MWContext, res: { message: ChatMessage }): Promise<void>;

  onToolStart?(ctx: MWContext, call: ToolCall): Promise<void>;
  onToolResult?(ctx: MWContext, call: ToolCall, result: unknown): Promise<void>;
  onToolError?(ctx: MWContext, call: ToolCall, error: Error): Promise<void>;

  onResume?(ctx: MWContext, reason: string, payload: unknown): Promise<void>;
  onChildReport?(
    ctx: MWContext,
    child: {
      thread_id: string;
      token: string;
      report?: string;
    }
  ): Promise<void>;

  tools?: Record<string, ToolHandler>;
}

export type ToolHandler = ((
  input: any, // TODO: type this
  ctx: ToolContext
) => Promise<string | object | null>) & { __tool?: ToolMeta };

export type ToolContext = {
  agent: DeepAgent;
  store: Store;
  env: typeof env;
  callId: string;
};
