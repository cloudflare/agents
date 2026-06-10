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
 */
import { DurableObject } from "cloudflare:workers";
import type { Snippet, SaveSnippetOptions } from "./snippet";

// ---------------------------------------------------------------------------
// Durable types
// ---------------------------------------------------------------------------

export type ToolLogEntryState =
  | "executing" // decided to execute; result not yet recorded (crash window)
  | "applied" // executed for real, result recorded
  | "pending" // awaiting approval — the run aborted here
  | "reverted"; // rolled back

/** Connector name used for `codemode.step(name, fn)` log entries. */
export const STEP_CONNECTOR = "__step";

export type ToolLogEntry = {
  seq: number;
  connector: string;
  method: string;
  args: unknown;
  /** Recorded result for replay. Present once applied. */
  result?: unknown;
  /** Whether this call required approval (vs. a read or step). */
  requiresApproval: boolean;
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

/** Default number of terminal executions to retain per runtime. */
export const DEFAULT_MAX_EXECUTIONS = 50;

/** Terminal statuses are eligible for retention pruning. */
function isTerminal(status: ExecutionStatus): boolean {
  return (
    status === "completed" ||
    status === "error" ||
    status === "rejected" ||
    status === "rolled_back"
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
// CodemodeRuntime facet
// ---------------------------------------------------------------------------

const execKey = (id: string) => `execution:${id}`;
const snippetKey = (name: string) => `snippet:${name}`;

export class CodemodeRuntime extends DurableObject {
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
   * executions down to `maxExecutions` (newest kept).
   */
  async begin(
    code: string,
    maxExecutions = DEFAULT_MAX_EXECUTIONS
  ): Promise<string> {
    const now = Date.now();
    const id = `exec_${now.toString().padStart(16, "0")}_${crypto.randomUUID()}`;
    const state: ExecutionState = {
      id,
      code,
      status: "running",
      log: [],
      createdAt: now,
      updatedAt: now
    };
    await this.ctx.storage.put(execKey(id), state);
    await this.#pruneTerminal(maxExecutions, id);
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
    const state = await this.#get(id);
    if (!state) return null;
    if (state.status !== "paused") return null;
    state.status = "running";
    state.updatedAt = Date.now();
    await this.ctx.storage.put(execKey(id), state);
    return state;
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
   * (divergence is a hard error). Applied → replay its result. Pending → it was
   * just approved, execute it. Executing (crashed mid-call) / reverted → treat
   * as a fresh call.
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
    requiresApproval: boolean
  ): Promise<ToolDecision> {
    const state = await this.#require(executionId);

    // Once a run has paused (awaiting approval) or terminated (divergence,
    // rejection), refuse to make any further progress: every subsequent
    // call/step gets a pause decision and nothing new is recorded. The pause
    // sentinel is a throwable Error, so model code *could* catch it and keep
    // going — this guard makes that harmless (no further side effects, no log
    // growth past the pause) rather than relying on the throw escaping.
    if (state.status !== "running") {
      return { kind: "pause", seq };
    }

    const existing = state.log[seq];

    if (existing) {
      if (existing.connector !== connector || existing.method !== method) {
        return this.#diverge(
          state,
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
          state,
          seq,
          `${connector}.${method} was called with different arguments than the ` +
            `recorded run. Arguments must be deterministic across replays. Wrap ` +
            `nondeterministic inputs in codemode.step(name, fn).`
        );
      }
      if (existing.state === "applied") {
        return { kind: "replay", result: existing.result };
      }
      if (existing.state === "pending") {
        // Approved since the last run. Transition pending → executing and
        // persist BEFORE returning, so a concurrent reject() (e.g. a second UI
        // tab) sees "executing" and no-ops instead of reverting an action that
        // is already running on the host. Without this write the entry would
        // stay "pending" for the whole execution window — symmetric with the
        // fresh-call path below.
        existing.state = "executing";
        state.updatedAt = Date.now();
        await this.ctx.storage.put(execKey(state.id), state);
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

    const entry: ToolLogEntry = {
      seq,
      connector,
      method,
      args,
      requiresApproval,
      // Approval actions park as "pending". Everything else is "executing"
      // until recordResult lands — NOT "applied", so a crash before the result
      // is recorded re-executes on replay instead of replaying `undefined`.
      state: requiresApproval ? "pending" : "executing"
    };
    state.log[seq] = entry;
    state.updatedAt = Date.now();

    if (requiresApproval) {
      state.status = "paused";
      await this.ctx.storage.put(execKey(state.id), state);
      return { kind: "pause", seq };
    }
    await this.ctx.storage.put(execKey(state.id), state);
    return { kind: "execute", seq };
  }

  /** Record the real result of an executed call or step. */
  async recordResult(
    executionId: string,
    seq: number,
    result: unknown
  ): Promise<void> {
    const state = await this.#require(executionId);
    const entry = state.log[seq];
    if (!entry) throw new Error(`No log entry at step ${seq}`);
    entry.result = result;
    entry.state = "applied";
    state.updatedAt = Date.now();
    await this.ctx.storage.put(execKey(state.id), state);
  }

  /** Mark the run completed with a final result. */
  async complete(
    executionId: string,
    result: unknown,
    logs?: string[]
  ): Promise<void> {
    const state = await this.#require(executionId);
    state.status = "completed";
    state.result = result;
    state.logs = logs;
    state.updatedAt = Date.now();
    await this.ctx.storage.put(execKey(state.id), state);
  }

  /** Mark the run errored. */
  async fail(
    executionId: string,
    error: string,
    logs?: string[]
  ): Promise<void> {
    const state = await this.#require(executionId);
    state.status = "error";
    state.error = error;
    state.logs = logs;
    state.updatedAt = Date.now();
    await this.ctx.storage.put(execKey(state.id), state);
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
    const all = await this.listExecutions();
    return all.filter((e) => e.status === "paused").flatMap(pendingOf);
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
    const state = await this.#get(executionId);
    if (!state) return false;
    const entry = state.log[seq];
    if (entry?.state !== "pending") return false;
    entry.state = "reverted";
    state.status = "rejected";
    state.error = `Action ${entry.connector}.${entry.method} rejected by user`;
    state.updatedAt = Date.now();
    await this.ctx.storage.put(execKey(state.id), state);
    return true;
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
    const state = await this.#get(executionId);
    if (!state) return [];
    return state.log
      .filter((e) => e.state === "applied" && e.connector !== STEP_CONNECTOR)
      .reverse();
  }

  /** Mark an action reverted after the proxy tool has reverted it. */
  async markReverted(seq: number, executionId: string): Promise<void> {
    const state = await this.#get(executionId);
    if (!state) return;
    const entry = state.log[seq];
    if (entry) {
      entry.state = "reverted";
      state.updatedAt = Date.now();
      await this.ctx.storage.put(execKey(state.id), state);
    }
  }

  /**
   * Mark a run as rolled back once the proxy tool has finished reverting its
   * actions, so the execution status reflects the rollback (rather than staying
   * "completed"/"error" with some entries quietly flipped to "reverted").
   */
  async markRolledBack(executionId: string): Promise<void> {
    const state = await this.#get(executionId);
    if (!state) return;
    state.status = "rolled_back";
    state.updatedAt = Date.now();
    await this.ctx.storage.put(execKey(state.id), state);
  }

  // -----------------------------------------------------------------------
  // Inspection + retention
  // -----------------------------------------------------------------------

  async getExecution(id: string): Promise<ExecutionState | null> {
    return this.#get(id);
  }

  /** List executions, newest first. Optionally cap the number returned. */
  async listExecutions(limit?: number): Promise<ExecutionState[]> {
    const map = await this.ctx.storage.list<ExecutionState>({
      prefix: "execution:"
    });
    const executions = [...map.values()];
    executions.sort(
      (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)
    );
    return typeof limit === "number" ? executions.slice(0, limit) : executions;
  }

  /** Delete one execution. Returns whether it existed. */
  async deleteExecution(id: string): Promise<boolean> {
    return this.ctx.storage.delete(execKey(id));
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
   * the tool's output or `listExecutions()`).
   */
  async saveSnippet(
    name: string,
    options: SaveSnippetOptions
  ): Promise<Snippet> {
    const state = await this.#get(options.executionId);
    if (!state) {
      throw new Error(`No execution "${options.executionId}" to save from`);
    }
    const snippet: Snippet = {
      name,
      description: options.description ?? "",
      code: state.code,
      savedAt: Date.now(),
      inputSchema: options.inputSchema
    };
    await this.ctx.storage.put(snippetKey(name), snippet);
    return snippet;
  }

  async getSnippet(name: string): Promise<Snippet | null> {
    return (await this.ctx.storage.get<Snippet>(snippetKey(name))) ?? null;
  }

  async listSnippets(): Promise<Snippet[]> {
    const map = await this.ctx.storage.list<Snippet>({ prefix: "snippet:" });
    return [...map.values()];
  }

  async deleteSnippet(name: string): Promise<boolean> {
    return this.ctx.storage.delete(snippetKey(name));
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Record a replay divergence as a terminal failure on the execution and tell
   * the host to abort the sandbox. The host reads the failure from the
   * execution record, so the divergence text never travels back through the
   * sandbox's error channel (which would flag it as an unhandled remote
   * rejection).
   */
  async #diverge(
    state: ExecutionState,
    seq: number,
    detail: string
  ): Promise<ToolDecision> {
    state.status = "error";
    state.error = `Codemode replay divergence at step ${seq}: ${detail}`;
    state.updatedAt = Date.now();
    await this.ctx.storage.put(execKey(state.id), state);
    return { kind: "pause", seq };
  }

  async #pruneTerminal(keep: number, protectId?: string): Promise<number> {
    const all = await this.listExecutions();
    const terminal = all.filter(
      (e) => isTerminal(e.status) && e.id !== protectId
    );
    if (terminal.length <= keep) return 0;
    // listExecutions is newest-first; drop the oldest beyond `keep`.
    const toDelete = terminal.slice(keep);
    for (const e of toDelete) {
      await this.ctx.storage.delete(execKey(e.id));
    }
    return toDelete.length;
  }

  async #get(id: string): Promise<ExecutionState | null> {
    return (await this.ctx.storage.get<ExecutionState>(execKey(id))) ?? null;
  }

  async #require(id: string): Promise<ExecutionState> {
    const state = await this.#get(id);
    if (!state) throw new Error(`No execution "${id}"`);
    return state;
  }
}
