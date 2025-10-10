import type { env } from "cloudflare:workers";
import type { AgentEvent } from "./events";

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
    parent?: { thread_id: string; token: string };
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

// Middleware lifecycle
export interface AgentMiddleware {
  name: string;
  beforeModel?(state: AgentState): Promise<Partial<AgentState> | void>;
  modifyModelRequest?(
    req: ModelRequest,
    state: AgentState
  ): Promise<ModelRequest>;
  afterModel?(state: AgentState): Promise<Partial<AgentState> | void>;
  // Optional: tool injection + typed state extension later
  tools?: Record<string, ToolHandler>;
}

export type ToolHandler = ((
  input: any, // TODO: type this
  ctx: ToolContext
) => Promise<string | object>) & { __tool?: ToolMeta };

export type ToolContext = {
  state: AgentState;
  env: typeof env;
  fetch: typeof fetch;
};
