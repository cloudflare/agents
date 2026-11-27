/**
 * An agent run as a tool, on the chat module's turn definition: the run is
 * the child's chat turn, one Task run under `agent-tool:<runId>`, kept
 * across every attempt of that turn (a reset replays it, a retry wakes it).
 * What a parent reads (`inspect`, `chunks`) and does (`cancel`) is read off
 * and done to that run. Nothing here keeps a table.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type { UIMessage } from "ai";
import type {
  AgentToolMilestone,
  AgentToolProgressSnapshot,
  AgentToolRunInspection,
  AgentToolStoredChunk
} from "../agent-tool-types";
import type { TaskCheckpoint, TaskJson } from "../tasks/types";
import { cancelTurn, submitTurn, type ChatLane } from "./chat-functions";
import {
  chatTurnStreamId,
  type ChatDeps,
  type ChatTurnResult
} from "./chat-host";

/** The chat-turn run id of agent-tool run `runId`. */
export function agentToolTurnId(runId: string): string {
  return `agent-tool:${runId}`;
}

/** What an agent-tool turn keeps in its run's metadata. */
export type AgentToolTurnMeta = {
  runId: string;
  /** Started with `eventDelivery: "terminal"`. */
  terminalOnly?: true;
  /** The newest message when the turn was submitted: what follows is the run's. */
  startMessageId: string | null;
};

/** The checkpoint key of a run's latest progress. */
const PROGRESS_CHECKPOINT = "agentTool:progress";
/** The checkpoint key prefix of a run's milestones, one key each. */
const MILESTONE_CHECKPOINT = "agentTool:milestone:";

/**
 * Start agent-tool run `runId` as one turn on `lane`: `message` is the
 * run's input as a user message. A second start of the same id joins the
 * run that is there.
 */
export async function startAgentToolTurn(
  deps: ChatDeps,
  lane: ChatLane,
  runId: string,
  message: UIMessage,
  options: { terminalOnly?: boolean; startMessageId: string | null }
): Promise<void> {
  const agentTool: AgentToolTurnMeta = {
    runId,
    ...(options.terminalOnly ? { terminalOnly: true as const } : {}),
    startMessageId: options.startMessageId
  };
  await submitTurn(
    deps,
    lane,
    { trigger: "agent-tool", messages: [message] },
    {
      requestId: agentToolTurnId(runId),
      retain: true,
      metadata: { agentTool: agentTool as unknown as TaskJson }
    }
  );
}

/** The agent-tool metadata of run `requestId`, if it is an agent-tool turn. */
export function agentToolTurnOf(
  deps: ChatDeps,
  requestId: string
): AgentToolTurnMeta | undefined {
  const metadata = deps.tasks.peek(requestId)?.metadata as
    | { agentTool?: AgentToolTurnMeta }
    | undefined;
  return metadata?.agentTool;
}

/**
 * Record progress or a milestone for the turn `checkpoint` belongs to: one
 * statement each, readable while the run is live.
 */
export function recordAgentToolProgress(
  checkpoint: TaskCheckpoint,
  report:
    | { kind: "progress"; snapshot: AgentToolProgressSnapshot }
    | { kind: "milestone"; milestone: AgentToolMilestone }
): void {
  if (report.kind === "progress") {
    checkpoint.set(PROGRESS_CHECKPOINT, report.snapshot as unknown as TaskJson);
    return;
  }
  checkpoint.set(
    `${MILESTONE_CHECKPOINT}${report.milestone.name}`,
    report.milestone as unknown as TaskJson
  );
}

/**
 * What a parent sees of run `runId`, or `null` when the child has no such
 * run. `collect` reads the output and summary of the reply a completed turn
 * stored.
 */
export function inspectAgentToolTurn(
  deps: ChatDeps,
  runId: string,
  collect: (messageId: string | undefined) => {
    output: unknown;
    summary: string | null;
  },
  milestoneNames: readonly string[] = []
): AgentToolRunInspection | null {
  const id = agentToolTurnId(runId);
  const record = deps.tasks.peek(id);
  if (!record) return null;
  const progress = deps.tasks.checkpointOf(id, PROGRESS_CHECKPOINT) as
    | AgentToolProgressSnapshot
    | undefined;
  const milestones = milestoneNames
    .map(
      (name) =>
        deps.tasks.checkpointOf(id, `${MILESTONE_CHECKPOINT}${name}`) as
          | AgentToolMilestone
          | undefined
    )
    .filter((milestone): milestone is AgentToolMilestone => !!milestone);
  const base = {
    runId,
    requestId: id,
    ...(progress ? { progress } : {}),
    ...(milestones.length ? { milestones } : {})
  };
  if (record.status === "pending" || record.status === "running") {
    return { ...base, status: "running" };
  }
  if (record.status === "aborted" || record.status === "skipped") {
    return {
      ...base,
      status: "aborted",
      ...(record.reason ? { error: record.reason } : {})
    };
  }
  const result = record.result as ChatTurnResult | undefined;
  if (record.status === "error" || result?.status === "error") {
    return {
      ...base,
      status: "error",
      error: result?.error ?? record.error?.message ?? "Agent tool run failed"
    };
  }
  if (result?.status === "aborted" || result?.status === "skipped") {
    return { ...base, status: "aborted" };
  }
  const { output, summary } = collect(result?.messageId);
  return {
    ...base,
    status: "completed",
    output,
    ...(summary !== null ? { summary } : {})
  };
}

/**
 * Run `runId`'s stored chunks after `afterSequence`, numbered by their place
 * in the run's one stream.
 */
export async function agentToolTurnChunks(
  deps: ChatDeps,
  runId: string,
  options?: { afterSequence?: number }
): Promise<AgentToolStoredChunk[]> {
  const streamId = chatTurnStreamId(agentToolTurnId(runId));
  if ((await deps.streams.status(streamId)) === null) return [];
  // What this isolate buffered is written first.
  deps.streams.__DO_NOT_USE_WILL_BREAK__sync().flush(streamId);
  const from = (options?.afterSequence ?? -1) + 1;
  const chunks: AgentToolStoredChunk[] = [];
  const stop = new AbortController();
  try {
    for await (const batch of deps.streams.readBatches(streamId, {
      from,
      signal: stop.signal,
      onUpToDate: () => stop.abort()
    })) {
      for (const item of batch) {
        chunks.push({ sequence: item.seq, body: JSON.stringify(item.chunk) });
      }
      if (stop.signal.aborted) break;
    }
  } catch (error) {
    if (!stop.signal.aborted) throw error;
  }
  return chunks;
}

/** Cancel run `runId`: it ends `aborted` with `reason`, from any state. */
export function cancelAgentToolTurn(
  deps: ChatDeps,
  runId: string,
  reason: string
): Promise<boolean> {
  return cancelTurn(deps, agentToolTurnId(runId), reason);
}
