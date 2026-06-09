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
 *   - Observations / steps execute and their result is recorded.
 *   - Actions requiring approval are recorded as pending, and the run aborts.
 *   - On `continue`, the same code re-runs. Calls already in the log are served
 *     from it (noop — observations/steps return recorded results, applied
 *     actions return theirs). The newly-approved action executes for real, then
 *     the run proceeds to the next pause or completion.
 *
 * `codemode.step(name, fn)` is the explicit side-effect boundary: any
 * nondeterministic or side-effectful work wrapped in a step is recorded once
 * and replayed thereafter, so replay correctness does not depend on the code
 * being incidentally deterministic.
 *
 * Executions are addressable by id, so `fork` can snapshot one into an
 * independent branch (checkpoint / hand-off to a subagent / try alt inputs).
 *
 * The facet owns only durable state: the log, pending actions, scratchpad.
 * The executor and connector stubs are transient — the proxy tool re-provides
 * them on each message (they can't survive hibernation anyway).
 */
import { DurableObject } from "cloudflare:workers";
import type { ToolAnnotations } from "./connectors/types";
import type { Snippet, SaveSnippetOptions } from "./snippet";

// ---------------------------------------------------------------------------
// Durable types
// ---------------------------------------------------------------------------

export type ToolLogEntryState =
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
  /** Whether this call required approval (vs. an observation or step). */
  requiresApproval: boolean;
  description?: string;
  state: ToolLogEntryState;
};

export type ExecutionStatus = "running" | "paused" | "completed" | "error";

export type ExecutionState = {
  id: string;
  /** Set when this execution was forked from another. */
  parentId?: string;
  code: string;
  status: ExecutionStatus;
  log: ToolLogEntry[];
  /** Per-execution scratchpad (codemode.get/set). Forks get an independent copy. */
  scratch: Record<string, unknown>;
  result?: unknown;
  error?: string;
  logs?: string[];
};

