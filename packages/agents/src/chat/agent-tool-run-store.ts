/**
 * The run table of an agent that runs as an agent tool, and its milestones.
 * One implementation for `@cloudflare/ai-chat` and `@cloudflare/think`: the
 * hosts differ only in the names of their tables.
 *
 * The store reads and writes. It decides nothing: whether a row may still
 * be written is `AgentToolRuns`' call.
 *
 * @internal Sibling-package support for `@cloudflare/ai-chat` and
 * `@cloudflare/think`, not a public API.
 */

import type {
  AgentToolMilestone,
  AgentToolProgressSnapshot
} from "../agent-tool-types";

/** One run row. */
export interface AgentToolRunRecord {
  runId: string;
  /**
   * `starting` and `running` are open (see `isAgentToolRunOpen`); anything
   * else is terminal.
   */
  status: string;
  /** The request id of the turn that streams for the run, if one was bound. */
  requestId: string | null;
  /**
   * The first request id bound to the run. A rebind replaces
   * {@link requestId} but never this one, and chat recovery keeps naming a
   * turn by it however many times the turn is recovered.
   */
  rootRequestId: string | null;
  /** The stream recorded with the terminal status, if one was. */
  streamId: string | null;
  /** The run's input, as it was stored. */
  input: unknown;
  /** The output stored with `completed`. */
  output: unknown;
  summary: string | null;
  /** A stream error recorded on the row, terminal or not, or a cancel reason. */
  error: string | null;
  startedAt: number;
  completedAt: number | null;
  /** The latest progress the run reported. */
  progress?: AgentToolProgressSnapshot;
  /** The run was started with `eventDelivery: "terminal"`. */
  terminalOnly: boolean;
}

/** A terminal status and what is stored with it. */
export type AgentToolRunTerminal =
  | { status: "completed"; output: unknown; summary: string | null }
  | { status: "error"; error: string }
  | { status: "aborted"; error: string | null };

/** What `AgentToolRuns` needs from a run table. */
export interface AgentToolRunStore {
  /** Create the tables and add the columns an older version lacks. */
  ensure(): void;
  /** The row of `runId`, or `null`. */
  read(runId: string): AgentToolRunRecord | null;
  /**
   * The open run that started last, or `null`. Does not create the tables:
   * every recovered turn asks, on agents that never ran as an agent tool
   * too.
   */
  newestOpen(): AgentToolRunRecord | null;
  /** The open run whose row names `requestId`, or `null`. */
  openForRequest(requestId: string): AgentToolRunRecord | null;
  /**
   * The run whose row names `requestId` as its current or its first request
   * id, open or not, or `null`. Does not create the tables.
   */
  forRequest(requestId: string): AgentToolRunRecord | null;
  /** The ids of every open run. Does not create the tables. */
  listOpen(): string[];
  /** Insert the row of a new run, `running`. */
  insert(
    runId: string,
    run: { input: unknown; startedAt: number; terminalOnly: boolean }
  ): void;
  /**
   * Put the request id of the run's turn on its row. The first one bound
   * also becomes the run's root request id, which later binds leave alone.
   */
  bindRequest(runId: string, requestId: string): void;
  /** Record a stream error on the row. */
  recordStreamError(runId: string, error: string): void;
  /**
   * Write `terminal` to the row.
   *
   * @param turn - The request id of the turn that produced it, and the
   *   stream that turn wrote.
   */
  writeTerminal(
    runId: string,
    terminal: AgentToolRunTerminal,
    turn?: { requestId: string; streamId: string | null }
  ): void;
  /** Store the latest progress snapshot and the time of the signal. */
  writeProgress(
    runId: string,
    snapshot: Omit<AgentToolProgressSnapshot, "at">,
    at: number
  ): void;
  /**
   * Store a milestone and the time of the signal.
   *
   * @returns The milestone's sequence, which grows by one per run.
   */
  addMilestone(runId: string, name: string, data: unknown, at: number): number;
  /** The run's milestones, oldest first. */
  milestones(runId: string): AgentToolMilestone[];
}

