import type { UIMessage } from "ai";
import type { Agent, SubAgentClass } from "./index";

export type AgentToolRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "error"
  | "aborted"
  | "interrupted";

export type AgentToolTerminalStatus = Extract<
  AgentToolRunStatus,
  "completed" | "error" | "aborted" | "interrupted"
>;

export type AgentToolDisplayMetadata = {
  name?: string;
  icon?: string;
} & Record<string, unknown>;

export type AgentToolRunInfo = {
  runId: string;
  parentToolCallId?: string;
  agentType: string;
  inputPreview?: unknown;
  status: AgentToolRunStatus;
  display?: AgentToolDisplayMetadata;
  displayOrder: number;
  startedAt: number;
  completedAt?: number;
};

export type AgentToolLifecycleResult = {
  status: AgentToolTerminalStatus;
  summary?: string;
  error?: string;
};

export type RunAgentToolOptions<Input = unknown> = {
  input: Input;
  runId?: string;
  parentToolCallId?: string;
  displayOrder?: number;
  signal?: AbortSignal;
  inputPreview?: unknown;
  display?: AgentToolDisplayMetadata;
};

export type RunAgentToolResult<Output = unknown> = {
  runId: string;
  agentType: string;
  status: AgentToolTerminalStatus;
  output?: Output;
  summary?: string;
  error?: string;
};

export type ChatCapableAgentClass<T extends Agent = Agent> = SubAgentClass<T>;

export type AgentToolRunInspection<Output = unknown> = {
  runId: string;
  status: Exclude<AgentToolRunStatus, "interrupted">;
  requestId?: string;
  streamId?: string;
  output?: Output;
  summary?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
};

export type AgentToolStoredChunk = {
  sequence: number;
  body: string;
};

export type AgentToolChildAdapter<Input = unknown, Output = unknown> = {
  startAgentToolRun(
    input: Input,
    options: { runId: string; signal?: AbortSignal }
  ): Promise<AgentToolRunInspection<Output>>;
  cancelAgentToolRun(runId: string, reason?: unknown): Promise<void>;
  inspectAgentToolRun(
    runId: string
  ): Promise<AgentToolRunInspection<Output> | null>;
  getAgentToolChunks(
    runId: string,
    options?: { afterSequence?: number }
  ): Promise<AgentToolStoredChunk[]>;
  tailAgentToolRun?(
    runId: string,
    options?: { afterSequence?: number; signal?: AbortSignal }
  ): Promise<ReadableStream<AgentToolStoredChunk>>;
};

export type AgentToolEvent =
  | {
      kind: "started";
      runId: string;
      agentType: string;
      inputPreview?: unknown;
      order: number;
      display?: AgentToolDisplayMetadata;
    }
  | {
      kind: "chunk";
      runId: string;
      body: string;
    }
  | {
      kind: "finished";
      runId: string;
      summary: string;
    }
  | {
      kind: "error";
      runId: string;
      error: string;
    }
  | {
      kind: "aborted";
      runId: string;
      reason?: string;
    }
  | {
      kind: "interrupted";
      runId: string;
      error: string;
    };

export type AgentToolEventMessage = {
  type: "agent-tool-event";
  parentToolCallId?: string;
  sequence: number;
  replay?: true;
  event: AgentToolEvent;
};

export type AgentToolRunState = {
  runId: string;
  agentType: string;
  parentToolCallId?: string;
  inputPreview?: unknown;
  order: number;
  display?: AgentToolDisplayMetadata;
  status: "running" | "completed" | "error" | "aborted" | "interrupted";
  parts: UIMessage["parts"];
  summary?: string;
  error?: string;
  subAgent: { agent: string; name: string };
};

export type AgentToolEventState = {
  runsById: Record<string, AgentToolRunState>;
  runsByToolCallId: Record<string, AgentToolRunState[]>;
  unboundRuns: AgentToolRunState[];
};
