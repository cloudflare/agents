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
import { StreamNotFoundError } from "../streams/errors";
import { REPLAY_PAGE_BYTES, utf8Length } from "../internal/platform-limits";
import type { TaskJson } from "../tasks/types";
import { cancelTurn, submitTurn, type ChatLane } from "./chat-functions";
import {
  chatTurnStreamId,
  type ChatDeps,
  type ChatTurnResult
} from "./chat-host";

/** The most of a released summary a run too large to carry whole keeps. */
const OVERSIZED_SUMMARY_CHARS = 16_000;

/**
 * The tables `@cloudflare/ai-chat` 0.12.x kept its agent-tool child runs
 * in, which the upgrade carries forward and empties.
 */
export const RELEASED_AI_CHAT_AGENT_TOOL_TABLES = {
  runs: "cf_ai_chat_agent_tool_runs",
  milestones: "cf_ai_chat_agent_tool_milestones"
} as const;

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
  /** The run's input message: its reply follows it, also when it was queued. */
  inputMessageId?: string;
};

/**
 * Delete the streams settled agent-tool turns kept, except run `except`'s:
 * at the next agent-tool turn's start, and when the chat is cleared.
 */
export async function reclaimAgentToolStreams(
  deps: ChatDeps,
  except?: string
): Promise<void> {
  await deps.streams.list({ limit: 1 });
  const prefix = chatTurnStreamId(agentToolTurnId(""));
  const keep =
    except === undefined ? null : chatTurnStreamId(agentToolTurnId(except));
  const kept = deps.streams
    .__DO_NOT_USE_WILL_BREAK__sync()
    .listRows()
    .filter(
      (row) =>
        row.state !== "streaming" &&
        row.stream_id.startsWith(prefix) &&
        row.stream_id !== keep
    );
  for (const row of kept) await deps.streams.delete(row.stream_id);
}

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
  // The streams earlier agent-tool turns kept are reclaimed now.
  await reclaimAgentToolStreams(deps, runId);
  const agentTool: AgentToolTurnMeta = {
    runId,
    ...(options.terminalOnly ? { terminalOnly: true as const } : {}),
    startMessageId: options.startMessageId,
    inputMessageId: message.id
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
      metadata: {
        agentTool: agentTool as unknown as TaskJson,
        // The turn's stream is kept, completed, once its reply is stored,
        // as the release kept an agent-tool child's: a parent tails, re-
        // attaches or replays it by position. Reclaimed when the child's
        // next agent-tool turn starts.
        chat: { keepStream: true }
      }
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
  // Its stream is kept once the reply is stored (until the child's next
  // agent-tool turn starts): none, nothing to read.
  if ((await deps.streams.status(streamId)) === null) return [];
  // What this isolate buffered is written first.
  deps.streams.__DO_NOT_USE_WILL_BREAK__sync().flush(streamId);
  // What a recovery declined to keep is not replayed (the positions stay).
  const discarded =
    ((
      deps.tasks.peek(id)?.metadata?.agentTool as
        | { discarded?: unknown }
        | undefined
    )?.discarded as number | undefined) ??
    deps.tasks.checkpointOf<number>(id, "chat:discarded") ??
    0;
  const from = Math.max((options?.afterSequence ?? -1) + 1, discarded);
  const chunks: AgentToolStoredChunk[] = [];
  let bytes = 0;
  const stop = new AbortController();
  try {
    for await (const batch of deps.streams.readBatches(streamId, {
      from,
      signal: stop.signal,
      onUpToDate: () => stop.abort()
    })) {
      for (const item of batch) {
        const body = JSON.stringify(item.chunk);
        // One reply holds at most REPLAY_PAGE_BYTES of bodies (at least one
        // chunk): the reader asks again after the last it got.
        const size = utf8Length(body);
        if (chunks.length > 0 && bytes + size > REPLAY_PAGE_BYTES) {
          stop.abort();
          break;
        }
        bytes += size;
        chunks.push({ sequence: item.seq, body });
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
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      reader ??= deps.streams.readBatches(streamId, {
        from: (options.afterSequence ?? -1) + 1,
        signal
      }) as AsyncGenerator<{ seq: number; chunk: unknown }[]>;
      try {
        const next = await reader.next();
        if (next.done) {
          controller.close();
          return;
        }
        const batch = next.value;
        controller.enqueue(
          encoder.encode(
            batch.map((item) => line(item.seq, item.chunk)).join("")
          )
        );
      } catch (error) {
        // A stop of the read ends the tail; a stream deleted as the turn
        // settled ends it as a settled stream does.
        if (signal.aborted || error instanceof StreamNotFoundError) {
          controller.close();
        } else controller.error(error);
      }
    },
    cancel() {
      stop.abort();
    }
  });
}

/**
 * Released run `runId`, still open in its version's table (its turn is
 * still to be carried), or `null`.
 */
export function releasedAgentToolRunWaiting(
  sql: SqlStorage,
  table: string,
  runId: string
): { startedAt: number } | null {
  const exists =
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        table
      )
      .toArray().length > 0;
  if (!exists) return null;
  const row = sql
    .exec(
      `SELECT started_at FROM ${table} WHERE run_id = ? AND status IN ('running', 'starting') LIMIT 1`,
      runId
    )
    .toArray()[0] as { started_at: number } | undefined;
  return row ? { startedAt: row.started_at } : null;
}