/** The part of Durable Object SQL storage the store uses. */
export interface AgentToolSql {
  exec(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): Record<string, unknown>[] };
}

/** The names a host gives its tables. They are constants, never user input. */
export interface AgentToolTableNames {
  runs: string;
  milestones: string;
  /** The index on the run table's `request_id`. */
  requestIndex: string;
}

const OPEN = "status in ('starting', 'running')";

const COLUMNS = [
  ["request_id", "text"],
  ["root_request_id", "text"],
  ["stream_id", "text"],
  ["input_json", "text"],
  ["output_json", "text"],
  ["summary", "text"],
  ["error_message", "text"],
  ["completed_at", "integer"],
  // The latest progress snapshot; `last_signal_at` drives the parent's
  // resetting no-progress budget across an eviction.
  ["progress_json", "text"],
  ["last_signal_at", "integer"],
  ["event_delivery", "text"]
] as const;

type Row = {
  run_id: string;
  status: string;
  request_id: string | null;
  root_request_id: string | null;
  stream_id: string | null;
  input_json: string | null;
  output_json: string | null;
  summary: string | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
  progress_json: string | null;
  last_signal_at: number | null;
  event_delivery: string | null;
};

/** Store a value as JSON. A value JSON cannot hold is stored as its string. */
function toJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return JSON.stringify(String(value));
  }
}

function fromJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function progressOf(row: Row): AgentToolProgressSnapshot | undefined {
  if (row.progress_json === null || row.last_signal_at === null) {
    return undefined;
  }
  const parsed = fromJson(row.progress_json);
  return {
    ...(typeof parsed === "object" && parsed !== null ? parsed : {}),
    at: row.last_signal_at
  };
}

function record(row: Row | undefined): AgentToolRunRecord | null {
  if (!row) return null;
  const progress = progressOf(row);
  return {
    runId: row.run_id,
    status: row.status,
    requestId: row.request_id,
    rootRequestId: row.root_request_id,
    streamId: row.stream_id,
    input: fromJson(row.input_json),
    output: fromJson(row.output_json),
    summary: row.summary,
    error: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    ...(progress ? { progress } : {}),
    terminalOnly: row.event_delivery === "terminal"
  };
}

/**
 * The run table on Durable Object SQL storage.
 *
 * @param sql - Resolved on each use, so a host can construct the store
 *   before its storage is ready.
 */
