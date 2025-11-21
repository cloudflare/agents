import type { env } from "cloudflare:workers";
import type { ModelPlanBuilder } from "./middleware/plan";
import type { AgentConfig, SystemAgent } from "./agent";
import type { Provider } from "./providers";

export type RunStatus =
  | "idle"
  | "registered"
  | "running"
  | "paused"
  | "completed"
  | "canceled"
  | "error";

export type RunState = {
  runId: string;
  status: RunStatus;
  step: number; // how many steps executed
  reason?: string; // pause/cancel reason
  nextAlarmAt?: number | null; // ms epoch
};

export type AgentState = {
  messages: ChatMessage[];
  tools: ToolMeta[];
  thread: ThreadMetadata;
  threadId?: string;
  parent?: ParentInfo;
  agentType?: string;
  model?: string;
} & Record<string, unknown>;

export interface ApproveBody {
  approved: boolean;
  modifiedToolCalls?: ToolCall[];
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
  | { role: "assistant"; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export interface InvokeBody {
  threadId?: string;
  messages?: ChatMessage[]; // optional new user messages
  files?: Record<string, string>; // optional files to merge into VFS
  idempotencyKey?: string; // dedupe protection
  agentType?: string; // optional subagent type
  parent?: ParentInfo; // optional parent thread info
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
  threadId: string;
  token: string;
}

export type ThreadRequestContext = {
  userAgent?: string;
  ip?: string;
  referrer?: string;
  origin?: string;
  cf?: Record<string, unknown>;
};

export interface ThreadMetadata {
  id: string;
  createdAt: string;
  request: ThreadRequestContext;
  parent?: ParentInfo;
  agentType: string;
}

export interface CreateThreadRequest {
  agentType?: string;
  metadata?: Record<string, unknown>;
}

export type SubagentLinkStatus = "waiting" | "completed" | "canceled";

export interface SubagentLink {
  childThreadId: string;
  token: string;
  status: SubagentLinkStatus;
  createdAt: number;
  completedAt?: number;
  report?: string;
  toolCallId?: string;
}

export type AgentBlueprint = {
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  model?: string;
  middleware?: AgentMiddleware[];
  config?: AgentConfig;
};

export type MWContext = {
  provider: Provider;
  agent: SystemAgent;
  registerTool: (handler: ToolHandler) => void;
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
      threadId: string;
      token: string;
      report?: string;
    }
  ): Promise<void>;
  tags: string[];
}

export type ToolHandler = ((
  // biome-ignore lint/suspicious/noExplicitAny: need to think this proper
  input: any, // TODO: type this
  ctx: ToolContext
) => Promise<string | object | null>) & { __tool?: ToolMeta };

export type ToolContext = {
  agent: SystemAgent;
  env: typeof env;
  callId: string;
};
