/**
 * CodemodeRuntime — durable execution engine, implemented as a DurableObject
 * facet of the agent.
 *
 * The Executor is a simple, stateless sandbox: it runs code once and dispatches
 * tool calls back. The Runtime wraps an executor and makes execution durable via
 * abort-and-replay:
 *
 *   - Every tool call AND every `codemode.step(name, fn)` is recorded in a
 *     durable log (the replay spine).
 *   - Reads / steps execute and their result is recorded.
 *   - Actions requiring approval are recorded as pending, and the run aborts.
 *   - On `continue`, the same code re-runs. Calls already in the log are served
 *     from it (noop — reads/steps return recorded results, applied
 *     actions return theirs). The newly-approved action executes for real, then
 *     the run proceeds to the next pause or completion.
 *
 * `codemode.step(name, fn)` is the explicit side-effect boundary: any
 * nondeterministic or side-effectful work wrapped in a step is recorded once
 * and replayed thereafter, so replay correctness does not depend on the code
 * being incidentally deterministic.
 *
 * ## Statelessness (concurrency + hibernation safety)
 *
 * The facet keeps **no per-run state in instance memory**. Every method that
 * participates in a run is addressed by an explicit `executionId` and, where
 * relevant, a `seq` allocated by the host (the proxy tool) — never an in-memory
 * cursor. This means:
 *
 *   - Two executions can run concurrently without clobbering each other (each
 *     run threads its own id + sequence; there is no shared "current cursor").
 *   - The facet may hibernate mid-run between tool calls without losing its
 *     place: the sequence lives on the host call stack and the log lives in
 *     durable storage.
 *
 * The only durable state is per-execution: the log, pending actions, result,
 * snippets. The executor and connector stubs are transient — the proxy tool
 * re-provides them on each message (they can't survive hibernation anyway).
 *
 * ## Storage layout
 *
 * The facet's own SQLite database (facets each get an isolated DB) holds three
 * tables: `cm_executions` (one row per execution: code, status, final result),
 * `cm_log` (one row per connector call / step — appends write one small row
 * instead of rewriting the whole execution), and `cm_snippets`. Args/results
 * are serialized with the storage codec (binary + bigint safe). Any single
 * serialized value is capped at `MAX_DURABLE_VALUE_BYTES`: a durable log can't
 * truncate values (replay would feed resumed code corrupted data), so an
 * oversized value fails the run with a clear, model-actionable error instead.
 */
import { DurableObject } from "cloudflare:workers";
import { stringifyForStorage, parseForStorage } from "./codec";
import type { Snippet, SaveSnippetOptions } from "./snippet";

// ---------------------------------------------------------------------------
// Durable types
// ---------------------------------------------------------------------------

export type ToolLogEntryState =
  | "executing" // decided to execute; result not yet recorded (crash window)
  | "applied" // executed for real, result recorded
  | "pending" // awaiting approval — the run aborted here
  | "reverted" // rolled back
  | "error"; // failed the run (e.g. unrecordable result); side effects may have run

/** Connector name used for `codemode.step(name, fn)` log entries. */
export const STEP_CONNECTOR = "__step";

export type ToolLogEntry = {
  seq: number;
  connector: string;
  method: string;
  args: unknown;
  /** Recorded result for replay. Present once applied (never for ephemeral). */
  result?: unknown;
  /** Whether this call required approval (vs. a read or step). */
  requiresApproval: boolean;
  /**
   * Ephemeral entries (`replay: "reexecute"` tools) re-execute on replay
   * instead of replaying a recorded result; their result is never stored.
   */
  ephemeral?: boolean;
  state: ToolLogEntryState;
};

export type ExecutionStatus =
  | "running"
  | "paused"
  | "completed"
  | "error"
  | "rejected"
  | "rolled_back";

export type ExecutionState = {
  id: string;
  code: string;
  status: ExecutionStatus;
  log: ToolLogEntry[];
  result?: unknown;
  error?: string;
  logs?: string[];
  /**
   * Connector names the execution was started with. Recorded so a later
   * resume can verify the required connectors are still configured.
   */
  connectors?: string[];
  /** Epoch ms the execution was created. */
  createdAt: number;
  /** Epoch ms of the last state change. */
  updatedAt: number;
};