export function createAgentToolRunStore(
  sql: () => AgentToolSql,
  tables: AgentToolTableNames
): AgentToolRunStore {
  const { runs, milestones, requestIndex } = tables;
  const all = <T>(query: string, ...bindings: unknown[]): T[] =>
    sql()
      .exec(query, ...bindings)
      .toArray() as T[];
  const run = (query: string, ...bindings: unknown[]): void => {
    sql().exec(query, ...bindings);
  };

  // The DDL is paid once per isolate, not per call.
  let ready = false;
  const ensure = (): void => {
    if (ready) return;
    run(
      `create table if not exists ${runs} (
        run_id text primary key,
        status text not null,
        started_at integer not null
      )`
    );
    // `add column` has no "if not exists", so a column that is already
    // there is the one error to let pass.
    for (const [name, type] of COLUMNS) {
      try {
        run(`alter table ${runs} add column ${name} ${type}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("duplicate column")) throw error;
      }
    }
    run(`create index if not exists ${requestIndex} on ${runs}(request_id)`);
    // One row per milestone; `sequence` grows by one per run, so a replay
    // and a live frame of the same milestone dedupe.
    run(
      `create table if not exists ${milestones} (
        run_id text not null,
        sequence integer not null,
        name text not null,
        data_json text,
        at integer not null,
        primary key (run_id, sequence)
      )`
    );
    ready = true;
  };
  /** Ensure the tables only when the run table already exists. */
  const existing = (): boolean => {
    if (ready) return true;
    const found = all(
      "select name from sqlite_master where type = 'table' and name = ?",
      runs
    );
    if (found.length === 0) return false;
    // It may predate newer columns.
    ensure();
    return true;
  };
  const one = (where: string, ...bindings: unknown[]) =>
    record(all<Row>(`select * from ${runs} where ${where}`, ...bindings)[0]);

  return {
    ensure,
    read: (runId) => {
      ensure();
      return one("run_id = ?", runId);
    },
    // An agent addressed by its run id owns at most one run row; the order
    // is defensive.
    newestOpen: () =>
      existing() ? one(`${OPEN} order by started_at desc limit 1`) : null,
    openForRequest: (requestId) => {
      ensure();
      return one(`request_id = ? and ${OPEN} limit 1`, requestId);
    },
    forRequest: (requestId) =>
      existing()
        ? one(
            "request_id = ? or root_request_id = ? limit 1",
            requestId,
            requestId
          )
        : null,
    listOpen: () =>
      existing()
        ? all<{ run_id: string }>(
            `select run_id from ${runs} where ${OPEN}`
          ).map((row) => row.run_id)
        : [],
    insert: (runId, { input, startedAt, terminalOnly }) => {
      ensure();
      run(
        `insert into ${runs}
          (run_id, status, input_json, started_at, event_delivery)
         values (?, 'running', ?, ?, ?)`,
        runId,
        toJson(input),
        startedAt,
        terminalOnly ? "terminal" : null
      );
    },
    bindRequest: (runId, requestId) => {
      ensure();
      run(
        `update ${runs}
         set request_id = ?, root_request_id = coalesce(root_request_id, ?)
         where run_id = ?`,
        requestId,
        requestId,
        runId
      );
    },
    recordStreamError: (runId, error) => {
      ensure();
      run(
        `update ${runs} set error_message = ? where run_id = ?`,
        error,
        runId
      );
    },
    writeTerminal: (runId, terminal, turn) => {
      ensure();
      if (turn) {
        run(
          `update ${runs} set request_id = ?, stream_id = ? where run_id = ?`,
          turn.requestId,
          turn.streamId,
          runId
        );
      }
      if (terminal.status === "completed") {
        run(
          `update ${runs}
           set status = 'completed', output_json = ?, summary = ?,
               error_message = null, completed_at = ?
           where run_id = ?`,
          toJson(terminal.output),
          terminal.summary,
          Date.now(),
          runId
        );
      } else {
        run(
          `update ${runs}
           set status = ?, error_message = ?, completed_at = ?
           where run_id = ?`,
          terminal.status,
          terminal.error,
          Date.now(),
          runId
        );
      }
    },
    writeProgress: (runId, snapshot, at) => {
      ensure();
      run(
        `update ${runs} set progress_json = ?, last_signal_at = ?
         where run_id = ?`,
        JSON.stringify(snapshot),
        at,
        runId
      );
    },
    addMilestone: (runId, name, data, at) => {
      ensure();
      const sequence =
        all<{ next: number }>(
          `select coalesce(max(sequence), -1) + 1 as next
           from ${milestones} where run_id = ?`,
          runId
        )[0]?.next ?? 0;
      run(
        `insert or ignore into ${milestones}
          (run_id, sequence, name, data_json, at)
         values (?, ?, ?, ?, ?)`,
        runId,
        sequence,
        name,
        toJson(data),
        at
      );
      // A milestone is a progress signal too: advance the no-progress clock.
      run(`update ${runs} set last_signal_at = ? where run_id = ?`, at, runId);
      return sequence;
    },
    milestones: (runId) => {
      ensure();
      return all<{
        sequence: number;
        name: string;
        data_json: string | null;
        at: number;
      }>(
        `select sequence, name, data_json, at from ${milestones}
         where run_id = ? order by sequence asc`,
        runId
      ).map((row) => ({
        name: row.name,
        sequence: row.sequence,
        at: row.at,
        ...(row.data_json !== null ? { data: fromJson(row.data_json) } : {})
      }));
    }
  };
}
