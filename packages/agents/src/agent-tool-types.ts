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
 * Machine-readable cause of an `interrupted` seal (#1630 follow-up). Lets a
 * caller branch on WHY a run was abandoned without parsing the human-readable
 * `error` prose, which is not a stable contract.
 *
 * - `no-progress` — the child went silent for a full no-progress window while
 *   the parent was tailing it (genuinely stalled / hung).
 * - `window-exceeded` — a finite `agentToolReattachMaxWindowMs` ceiling elapsed
 *   while the child was still non-terminal. Only fires when an integrator opts
 *   into a hard wall-clock cap (the default ceiling is `Infinity`).
 * - `not-tailable` — the child runtime cannot live-tail, so the parent could
 *   not re-attach to its stream to follow it to terminal.
 * - `inspect-timeout` — inspecting the child timed out during parent recovery.
 * - `inspect-failed` — inspecting the child failed during parent recovery.
 * - `recovery-deadline` — the overall parent-recovery deadline elapsed before
 *   this run could be reconciled.
 */
export type AgentToolInterruptedReason =
  | "no-progress"
  | "window-exceeded"
  | "not-tailable"
  | "inspect-timeout"
  | "inspect-failed"
  | "recovery-deadline";

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
  /** Present only when `status` is `interrupted` — machine-readable cause. */
  reason?: AgentToolInterruptedReason;
  /**
   * Present only when `status` is `interrupted`. `true` when the child facet was
   * still non-terminal (running / advancing) at the moment the parent stopped
   * waiting; `false` once the parent has torn the child down so it is no longer
   * doing work. Lets a caller decide between re-dispatching vs. reconnecting.
   */
  childStillRunning?: boolean;
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
  /** Present only when `status` is `interrupted` — machine-readable cause. */
  reason?: AgentToolInterruptedReason;
  /**
   * Present only when `status` is `interrupted`. Whether the child facet was
   * still non-terminal when the parent stopped waiting (before any teardown).
   */
  childStillRunning?: boolean;
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
  /**
   * Present only when `status` is `interrupted` — a machine-readable cause so
   * callers don't pattern-match the `error` prose (#1630 follow-up).
   */
  reason?: AgentToolInterruptedReason;
  /**
   * Present only when `status` is `interrupted`. `true` when the child facet was
   * still non-terminal (running / advancing) at the moment the parent stopped
   * waiting and before any teardown; `false` once the parent has torn the child
   * down so it is no longer doing work.
   */
  childStillRunning?: boolean;
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
      /** Machine-readable cause of the interrupt (#1630 follow-up). */
      reason?: AgentToolInterruptedReason;
      /**
       * Whether the child facet was still non-terminal when the parent stopped
       * waiting (before any teardown). Lets a UI distinguish a still-running
       * child from one the parent has torn down.
       */
      childStillRunning?: boolean;
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
  /**
   * Present only when `status` is `interrupted` — machine-readable cause and
   * whether the child is still running, mirrored from the wire event so a UI
   * can render the reason without parsing `error` (#1630 follow-up).
   */
  reason?: AgentToolInterruptedReason;
  childStillRunning?: boolean;
  subAgent: { agent: string; name: string };
};

export type AgentToolEventState = {
  runsById: Record<string, AgentToolRunState>;
  runsByToolCallId: Record<string, AgentToolRunState[]>;
  unboundRuns: AgentToolRunState[];
};