export type PendingAction = {
  executionId: string;
  seq: number;
  connector: string;
  method: string;
  args: unknown;
};

/**
 * The decision the runtime returns for a single tool call or step during a run.
 *   - "replay": return `result` without executing
 *   - "execute": execute, then report the result back via `recordResult`
 *   - "pause": stop the run (the binding throws the pause sentinel)
 */
export type ToolDecision =
  | { kind: "replay"; result: unknown }
  | { kind: "execute"; seq: number }
  // "pause" tells the host to abort the sandbox run. The reason lives on the
  // execution: status "paused" (awaiting approval) or "error" (replay
  // divergence). Routing divergence through the execution record rather than a
  // thrown sandbox error keeps it out of the cross-worker rejection path.
  | { kind: "pause"; seq: number };

export type BeginOptions = {
  /** Terminal executions retained per runtime. Defaults to 50. */
  maxExecutions?: number;
  /** Connector names configured on the runtime starting this execution. */
  connectors?: string[];
};

/** Default number of terminal executions to retain per runtime. */
export const DEFAULT_MAX_EXECUTIONS = 50;

/**
 * Cap for any single serialized value stored in the durable log (args, a
 * recorded result, the final result). SQLite rows in Durable Objects max out
 * at ~2MB; 1MB leaves headroom for the rest of the row. Truncating stored
 * values is never an option — replay would feed resumed code corrupted data —
 * so a breach fails the run with a model-actionable error instead.
 */
export const MAX_DURABLE_VALUE_BYTES = 1_000_000;

/** Default age after which a paused (awaiting-approval) run can be expired. */
export const DEFAULT_PAUSED_TTL_MS = 24 * 60 * 60 * 1000;

/** Model-actionable error for a value too large to record durably. */
export function tooLargeMessage(what: string, size: number): string {
  return (
    `${what} is too large to record durably (${size} bytes > ` +
    `${MAX_DURABLE_VALUE_BYTES} byte limit). Write large data to a file or ` +
    `workspace instead and pass/return a small reference (such as a path).`
  );
}

/** Pending actions (awaiting approval) of one execution. */
function pendingOf(state: ExecutionState): PendingAction[] {
  return state.log
    .filter((e) => e.state === "pending")
    .map((e) => ({
      executionId: state.id,
      seq: e.seq,
      connector: e.connector,
      method: e.method,
      args: e.args
    }));
}

// ---------------------------------------------------------------------------
// Stable serialization for replay-divergence comparison of args.
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON of a value: object keys sorted recursively, BigInt tagged.
 * Used to compare a replayed call's args against the recorded args. Best-effort
 * — returns `undefined` if the value can't be serialized (e.g. a cycle), in
 * which case the caller skips the args check rather than reporting a false
 * divergence.
 */
export function stableStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return `__bigint__:${val.toString()}`;
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const record = val as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(record).sort()) sorted[key] = record[key];
        return sorted;
      }
      return val;
    });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type ExecutionRow = {
  id: string;
  code: string;
  status: string;
  result: string | null;
  error: string | null;
  logs: string | null;
  connectors: string | null;
  created_at: number;
  updated_at: number;
};

type LogRow = {
  execution_id: string;
  seq: number;
  connector: string;
  method: string;
  args: string | null;
  result: string | null;
  requires_approval: number;
  ephemeral: number;
  state: string;
};

type SnippetRow = {
  name: string;
  description: string;
  code: string;
  saved_at: number;
  input_schema: string | null;
  connectors: string | null;
};

function rowToEntry(row: LogRow): ToolLogEntry {
  return {
    seq: row.seq,
    connector: row.connector,
    method: row.method,
    args: parseForStorage(row.args),
    result: parseForStorage(row.result),
    requiresApproval: row.requires_approval === 1,
    ephemeral: row.ephemeral === 1 ? true : undefined,
    state: row.state as ToolLogEntryState
  };
}

function rowToSnippet(row: SnippetRow): Snippet {
  return {
    name: row.name,
    description: row.description,
    code: row.code,
    savedAt: row.saved_at,
    inputSchema: parseForStorage(row.input_schema),
    connectors: row.connectors
      ? (JSON.parse(row.connectors) as string[])
      : undefined
  };
}

