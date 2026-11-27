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
import { StreamNotFoundError } from "../streams/errors";
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
  options: {
    terminalOnly?: boolean;
    startMessageId: string | null;
    /** The turn's request body (the run's input, for the host's hooks). */
    body?: Record<string, unknown>;
  }
): Promise<void> {
  const agentTool: AgentToolTurnMeta = {
    runId,
    ...(options.terminalOnly ? { terminalOnly: true as const } : {}),
    startMessageId: options.startMessageId
  };
  await submitTurn(
    deps,
    lane,
    {
      trigger: "server",
      messages: [message],
      // No client's tools: the run has no tab.
      clientTools: [],
      ...(options.body && { body: options.body })
    },
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
 * each milestone is its own field, by its sequence. `false` when the turn is not one.
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
          [`milestone:${report.milestone.sequence}`]:
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
    streamId: chatTurnStreamId(id),
    startedAt: record.createdAt,
    ...(progress ? { progress } : {}),
    ...(milestones.length ? { milestones } : {})
  };
  // A cancel is the run's end as soon as it is asked, with its reason; its
  // turn leaves the lane when it comes up.
  const cancelled = fields.cancelled as string | undefined;
  if (record.status === "pending" || record.status === "running") {
    return cancelled === undefined
      ? { ...base, status: "running" }
      : { ...base, status: "aborted", error: cancelled };
  }
  if (record.status === "aborted" || record.status === "skipped") {
    const error = cancelled ?? record.reason;
    return { ...base, status: "aborted", ...(error ? { error } : {}) };
  }
  const result = record.result as ChatTurnResult | undefined;
  // A run carried forward from a released version keeps its result here.
  const kept = fields.result as
    | { output?: unknown; summary?: string }
    | undefined;
  if (record.status === "completed" && kept) {
    return {
      ...base,
      status: "completed",
      ...(kept.output !== undefined && { output: kept.output }),
      ...(kept.summary !== undefined && { summary: kept.summary })
    };
  }
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
  chunks.push({
    type: "finish",
    ...(message.metadata !== undefined && {
      messageMetadata: message.metadata
    })
  } as UIMessageChunk);
  return chunks;
}

/**
 * Run `runId`'s chunks after `afterSequence`. While the run is live they
 * are its stream's, numbered by their place in it. Once it settled the
 * cutover dropped the stream: the stored reply's chunks, numbered from 0.
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
    // Numbered from 0 as the replay's own: a reader pages through it.
    const after = options?.afterSequence ?? -1;
    return chunksOfMessage(message as unknown as UIMessage)
      .map((chunk, sequence) => ({ sequence, body: JSON.stringify(chunk) }))
      .filter((chunk) => chunk.sequence > after);
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

/**
 * Follow run `runId`'s live stream from after `afterSequence`: newline-
 * delimited `{ sequence, body }` lines, each chunk as the stream is woken
 * with it, until the run's turn settles. `null` when the turn has no stream
 * open (not started yet, or settled): the parent reads chunks then.
 */
export async function tailAgentToolTurn(
  deps: ChatDeps,
  runId: string,
  options: { afterSequence?: number; signal?: AbortSignal } = {}
): Promise<ReadableStream<Uint8Array> | null> {
  const streamId = chatTurnStreamId(agentToolTurnId(runId));
  if ((await deps.streams.status(streamId))?.state !== "streaming") {
    return null;
  }
  const stop = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, stop.signal])
    : stop.signal;
  const encoder = new TextEncoder();
  const line = (sequence: number, chunk: unknown) =>
    `${JSON.stringify({ sequence, body: JSON.stringify(chunk) })}\n`;
  let reader: AsyncGenerator<{ seq: number; chunk: unknown }[]> | undefined;
  let last: { sequence: number; type: unknown } | undefined;
  // The turn writes its last chunks as it stores the reply and drops the
  // stream, in one step a reader cannot see: when the stream ended before
  // the reply's finish, the stored reply's finish closes the message.
  const end = async (
    controller: ReadableStreamDefaultController<Uint8Array>
  ) => {
    if (!signal.aborted && last?.type !== "finish") {
      const id = agentToolTurnId(runId);
      const record = await deps.tasks.wait(id, { signal }).catch(() => null);
      const messageId = (record?.result as ChatTurnResult | undefined)
        ?.messageId;
      if (record?.status === "completed" && messageId) {
        const input = deps.tasks.inputOf<{ session?: string }>(id);
        const message = await deps.sessions
          .session(input?.session ?? deps.session ?? "")
          .getMessage(messageId);
        const finish = message
          ? chunksOfMessage(message as unknown as UIMessage).at(-1)
          : undefined;
        if (finish) {
          controller.enqueue(
            encoder.encode(
              line((last?.sequence ?? options.afterSequence ?? -1) + 1, finish)
            )
          );
        }
      }
    }
    controller.close();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= deps.streams.readBatches(streamId, {
        from: (options.afterSequence ?? -1) + 1,
        signal
      }) as AsyncGenerator<{ seq: number; chunk: unknown }[]>;
      try {
        const next = await reader.next();
        if (next.done) return await end(controller);
        const batch = next.value;
        const tip = batch[batch.length - 1];
        last = {
          sequence: tip.seq,
          type: (tip.chunk as { type?: unknown } | null)?.type
        };
        controller.enqueue(
          encoder.encode(
            batch.map((item) => line(item.seq, item.chunk)).join("")
          )
        );
      } catch (error) {
        // A stop of the read ends the tail; a stream deleted as the turn
        // settled ends it as a settled stream does.
        if (signal.aborted) controller.close();
        else if (error instanceof StreamNotFoundError) await end(controller);
        else controller.error(error);
      }
    },
    cancel() {
      stop.abort();
    }
  });
}