/**
 * The open agent-tool run a released version kept for its turn
 * `requestId`, if any: the upgrade step that carries that turn starts its
 * run under {@link agentToolTurnId} of it, so the run carries on.
 */
export function releasedAgentToolRunOfRequest(
  sql: SqlStorage,
  table: string,
  requestId: string
): { runId: string; terminalOnly: boolean } | null {
  const exists =
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        table
      )
      .toArray().length > 0;
  if (!exists) return null;
  const row = sql
    .exec(
      `SELECT run_id, event_delivery FROM ${table} WHERE request_id = ? AND status IN ('running', 'starting') LIMIT 1`,
      requestId
    )
    .toArray()[0] as
    | { run_id: string; event_delivery: string | null }
    | undefined;
  return row
    ? { runId: row.run_id, terminalOnly: row.event_delivery === "terminal" }
    : null;
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
  definition: string,
  /**
   * Whether the released turn of request `requestId` still waits to be
   * carried: its run stays in the table until that step keys it under the
   * run's id (and calls this again).
   */
  pendingTurn: (requestId: string) => boolean = () => false,
  /**
   * Whether the tables may be dropped, asked once Tasks has started. A
   * facet must not drop a table an
   * earlier version made (it can reset its tree's storage): it deletes the
   * rows and leaves the empty table, which the next start skips.
   */
  mayDrop: () => boolean = () => true
): Promise<void> {
  const exists = (name: string) =>
    sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        name
      )
      .toArray().length > 0;
  if (!exists(tables.runs)) return;
  if (sql.exec(`SELECT 1 FROM ${tables.runs} LIMIT 1`).toArray().length === 0) {
    return;
  }
  // Tasks' own reads below need it started (its tables migrated): this
  // runs from a constructor.
  await deps.tasks.get(agentToolTurnId(""));
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
    last_signal_at: number | null;
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
  // Runs whose released turn is still to be carried: kept for that step.
  const waiting: string[] = [];
  for (const row of sql
    .exec(
      `SELECT run_id, request_id, status, output_json, summary, error_message, started_at, completed_at, progress_json, last_signal_at, event_delivery FROM ${tables.runs}`
    )
    .toArray() as ReleasedRun[]) {
    const fields: Record<string, unknown> = {
      runId: row.run_id,
      startMessageId: null,
      ...(row.event_delivery === "terminal" && { terminalOnly: true }),
      ...(row.progress_json !== null && {
        progress: {
          ...(parse(row.progress_json) as object),
          at: row.last_signal_at ?? row.started_at
        }
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
    const open = row.status === "running" || row.status === "starting";
    // Its turn carried on under the run's id by the upgrade step: that run
    // is the run's now. What the row kept goes onto it.
    if (open && deps.tasks.peek(agentToolTurnId(row.run_id))) {
      const { runId: _runId, startMessageId: _start, ...kept } = fields;
      if (Object.keys(kept).length > 0) {
        deps.tasks.patchMetadata(
          agentToolTurnId(row.run_id),
          "agentTool",
          kept as Record<string, TaskJson>
        );
      }
      continue;
    }
    if (open && row.request_id !== null && pendingTurn(row.request_id)) {
      waiting.push(row.run_id);
      continue;
    }
    if (status === "error" && row.request_id !== null && open) {
      interrupted.push(row.request_id);
    }
    if (status === "completed") {
      const output = parse(row.output_json);
      fields.result = {
        ...(output !== undefined && { output }),
        ...(row.summary !== null && { summary: row.summary })
      };
    }
    const record = (agentTool: Record<string, unknown>) => ({
      runId: agentToolTurnId(row.run_id),
      definition,
      status: status as "completed" | "aborted" | "error",
      attempt: 1,
      retain: true,
      metadata: { agentTool: agentTool as TaskJson },
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
    try {
      await deps.tasks.importRun(record(fields));
    } catch {
      // Too large for a run's metadata (a big output, many milestones):
      // the run is carried with its summary, capped, and the rest go on.
      const summary = row.summary?.slice(0, OVERSIZED_SUMMARY_CHARS);
      await deps.tasks.importRun(
        record({
          runId: row.run_id,
          startMessageId: null,
          ...(status === "completed" && {
            result: { ...(summary !== undefined && { summary }) }
          })
        })
      );
    }
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
  if (waiting.length > 0) {
    // Everything else is carried: only the waiting rows stay.
    const keep = waiting.map(() => "?").join(", ");
    sql.exec(
      `DELETE FROM ${tables.runs} WHERE run_id NOT IN (${keep})`,
      ...waiting
    );
    if (exists(tables.milestones)) {
      sql.exec(
        `DELETE FROM ${tables.milestones} WHERE run_id NOT IN (${keep})`,
        ...waiting
      );
    }
    return;
  }
  if (!mayDrop()) {
    sql.exec(`DELETE FROM ${tables.runs}`);
    if (exists(tables.milestones)) sql.exec(`DELETE FROM ${tables.milestones}`);
    return;
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