/**
 * Serialize a value for a durable column. `undefined` → SQL NULL; throws a
 * model-actionable error when the value is too large or not serializable
 * (e.g. cyclic) — the durable log can't store an approximation.
 */
function toStored(what: string, value: unknown): string | null {
  let stored: string | undefined;
  try {
    stored = stringifyForStorage(value);
  } catch (err) {
    throw new Error(
      `${what} could not be recorded durably (not serializable: ` +
        `${err instanceof Error ? err.message : String(err)}). Only ` +
        `JSON-compatible values (plus binary and bigint) can cross a ` +
        `durable replay boundary.`
    );
  }
  if (stored === undefined) return null;
  if (stored.length > MAX_DURABLE_VALUE_BYTES) {
    throw new Error(tooLargeMessage(what, stored.length));
  }
  return stored;
}

// ---------------------------------------------------------------------------
// CodemodeRuntime facet
// ---------------------------------------------------------------------------

export class CodemodeRuntime extends DurableObject<unknown> {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cm_executions (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        logs TEXT,
        connectors TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cm_executions_status
        ON cm_executions (status, created_at);
      CREATE TABLE IF NOT EXISTS cm_log (
        execution_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        connector TEXT NOT NULL,
        method TEXT NOT NULL,
        args TEXT,
        result TEXT,
        requires_approval INTEGER NOT NULL DEFAULT 0,
        ephemeral INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        PRIMARY KEY (execution_id, seq)
      );
      CREATE TABLE IF NOT EXISTS cm_snippets (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        code TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        input_schema TEXT,
        connectors TEXT
      );
    `);
  }

  // -----------------------------------------------------------------------
  // Run lifecycle
  //
  // Every method targets an explicit `executionId`. There is deliberately no
  // "current execution" pointer: it would be a single shared slot that the
  // most recent run wins, which is racy the moment two runs are in flight.
  // The host (proxy tool) holds the id for the run it is driving, and approval
  // UIs get ids from `listPending()` / `listExecutions()`.
  // -----------------------------------------------------------------------

  /**
   * Begin a fresh execution. Returns the execution id. Prunes old terminal
   * executions down to `maxExecutions` (newest kept). The connector names the
   * runtime was created with are recorded on the execution so a later resume
   * can verify they are still configured.
   */
  async begin(code: string, options?: BeginOptions): Promise<string> {
    if (code.length > MAX_DURABLE_VALUE_BYTES) {
      throw new Error(tooLargeMessage("The execution code", code.length));
    }
    const now = Date.now();
    const id = `exec_${now.toString().padStart(16, "0")}_${crypto.randomUUID()}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO cm_executions
        (id, code, status, connectors, created_at, updated_at)
        VALUES (?, ?, 'running', ?, ?, ?)`,
      id,
      code,
      options?.connectors ? JSON.stringify(options.connectors) : null,
      now,
      now
    );
    this.#pruneTerminal(options?.maxExecutions ?? DEFAULT_MAX_EXECUTIONS, id);
    return id;
  }

  /**
   * Resume an execution for a replay run. Only a `paused` run can be resumed:
   * reviving a terminal run (completed/error/rejected/rolled_back) would
   * re-offer a rejected action for approval or re-apply rolled-back side
   * effects, and restarting an already-`running` run would race. Returns `null`
   * (no state change) when the run is missing or not paused — the caller turns
   * that into a clear error.
   */
  async resume(id: string): Promise<ExecutionState | null> {
    const row = this.#executionRow(id);
    if (!row || row.status !== "paused") return null;
    this.ctx.storage.sql.exec(
      `UPDATE cm_executions SET status = 'running', updated_at = ? WHERE id = ?`,
      Date.now(),
      id
    );
    return this.#get(id);
  }

  /**
   * Decide what to do with the next tool call or step. The host allocates and
   * passes `seq` (not an in-memory cursor), so this is safe across hibernation
   * and concurrent executions.
   *
   * If the execution is no longer "running" (already paused/terminal), every
   * call gets a pause decision and nothing is recorded — so model code that
   * swallows the pause sentinel can't drive further side effects.
   *
   * Replay: a log entry at `seq` must match connector + method + args
   * (divergence is a hard error). Applied → replay its result (ephemeral
   * entries re-execute instead). Pending → it was just approved, execute it.
   * Executing (crashed mid-call) / reverted → treat as a fresh call.
   *
   * New call: step or read → execute (logged "executing" until recordResult).
   * Approval-required → record pending, pause.
   */
  async decide(
    executionId: string,
    seq: number,
    connector: string,
    method: string,
    args: unknown,
    requiresApproval: boolean,
    ephemeral = false
  ): Promise<ToolDecision> {
    const row = this.#requireRow(executionId);

    // Once a run has paused (awaiting approval) or terminated (divergence,
    // rejection), refuse to make any further progress: every subsequent
    // call/step gets a pause decision and nothing new is recorded. The pause
    // sentinel is a throwable Error, so model code *could* catch it and keep
    // going — this guard makes that harmless (no further side effects, no log
    // growth past the pause) rather than relying on the throw escaping.
    if (row.status !== "running") {
      return { kind: "pause", seq };
    }

    const existingRow = this.#logRow(executionId, seq);
    const existing = existingRow ? rowToEntry(existingRow) : undefined;

    if (existing) {
      if (existing.connector !== connector || existing.method !== method) {
        return this.#diverge(
          executionId,
          seq,
          `expected ${existing.connector}.${existing.method}, got ` +
            `${connector}.${method}. Code must be deterministic up to tool ` +
            `calls and steps. Wrap nondeterministic work in codemode.step(name, fn).`
        );
      }
      const before = stableStringify(existing.args);
      const after = stableStringify(args);
      if (before !== undefined && after !== undefined && before !== after) {
        return this.#diverge(
          executionId,
          seq,
          `${connector}.${method} was called with different arguments than the ` +
            `recorded run. Arguments must be deterministic across replays. Wrap ` +
            `nondeterministic inputs in codemode.step(name, fn).`
        );
      }
      if (existing.state === "applied") {
        // Ephemeral entries store no result — they re-execute on replay.
        // Result divergence is harmless (divergence detection compares
        // connector/method/args only), but the value may legitimately have
        // changed underneath (e.g. a file edited between pause and resume).
        if (existing.ephemeral) {
          return { kind: "execute", seq };
        }
        return { kind: "replay", result: existing.result };
      }
      if (existing.state === "pending") {
        // Approved since the last run. Transition pending → executing and
        // persist BEFORE returning, so a concurrent reject() (e.g. a second UI
        // tab) sees "executing" and no-ops instead of reverting an action that
        // is already running on the host. Without this write the entry would
        // stay "pending" for the whole execution window — symmetric with the
        // fresh-call path below.
        this.#setEntryState(executionId, seq, "executing");
        this.#touch(executionId);
        return { kind: "execute", seq };
      }
      if (existing.state === "executing") {
        // Decided to run on a previous pass but crashed before recordResult
        // landed — re-execute. Do NOT re-pause even for an approval action: it
        // was already approved when it first reached "executing".
        return { kind: "execute", seq };
      }
      // "reverted" — fall through and re-execute as a fresh call.
    }

    // Fresh call (or a "reverted" entry being re-run as a fresh call).
    let storedArgs: string | null;
    try {
      storedArgs = toStored(`Arguments to ${connector}.${method}`, args);
    } catch (err) {
      // Args that can't live in the durable log (too large / unserializable)
      // are a terminal failure with a model-actionable message — recording an
      // approximation would corrupt replay.
      return this.#fail(
        executionId,
        seq,
        err instanceof Error ? err.message : String(err)
      );
    }

    const state: ToolLogEntryState = requiresApproval ? "pending" : "executing";
    // "REPLACE" covers the reverted-entry re-run; a plain fresh call inserts.
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cm_log
        (execution_id, seq, connector, method, args, result,
         requires_approval, ephemeral, state)
        VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      executionId,
      seq,
      connector,
      method,
      storedArgs,
      requiresApproval ? 1 : 0,
      ephemeral ? 1 : 0,
      state
    );

    if (requiresApproval) {
      this.ctx.storage.sql.exec(
        `UPDATE cm_executions SET status = 'paused', updated_at = ? WHERE id = ?`,
        Date.now(),
        executionId
      );
      return { kind: "pause", seq };
    }
    this.#touch(executionId);
    return { kind: "execute", seq };
  }

  /**
   * Record the real result of an executed call or step. Ephemeral entries are
   * marked applied but their result is never stored (they re-execute on
   * replay).
   *
   * A non-ephemeral result that is too large / unserializable cannot live in
   * the durable log (truncating it would corrupt replay), so the execution is
   * marked failed with a model-actionable error — recorded on the execution
   * rather than thrown, because a rejection across the facet RPC boundary
   * would surface as an unhandled rejection on the host. The entry stays
   * "executing" (its side effects already happened) and the run can make no
   * further progress.
   */
  async recordResult(
    executionId: string,
    seq: number,
    result: unknown
  ): Promise<void> {
    const row = this.#logRow(executionId, seq);
    if (!row) throw new Error(`No log entry at step ${seq}`);
    let stored: string | null;
    try {
      stored =
        row.ephemeral === 1
          ? null
          : toStored(`The result of ${row.connector}.${row.method}`, result);
    } catch (err) {
      this.#fail(
        executionId,
        seq,
        err instanceof Error ? err.message : String(err)
      );
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE cm_log SET result = ?, state = 'applied'
        WHERE execution_id = ? AND seq = ?`,
      stored,
      executionId,
      seq
    );
    this.#touch(executionId);
  }

  /**
   * Mark the run completed with a final result. Replay never needs the final
   * result (a resume re-derives it), so an oversized/unserializable result is
   * replaced with a placeholder note in the audit trail rather than failing a
   * run that genuinely completed.
   */
  async complete(
    executionId: string,
    result: unknown,
    logs?: string[]
  ): Promise<void> {
    this.#requireRow(executionId);
    let storedResult: string | null;
    try {
      storedResult = toStored("The final result", result);
    } catch (err) {
      storedResult = stringifyForStorage(
        `[codemode: result omitted from the audit trail — ` +
          `${err instanceof Error ? err.message : String(err)}]`
      ) as string;
    }
    this.ctx.storage.sql.exec(
      `UPDATE cm_executions
        SET status = 'completed', result = ?, logs = ?, updated_at = ?
        WHERE id = ?`,
      storedResult,
      this.#storedLogs(logs),
      Date.now(),
      executionId
    );
  }

  /** Mark the run errored. */
  async fail(
    executionId: string,
    error: string,
    logs?: string[]
  ): Promise<void> {
    this.#requireRow(executionId);
    this.ctx.storage.sql.exec(
      `UPDATE cm_executions
        SET status = 'error', error = ?, logs = ?, updated_at = ?
        WHERE id = ?`,
      error.slice(0, MAX_DURABLE_VALUE_BYTES),
      this.#storedLogs(logs),
      Date.now(),
      executionId
    );
  }

  // -----------------------------------------------------------------------
  // Approvals
  // -----------------------------------------------------------------------

  /**
   * List pending actions awaiting approval. With an `executionId`, scopes to
   * that run; without one, aggregates across every **paused** run (newest
   * first) — so an approval UI sees every awaiting-approval run, not just
   * whichever happened to be started/resumed last. (Defaulting to a single
   * "current" run would drop pending actions when multiple runs are in flight.)
   *
   * Only **paused** runs are considered: a non-paused run can retain a stale
   * "pending" log entry (e.g. a resume diverged before reaching it, ending the
   * run as `error` while the later entry stays `pending`). Such an entry isn't
   * actionable — approving it is a no-op — so it must not clutter the queue.
   */
  async listPending(executionId?: string): Promise<PendingAction[]> {
    if (executionId) {
      const state = await this.#get(executionId);
      return state?.status === "paused" ? pendingOf(state) : [];
    }
    const paused = this.ctx.storage.sql
      .exec<ExecutionRow>(
        `SELECT * FROM cm_executions WHERE status = 'paused'
          ORDER BY created_at DESC, id DESC`
      )
      .toArray();
    const out: PendingAction[] = [];
    for (const row of paused) {
      out.push(...pendingOf(this.#assemble(row)));
    }
    return out;
  }

  /**
   * Reject a pending action. Ends the execution with an error.
   *
   * Returns whether it actually terminated the run: `false` when the seq isn't
   * pending (a stale/duplicate reject — e.g. the action was already handled by
   * another tab), so the caller doesn't tear down a run that's still live.
   *
   * Rejection does NOT undo actions already applied earlier in the same run —
   * call `rollback()` for that. See docs/codemode/approvals.md.
   */
  async reject(seq: number, executionId: string): Promise<boolean> {
    const entry = this.#logRow(executionId, seq);
    if (entry?.state !== "pending") return false;
    this.#setEntryState(executionId, seq, "reverted");
    this.ctx.storage.sql.exec(
      `UPDATE cm_executions SET status = 'rejected', error = ?, updated_at = ?
        WHERE id = ?`,
      `Action ${entry.connector}.${entry.method} rejected by user`,
      Date.now(),
      executionId
    );
    return true;
  }

  /**
   * Expire non-terminal runs whose last state change is older than
   * `maxAgeMs`:
   *
   * - `paused` (awaiting approval) runs are marked **rejected**. A
   *   never-answered approval would otherwise live forever — paused runs are
   *   deliberately exempt from retention pruning.
   * - `running` runs are marked **error**. A run only stays `running` with a
   *   stale `updated_at` when the host died mid-pass (every decide/record
   *   touches the row), and such a run can never be resumed — without expiry
   *   it would be unreclaimable and exempt from pruning forever.
   *
   * Returns the expired execution ids so the host can fire the connectors'
   * `disposeExecution` for each. Each status flip is conditional on the
   * status it observed, so an id is only returned (and disposed) when this
   * call actually terminated the run.
   */
  async expirePaused(maxAgeMs = DEFAULT_PAUSED_TTL_MS): Promise<string[]> {
    const cutoff = Date.now() - maxAgeMs;
    const rows = this.ctx.storage.sql
      .exec<{ id: string; status: string }>(
        `SELECT id, status FROM cm_executions
          WHERE status IN ('paused', 'running') AND updated_at < ?`,
        cutoff
      )
      .toArray();
    const now = Date.now();
    const expired: string[] = [];
    for (const { id, status } of rows) {
      const updated = this.ctx.storage.sql.exec(
        `UPDATE cm_executions SET status = ?, error = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
        status === "paused" ? "rejected" : "error",
        status === "paused"
          ? "Expired awaiting approval"
          : "Expired while running — the host never completed the pass",
        now,
        id,
        status
      );
      if (updated.rowsWritten === 0) continue;
      this.ctx.storage.sql.exec(
        `UPDATE cm_log SET state = 'reverted'
          WHERE execution_id = ? AND state = 'pending'`,
        id
      );
      expired.push(id);
    }
    return expired;
  }

  // -----------------------------------------------------------------------
  // Rollback — walk the log backward; the proxy tool calls revertAction.
  // -----------------------------------------------------------------------

  /**
   * Return applied connector actions (not steps) in reverse order. Reads are
   * included but are harmless — the host's revertAction no-ops when a tool has
   * no `revert`, and only entries that actually reverted are marked.
   */
  async actionsToRevert(executionId: string): Promise<ToolLogEntry[]> {
    return this.ctx.storage.sql
      .exec<LogRow>(
        `SELECT * FROM cm_log
          WHERE execution_id = ? AND state = 'applied' AND connector != ?
          ORDER BY seq DESC`,
        executionId,
        STEP_CONNECTOR
      )
      .toArray()
      .map(rowToEntry);
  }

  /** Mark an action reverted after the proxy tool has reverted it. */
  async markReverted(seq: number, executionId: string): Promise<void> {
    if (!this.#logRow(executionId, seq)) return;
    this.#setEntryState(executionId, seq, "reverted");
    this.#touch(executionId);
  }

  /**
   * Mark a run as rolled back once the proxy tool has finished reverting its
   * actions, so the execution status reflects the rollback (rather than staying
   * "completed"/"error" with some entries quietly flipped to "reverted").
   */
  async markRolledBack(executionId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE cm_executions SET status = 'rolled_back', updated_at = ?
        WHERE id = ?`,
      Date.now(),
      executionId
    );
  }

  // -----------------------------------------------------------------------
  // Inspection + retention
  // -----------------------------------------------------------------------

  async getExecution(id: string): Promise<ExecutionState | null> {
    return this.#get(id);
  }

  /** List executions, newest first. Optionally cap the number returned. */
  async listExecutions(limit?: number): Promise<ExecutionState[]> {
    const rows = this.ctx.storage.sql
      .exec<ExecutionRow>(
        `SELECT * FROM cm_executions ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        typeof limit === "number" ? limit : -1
      )
      .toArray();
    return rows.map((row) => this.#assemble(row));
  }

  /** Delete one execution. Returns whether it existed. */
  async deleteExecution(id: string): Promise<boolean> {
    const existed = this.#executionRow(id) !== null;
    this.ctx.storage.sql.exec(`DELETE FROM cm_log WHERE execution_id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM cm_executions WHERE id = ?`, id);
    return existed;
  }

  /**
   * Delete terminal (completed/error) executions, keeping the newest `keep`.
   * Running/paused executions are never deleted. Returns the count removed.
   */
  async pruneExecutions(keep = DEFAULT_MAX_EXECUTIONS): Promise<number> {
    return this.#pruneTerminal(keep);
  }

  // -----------------------------------------------------------------------
  // Snippets — durable, addressable saved scripts
  // -----------------------------------------------------------------------

  /**
   * Promote an execution's code to a saved, addressable snippet. This is the
   * "save what ran" hook — the developer calls it (via runtime.saveSnippet)
   * after a script proves useful, so the model can re-run it later with
   * `codemode.run(name)`. The execution is named explicitly (its id comes from
   * the tool's output or `listExecutions()`). The execution's recorded
   * connector requirements carry over to the snippet so a later run can verify
   * they are still configured.
   */
  async saveSnippet(
    name: string,
    options: SaveSnippetOptions
  ): Promise<Snippet> {
    const row = this.#executionRow(options.executionId);
    if (!row) {
      throw new Error(`No execution "${options.executionId}" to save from`);
    }
    const snippet: Snippet = {
      name,
      description: options.description ?? "",
      code: row.code,
      savedAt: Date.now(),
      inputSchema: options.inputSchema,
      connectors: row.connectors
        ? (JSON.parse(row.connectors) as string[])
        : undefined
    };
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO cm_snippets
        (name, description, code, saved_at, input_schema, connectors)
        VALUES (?, ?, ?, ?, ?, ?)`,
      snippet.name,
      snippet.description,
      snippet.code,
      snippet.savedAt,
      // Snippet code is implicitly bounded (it is an execution's code, which
      // `begin` caps); the schema is the only unbounded input here.
      toStored("The snippet input schema", snippet.inputSchema),
      row.connectors
    );
    return snippet;
  }

  async getSnippet(name: string): Promise<Snippet | null> {
    const rows = this.ctx.storage.sql
      .exec<SnippetRow>(`SELECT * FROM cm_snippets WHERE name = ?`, name)
      .toArray();
    return rows.length > 0 ? rowToSnippet(rows[0]) : null;
  }

  async listSnippets(): Promise<Snippet[]> {
    return this.ctx.storage.sql
      .exec<SnippetRow>(`SELECT * FROM cm_snippets ORDER BY name`)
      .toArray()
      .map(rowToSnippet);
  }

  async deleteSnippet(name: string): Promise<boolean> {
    const existed =
      this.ctx.storage.sql
        .exec(`SELECT 1 FROM cm_snippets WHERE name = ?`, name)
        .toArray().length > 0;
    this.ctx.storage.sql.exec(`DELETE FROM cm_snippets WHERE name = ?`, name);
    return existed;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Record a replay divergence (or another in-run failure) as a terminal
   * failure on the execution and tell the host to abort the sandbox. The host
   * reads the failure from the execution record, so the message never travels
   * back through the sandbox's error channel (which would flag it as an
   * unhandled remote rejection).
   */
  #diverge(executionId: string, seq: number, detail: string): ToolDecision {
    return this.#fail(
      executionId,
      seq,
      `Codemode replay divergence at step ${seq}: ${detail}`
    );
  }

  #fail(executionId: string, seq: number, error: string): ToolDecision {
    // Mark the triggering log entry too (when one exists): an entry left
    // "executing"/"pending" under an errored execution misreads as a crash
    // window in the audit trail. Side effects may already have run, which is
    // exactly what the "error" state records.
    this.ctx.storage.sql.exec(
      `UPDATE cm_log SET state = 'error'
        WHERE execution_id = ? AND seq = ? AND state IN ('executing', 'pending')`,
      executionId,
      seq
    );
    this.ctx.storage.sql.exec(
      `UPDATE cm_executions SET status = 'error', error = ?, updated_at = ?
        WHERE id = ?`,
      error.slice(0, MAX_DURABLE_VALUE_BYTES),
      Date.now(),
      executionId
    );
    return { kind: "pause", seq };
  }

  #pruneTerminal(keep: number, protectId?: string): number {
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>(
        `SELECT id FROM cm_executions
          WHERE status IN ('completed', 'error', 'rejected', 'rolled_back')
            AND id != ?
          ORDER BY created_at DESC, id DESC`,
        protectId ?? ""
      )
      .toArray();
    if (rows.length <= keep) return 0;
    const toDelete = rows.slice(keep);
    for (const { id } of toDelete) {
      this.ctx.storage.sql.exec(
        `DELETE FROM cm_log WHERE execution_id = ?`,
        id
      );
      this.ctx.storage.sql.exec(`DELETE FROM cm_executions WHERE id = ?`, id);
    }
    return toDelete.length;
  }

  /** Serialize console logs; an oversized log array is truncated with a note. */
  #storedLogs(logs?: string[]): string | null {
    if (!logs || logs.length === 0) return null;
    let stored = JSON.stringify(logs);
    let entries = logs;
    while (stored.length > MAX_DURABLE_VALUE_BYTES && entries.length > 0) {
      entries = [
        "[codemode: earlier console output dropped — too large to record]",
        ...entries.slice(Math.ceil(entries.length / 2))
      ];
      stored = JSON.stringify(entries);
    }
    return stored.length <= MAX_DURABLE_VALUE_BYTES ? stored : null;
  }

  #executionRow(id: string): ExecutionRow | null {
    const rows = this.ctx.storage.sql
      .exec<ExecutionRow>(`SELECT * FROM cm_executions WHERE id = ?`, id)
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  #requireRow(id: string): ExecutionRow {
    const row = this.#executionRow(id);
    if (!row) throw new Error(`No execution "${id}"`);
    return row;
  }

  #logRow(executionId: string, seq: number): LogRow | null {
    const rows = this.ctx.storage.sql
      .exec<LogRow>(
        `SELECT * FROM cm_log WHERE execution_id = ? AND seq = ?`,
        executionId,
        seq
      )
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  #setEntryState(
    executionId: string,
    seq: number,
    state: ToolLogEntryState
  ): void {
    this.ctx.storage.sql.exec(
      `UPDATE cm_log SET state = ? WHERE execution_id = ? AND seq = ?`,
      state,
      executionId,
      seq
    );
  }

  #touch(executionId: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE cm_executions SET updated_at = ? WHERE id = ?`,
      Date.now(),
      executionId
    );
  }

  #assemble(row: ExecutionRow): ExecutionState {
    const entries = this.ctx.storage.sql
      .exec<LogRow>(
        `SELECT * FROM cm_log WHERE execution_id = ? ORDER BY seq`,
        row.id
      )
      .toArray()
      .map(rowToEntry);
    const log: ToolLogEntry[] = [];
    for (const entry of entries) log[entry.seq] = entry;
    return {
      id: row.id,
      code: row.code,
      status: row.status as ExecutionStatus,
      log,
      result: parseForStorage(row.result),
      error: row.error ?? undefined,
      logs: row.logs ? (JSON.parse(row.logs) as string[]) : undefined,
      connectors: row.connectors
        ? (JSON.parse(row.connectors) as string[])
        : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  async #get(id: string): Promise<ExecutionState | null> {
    const row = this.#executionRow(id);
    return row ? this.#assemble(row) : null;
  }
}