/**
 * Carry the agent-tool runs a released version kept in its own tables onto
 * the chat turn runs this version reads, once, then drop the tables. A run
 * that was still running is carried as an error: nothing of this version
 * owns its turn.
 */
export async function carryForwardAgentToolRuns(
  deps: ChatDeps,
  sql: SqlStorage,
  tables: { runs: string; milestones: string },
  definition: string
): Promise<void> {
  const exists = (name: string) =>
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        name
      )
      .toArray().length > 0;
  if (!exists(tables.runs)) return;
  type ReleasedRun = {
    run_id: string;
    request_id: string | null;
    status: string;
    output_json: string | null;
    summary: string | null;
    error_message: string | null;
    started_at: number;
    completed_at: number | null;
    progress_json: string | null;
    event_delivery: string | null;
  };
  const parse = (json: string | null): unknown => {
    if (json === null) return undefined;
    try {
      return JSON.parse(json);
    } catch {
      return undefined;
    }
  };
  const milestones = new Map<string, AgentToolMilestone[]>();
  if (exists(tables.milestones)) {
    for (const row of sql
      .exec(
        `SELECT run_id, sequence, name, data_json, at FROM ${tables.milestones} ORDER BY sequence`
      )
      .toArray() as {
      run_id: string;
      sequence: number;
      name: string;
      data_json: string | null;
      at: number;
    }[]) {
      const list = milestones.get(row.run_id) ?? [];
      list.push({
        name: row.name,
        sequence: row.sequence,
        at: row.at,
        ...(row.data_json !== null && { data: parse(row.data_json) })
      } as AgentToolMilestone);
      milestones.set(row.run_id, list);
    }
  }
  const interrupted: string[] = [];
  for (const row of sql
    .exec(
      `SELECT run_id, request_id, status, output_json, summary, error_message, started_at, completed_at, progress_json, event_delivery FROM ${tables.runs}`
    )
    .toArray() as ReleasedRun[]) {
    const fields: Record<string, unknown> = {
      runId: row.run_id,
      startMessageId: null,
      ...(row.event_delivery === "terminal" && { terminalOnly: true }),
      ...(row.progress_json !== null && {
        progress: parse(row.progress_json)
      })
    };
    for (const milestone of milestones.get(row.run_id) ?? []) {
      fields[`milestone:${milestone.sequence}`] = milestone;
    }
    const status =
      row.status === "completed"
        ? "completed"
        : row.status === "aborted"
          ? "aborted"
          : "error";
    if (
      status === "error" &&
      row.request_id !== null &&
      (row.status === "running" || row.status === "starting")
    ) {
      interrupted.push(row.request_id);
    }
    if (status === "completed") {
      const output = parse(row.output_json);
      fields.result = {
        ...(output !== undefined && { output }),
        ...(row.summary !== null && { summary: row.summary })
      };
    }
    await deps.tasks.importRun({
      runId: agentToolTurnId(row.run_id),
      definition,
      status,
      attempt: 1,
      retain: true,
      metadata: { agentTool: fields as TaskJson },
      ...(status === "error" && {
        error:
          row.error_message ??
          (row.status === "running" || row.status === "starting"
            ? "Agent tool run was interrupted by an upgrade."
            : "Agent tool run failed")
      }),
      ...(status === "aborted" &&
        row.error_message !== null && { error: row.error_message }),
      ...(status === "completed" && {
        result: { requestId: agentToolTurnId(row.run_id), status: "completed" }
      }),
      createdAt: row.started_at,
      settledAt: row.completed_at ?? Date.now()
    });
  }
  // A turn of a run carried as an error is not the run's any more: if the
  // upgrade carried it on as a chat turn, it stops, so it calls no model.
  for (const requestId of interrupted) {
    const status = deps.tasks.peek(requestId)?.status;
    if (status === "pending" || status === "running") {
      await cancelTurn(
        deps,
        requestId,
        "Agent tool run was interrupted by an upgrade."
      );
    }
  }
  sql.exec(`DROP TABLE IF EXISTS ${tables.milestones}`);
  sql.exec(`DROP TABLE ${tables.runs}`);
}

/** Cancel run `runId`: it ends `aborted` with `reason`, from any state. */
export function cancelAgentToolTurn(
  deps: ChatDeps,
  runId: string,
  reason: string
): Promise<boolean> {
  const id = agentToolTurnId(runId);
  const status = deps.tasks.peek(id)?.status;
  // Marked at once, before the lane acts on the stop.
  if (status === "pending" || status === "running") {
    deps.tasks.patchMetadata(id, "agentTool", { cancelled: reason });
  }
  return cancelTurn(deps, id, reason);
}
