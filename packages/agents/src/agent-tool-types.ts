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

/**
 * Structured failure envelope an `agentTool()` returns when a sub-agent run
 * does not complete. Instead of an opaque error string the parent model would
 * parrot back to the user, the caller (or an orchestration harness) gets a
 * machine-readable signal:
 *
 * - `status` mirrors the underlying terminal status (`error` | `aborted` |
 *   `interrupted`).
 * - `retryable` is `true` only for a transient interruption — the child was
 *   reset or superseded by a deploy / parent recovery and never reached a
 *   logical outcome, so re-dispatching the same run is the right move. A
 *   genuine `error` or an intentional `aborted` is `false`.
 * - `error` stays human-readable for logs and UI.
 */
export type AgentToolFailure = {
  ok: false;
  status: Exclude<AgentToolTerminalStatus, "completed">;
  error: string;
  retryable: boolean;
};

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
