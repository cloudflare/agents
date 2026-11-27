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

import type { UIMessage, UIMessageChunk } from "ai";
import type {
  AgentToolMilestone,
  AgentToolProgressSnapshot,
  AgentToolRunInspection,
  AgentToolStoredChunk
} from "../agent-tool-types";
import type { TaskJson } from "../tasks/types";
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
    { trigger: "server", messages: [message] },
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
 * Record progress or a milestone on the agent-tool turn `requestId` (the
 * tool's `ChatModelCall.requestId`): one field of the run's metadata each,
 * one statement, kept after the run settles. Progress replaces the last;
 * each milestone is its own field. `false` when the turn is not one.
 */
export function recordAgentToolProgress(
  deps: ChatDeps,
  requestId: string,
  report:
    | { kind: "progress"; snapshot: AgentToolProgressSnapshot }
    | { kind: "milestone"; milestone: AgentToolMilestone }
): boolean {
  if (!agentToolTurnOf(deps, requestId)) return false;
  return deps.tasks.patchMetadata(
    requestId,
    "agentTool",
    report.kind === "progress"
      ? { progress: report.snapshot as unknown as TaskJson }
      : {
          [`milestone:${report.milestone.name}`]:
            report.milestone as unknown as TaskJson
        }
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
  }
): AgentToolRunInspection | null {
  const id = agentToolTurnId(runId);
  const record = deps.tasks.peek(id);
  if (!record) return null;
  const fields = ((record.metadata as { agentTool?: Record<string, unknown> })
    ?.agentTool ?? {}) as Record<string, unknown>;
  const progress = fields.progress as AgentToolProgressSnapshot | undefined;
  const milestones = Object.entries(fields)
    .filter(([key]) => key.startsWith("milestone:"))
    .map(([, milestone]) => milestone as AgentToolMilestone)
    .sort((left, right) => left.at - right.at);
  const base = {
    runId,
    requestId: id,
    startedAt: record.createdAt,
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
 * The chunks that build `message` again: a start, each part as the chunks
 * a model call sends for it (settled), and a finish. What a parent replays
 * of a turn that settled, whose stream the cutover dropped: the stored
 * reply is its record.
 */
export function chunksOfMessage(message: UIMessage): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = [{ type: "start", messageId: message.id }];
  message.parts.forEach((part, index) => {
    const id = `${message.id}-${index}`;
    if (part.type === "step-start") {
      chunks.push({ type: "start-step" });
    } else if (part.type === "text") {
      chunks.push(
        { type: "text-start", id },
        { type: "text-delta", id, delta: part.text },
        { type: "text-end", id }
      );
    } else if (part.type === "reasoning") {
      chunks.push(
        { type: "reasoning-start", id },
        { type: "reasoning-delta", id, delta: part.text },
        { type: "reasoning-end", id }
      );
    } else if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const tool = part as {
        type: string;
        toolName?: string;
        toolCallId: string;
        state: string;
        input?: unknown;
        output?: unknown;
        errorText?: string;
      };
      const toolName =
        tool.type === "dynamic-tool"
          ? (tool.toolName ?? "")
          : tool.type.slice("tool-".length);
      chunks.push({
        type: "tool-input-available",
        toolCallId: tool.toolCallId,
        toolName,
        input: tool.input,
        ...(tool.type === "dynamic-tool" ? { dynamic: true } : {})
      } as UIMessageChunk);
      if (tool.state === "output-available") {
        chunks.push({
          type: "tool-output-available",
          toolCallId: tool.toolCallId,
          output: tool.output
        } as UIMessageChunk);
      } else if (tool.state === "output-error") {
        chunks.push({
          type: "tool-output-error",
          toolCallId: tool.toolCallId,
          errorText: tool.errorText ?? ""
        } as UIMessageChunk);
      }
    } else if (part.type.startsWith("data-")) {
      chunks.push(part as UIMessageChunk);
    } else if (part.type === "file") {
      chunks.push({
        type: "file",
        url: part.url,
        mediaType: part.mediaType
      });
    }
  });
  chunks.push({ type: "finish" });
  return chunks;
}

/**
 * Run `runId`'s chunks after `afterSequence`. While the run is live they
 * are its stream's, numbered by their place in it. Once it settled the
 * cutover dropped the stream: a replay from the start gets the stored
 * reply's chunks, numbered from 0, and a reader that already had a position
 * in the stream gets none.
 */
export async function agentToolTurnChunks(
  deps: ChatDeps,
  runId: string,
  options?: { afterSequence?: number }
): Promise<AgentToolStoredChunk[]> {
  const id = agentToolTurnId(runId);
  const streamId = chatTurnStreamId(id);
  if ((await deps.streams.status(streamId)) === null) {
    const result = deps.tasks.peek(id)?.result as ChatTurnResult | undefined;
    if (!result?.messageId) return [];
    const input = deps.tasks.inputOf<{ session?: string }>(id);
    const message = await deps.sessions
      .session(input?.session ?? deps.session ?? "")
      .getMessage(result.messageId);
    if (!message) return [];
    // A reader with a position read the live stream, whose numbering this
    // is not: it saw the reply already. A replay from the start gets it.
    if ((options?.afterSequence ?? -1) >= 0) return [];
    return chunksOfMessage(message as unknown as UIMessage).map(
      (chunk, sequence) => ({ sequence, body: JSON.stringify(chunk) })
    );
  }
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