export type PendingAction = {
  executionId: string;
  seq: number;
  connector: string;
  method: string;
  args: unknown;
  description?: string;
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
  | { kind: "pause"; seq: number };

// Connector annotations, flattened to "connector.method" → annotation.
export type AnnotationMap = Record<string, ToolAnnotations>;

// ---------------------------------------------------------------------------
// CodemodeRuntime facet
// ---------------------------------------------------------------------------

const CURRENT_KEY = "execution:current";
const execKey = (id: string) => `execution:${id}`;
const snippetKey = (name: string) => `snippet:${name}`;

export class CodemodeRuntime extends DurableObject {
  #annotations: AnnotationMap = {};
  #cursor = 0;

  /**
   * Configure annotations for the active connectors. Called by the proxy tool
   * before each run. Annotations are keyed "connector.method".
   */
  configure(annotations: AnnotationMap): void {
    this.#annotations = annotations;
  }

  // -----------------------------------------------------------------------
  // Run lifecycle
  // -----------------------------------------------------------------------

  /** Begin a fresh execution and make it current. Returns the execution id. */
  async begin(code: string): Promise<string> {
    const id = `exec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const state: ExecutionState = {
      id,
      code,
      status: "running",
      log: [],
      scratch: {}
    };
    this.ctx.storage.put(execKey(id), state);
    this.ctx.storage.put(CURRENT_KEY, id);
    this.#cursor = 0;
    return id;
  }

  /**
   * Resume an execution for a replay run. With no id, resumes the current one.
   * Makes the chosen execution current and resets the replay cursor.
   */
  async resume(id?: string): Promise<ExecutionState | null> {
    const targetId = id ?? (await this.#currentId());
    if (!targetId) return null;
    const state = await this.#get(targetId);
    if (!state) return null;
    state.status = "running";
    this.ctx.storage.put(execKey(targetId), state);
    this.ctx.storage.put(CURRENT_KEY, targetId);
    this.#cursor = 0;
    return state;
  }

  /**
   * Decide what to do with the next tool call or step. Advances the cursor.
   *
   * Replay: a log entry at the cursor must match (divergence is a hard error).
   * Applied → replay its result. Pending → it was just approved, execute it.
   * Reverted → treat as a fresh call.
   *
   * New call: step or observation → execute. Approval-required → record
   * pending, pause.
   */
  async decide(
    connector: string,
    method: string,
    args: unknown
  ): Promise<ToolDecision> {
    const state = await this.#requireCurrent();
    const seq = this.#cursor++;
    const existing = state.log[seq];

    if (existing) {
      if (existing.connector !== connector || existing.method !== method) {
        throw new Error(
          `Codemode replay divergence at step ${seq}: expected ` +
            `${existing.connector}.${existing.method}, got ${connector}.${method}. ` +
            `Code must be deterministic up to tool calls and steps. ` +
            `Wrap nondeterministic work in codemode.step(name, fn).`
        );
      }
      if (existing.state === "applied") {
        return { kind: "replay", result: existing.result };
      }
      if (existing.state === "pending") {
        // Approved since the last run — execute for real now.
        return { kind: "execute", seq };
      }
      // reverted — fall through to treat as a new call
    }

    const annotation = this.#annotations[`${connector}.${method}`];
    const requiresApproval = annotation?.requiresApproval ?? false;

    const entry: ToolLogEntry = {
      seq,
      connector,
      method,
      args,
      requiresApproval,
      description: annotation?.approvalDescription,
      state: requiresApproval ? "pending" : "applied"
    };
    state.log[seq] = entry;

    if (requiresApproval) {
      state.status = "paused";
      this.ctx.storage.put(execKey(state.id), state);
      return { kind: "pause", seq };
    }
    this.ctx.storage.put(execKey(state.id), state);
    return { kind: "execute", seq };
  }

  /** Record the real result of an executed call or step. */
  async recordResult(seq: number, result: unknown): Promise<void> {
    const state = await this.#requireCurrent();
    const entry = state.log[seq];
    if (!entry) throw new Error(`No log entry at step ${seq}`);
    entry.result = result;
    entry.state = "applied";
    this.ctx.storage.put(execKey(state.id), state);
  }

  /** Mark the run completed with a final result. */
  async complete(result: unknown, logs?: string[]): Promise<void> {
    const state = await this.#requireCurrent();
    state.status = "completed";
    state.result = result;
    state.logs = logs;
    this.ctx.storage.put(execKey(state.id), state);
  }

  /** Mark the run errored. */
  async fail(error: string, logs?: string[]): Promise<void> {
    const state = await this.#requireCurrent();
    state.status = "error";
    state.error = error;
    state.logs = logs;
    this.ctx.storage.put(execKey(state.id), state);
  }

  // -----------------------------------------------------------------------
  // Fork — snapshot the current execution into an independent branch
  // -----------------------------------------------------------------------

  /**
   * Clone the current (typically paused) execution into a new execution with a
   * fresh id. The fork inherits the full log and scratchpad but is independent
   * going forward. Does not change which execution is current. Returns the new id.
   */
  async fork(): Promise<string> {
    const state = await this.#requireCurrent();
    const newId = `exec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const clone: ExecutionState = {
      ...state,
      id: newId,
      parentId: state.id,
      // Deep copy log + scratch so the branches don't share references.
      log: state.log.map((e) => ({ ...e })),
      scratch: { ...state.scratch }
    };
    this.ctx.storage.put(execKey(newId), clone);
    return newId;
  }

  // -----------------------------------------------------------------------
  // Approvals
  // -----------------------------------------------------------------------

  /** List pending actions awaiting approval in the current execution. */
  async listPending(): Promise<PendingAction[]> {
    const state = await this.#current();
    if (!state) return [];
    return state.log
      .filter((e) => e.state === "pending")
      .map((e) => ({
        executionId: state.id,
        seq: e.seq,
        connector: e.connector,
        method: e.method,
        args: e.args,
        description: e.description
      }));
  }

  /** Reject a pending action. Ends the execution. */
  async reject(seq: number): Promise<void> {
    const state = await this.#requireCurrent();
    const entry = state.log[seq];
    if (entry?.state === "pending") {
      entry.state = "reverted";
      state.status = "error";
      state.error = `Action ${entry.connector}.${entry.method} rejected by user`;
      this.ctx.storage.put(execKey(state.id), state);
    }
  }

  // -----------------------------------------------------------------------
  // Rollback — walk the log backward; the proxy tool calls revertAction.
  // -----------------------------------------------------------------------

  /** Return applied actions (not observations/steps) in reverse order. */
  async actionsToRevert(): Promise<ToolLogEntry[]> {
    const state = await this.#current();
    if (!state) return [];
    return state.log
      .filter((e) => e.requiresApproval && e.state === "applied")
      .reverse();
  }

  /** Mark an action reverted after the proxy tool has reverted it. */
  async markReverted(seq: number): Promise<void> {
    const state = await this.#requireCurrent();
    const entry = state.log[seq];
    if (entry) {
      entry.state = "reverted";
      this.ctx.storage.put(execKey(state.id), state);
    }
  }

  // -----------------------------------------------------------------------
  // Inspection + scratchpad state (per-execution)
  // -----------------------------------------------------------------------

  async getExecution(id?: string): Promise<ExecutionState | null> {
    if (id) return this.#get(id);
    return this.#current();
  }

  async getState(key: string): Promise<unknown> {
    const state = await this.#current();
    return state?.scratch[key] ?? null;
  }

  async setState(key: string, value: unknown): Promise<void> {
    const state = await this.#requireCurrent();
    state.scratch[key] = value;
    this.ctx.storage.put(execKey(state.id), state);
  }

  // -----------------------------------------------------------------------
  // Snippets — durable, addressable saved scripts
  // -----------------------------------------------------------------------

  /**
   * Promote the current execution's code to a saved, addressable snippet.
   * This is the "save what just ran" hook — the model calls it after a script
   * works so it can be re-run later with `codemode.run(name)`.
   */
  async saveSnippet(
    name: string,
    options?: SaveSnippetOptions
  ): Promise<Snippet> {
    const state = await this.#requireCurrent();
    const snippet: Snippet = {
      name,
      description: options?.description ?? "",
      code: state.code,
      savedAt: Date.now(),
      inputSchema: options?.inputSchema
    };
    this.ctx.storage.put(snippetKey(name), snippet);
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

  async #currentId(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(CURRENT_KEY)) ?? null;
  }

  async #get(id: string): Promise<ExecutionState | null> {
    return (await this.ctx.storage.get<ExecutionState>(execKey(id))) ?? null;
  }

  async #current(): Promise<ExecutionState | null> {
    const id = await this.#currentId();
    return id ? this.#get(id) : null;
  }

  async #requireCurrent(): Promise<ExecutionState> {
    const state = await this.#current();
    if (!state) throw new Error("No current execution");
    return state;
  }
}
