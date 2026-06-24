/**
 * E2E test worker for the codemode durable runtime.
 *
 * Exercises the *real* path: a Durable Object host spawns the `CodemodeRuntime`
 * facet, runs LLM-style code in a real `DynamicWorkerExecutor` sandbox, and
 * routes connector calls back through the facet for the replay/approve/pause
 * decision. Connector calls travel over real Workers RPC (the binding bug that
 * unit tests can't see).
 */
import { DurableObject } from "cloudflare:workers";
import {
  CodemodeConnector,
  type ConnectorTools,
  type ExecutionEndStatus,
  type PassEndStatus
} from "../connectors";
import { RetryableError } from "../retry";
import { DynamicWorkerExecutor } from "../executor";
import {
  createCodemodeRuntime,
  type CodemodeRuntimeHandle
} from "../runtime-handle";
import {
  getCodemodeRuntime,
  type ProxyToolInput,
  type ProxyToolOutput
} from "../proxy-tool";

import { initializeRuntimeSchema } from "../runtime";
import { ExecutionAttemptStore } from "../runtime-attempts";

// Re-export the facet class so the runtime can spawn it (and so vitest's
// pool-workers can resolve a facet-compatible class value).
export { CodemodeRuntime } from "../runtime";

type Env = {
  LOADER: WorkerLoader;
  CodemodeTestHost: DurableObjectNamespace<CodemodeTestHost>;
};

/**
 * A connector with a read, an approval-gated write that can be reverted, and a
 * non-approval write that also has a revert (to verify rollback no longer keys
 * off `requiresApproval`).
 */
class ItemsConnector extends CodemodeConnector<Env> {
  created: Array<{ title: string }> = [];
  deleted: unknown[] = [];
  notes: string[] = [];
  // Per-execution lifecycle tracking — proves the executionId-scoped resource
  // contract: opened once per run on first use, disposed once on a terminal
  // status (never on pause).
  opened: string[] = [];
  disposed: Array<{ executionId: string; status: ExecutionEndStatus }> = [];
  // Per-pass lifecycle — onPassEnd fires for EVERY pass, including pauses.
  passEnds: Array<{ executionId: string; status: PassEndStatus }> = [];
  // Counts real executions of the ephemeral read — replays must re-execute.
  ephemeralReads = 0;
  checkpointReads = 0;
  retryableCalls = 0;
  retryAlwaysCalls = 0;
  slowCalls = 0;
  abortableCalls = 0;
  activeAborts = 0;
  passAborts = 0;
  revertAborts = 0;

  name() {
    return "items";
  }

  protected tools(): ConnectorTools {
    return {
      list_items: {
        description: "List all items.",
        execute: () => [...this.created]
      },
      checkpoint_read: {
        description: "Count executions before a retry boundary.",
        execute: () => ({ reads: ++this.checkpointReads })
      },
      retry_once: {
        description: "Fail retryably once, then succeed.",
        execute: () => {
          this.retryableCalls++;
          if (this.retryableCalls === 1) {
            throw new RetryableError("try again", { retryAfterMs: 0 });
          }
          return { calls: this.retryableCalls };
        }
      },
      retry_always: {
        description: "Always fail retryably.",
        execute: () => {
          this.retryAlwaysCalls++;
          throw new RetryableError("still busy", { retryAfterMs: 0 });
        }
      },
      slow_once: {
        description: "Finish the first call after its sandbox timed out.",
        execute: async () => {
          const call = ++this.slowCalls;
          if (call === 1)
            await new Promise((resolve) => setTimeout(resolve, 50));
          return { call };
        }
      },
      abortable_slow_once: {
        description: "Abort the first slow call when its pass times out.",
        execute: async (_args, ctx) => {
          if (!ctx?.signal) throw new Error("missing execution signal");
          const signal = ctx.signal;
          const call = ++this.abortableCalls;
          if (call > 1) return { call };
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ call }), 1_000);
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                this.activeAborts++;
                reject(signal.reason);
              },
              { once: true }
            );
          });
        }
      },
      observe_abort: {
        description: "Observe the pass signal after returning.",
        execute: (_args, ctx) => {
          if (!ctx?.signal) throw new Error("missing execution signal");
          ctx.signal.addEventListener(
            "abort",
            () => {
              this.passAborts++;
            },
            { once: true }
          );
          return { observed: true };
        }
      },
      read_counter: {
        // Ephemeral read: result is never stored in the durable log; replay
        // re-executes it. The counter makes re-execution observable.
        description: "Ephemeral read that counts its real executions.",
        replay: "reexecute",
        execute: () => ({ reads: ++this.ephemeralReads })
      },
      get_bytes: {
        // Binary result — exercises the storage codec roundtrip through the
        // durable log (record on first pass, replay decoded on resume).
        description: "Return binary data.",
        execute: () => new Uint8Array([1, 2, 3, 4, 5])
      },
      big_result: {
        description: "Return a result too large for the durable log.",
        execute: () => "x".repeat(1_100_000)
      },
      session_id: {
        // Reads the execution context — opens a per-execution "session".
        description: "Return the current execution id.",
        execute: (_args, ctx) => {
          const executionId = ctx?.executionId ?? "";
          if (executionId && !this.opened.includes(executionId)) {
            this.opened.push(executionId);
          }
          return { executionId };
        }
      },
      create_item: {
        description: "Create an item. Requires approval.",
        requiresApproval: true,
        execute: (args) => {
          const item = args as { title: string };
          this.created.push(item);
          return { id: this.created.length, title: item.title };
        },
        revert: (_args, result, ctx) => {
          ctx?.signal?.addEventListener(
            "abort",
            () => {
              this.revertAborts++;
            },
            { once: true }
          );
          this.deleted.push(result);
        }
      },
      boom: {
        // Always throws — exercises the host→sandbox error path: the binding
        // must return an error marker (never reject across RPC) so the run ends
        // "error" without leaving an unhandled rejection on the host.
        description: "Always throws.",
        execute: () => {
          throw new Error("connector boom");
        }
      },
      add_note: {
        // No approval, but reversible — rollback must still undo it.
        description: "Add a note immediately (no approval).",
        execute: (args) => {
          const { text } = args as { text: string };
          this.notes.push(text);
          return { index: this.notes.length - 1 };
        },
        revert: (_args, result) => {
          const { index } = result as { index: number };
          this.notes[index] = "__reverted__";
        }
      }
    };
  }

  override async disposeExecution(
    executionId: string,
    status: ExecutionEndStatus
  ): Promise<void> {
    this.disposed.push({ executionId, status });
  }

  override async onPassEnd(
    executionId: string,
    status: PassEndStatus
  ): Promise<void> {
    this.passEnds.push({ executionId, status });
  }
}

type RunOptions = { maxExecutions?: number };

export class CodemodeTestHost extends DurableObject<Env> {
  #connector?: ItemsConnector;
  // When set, the runtime wraps every completed result so tests can assert the
  // transformResult hook fires on both the initial run and a resume.
  #shape = false;

  #items() {
    this.#connector ??= new ItemsConnector(this.ctx, this.env);
    return this.#connector;
  }

  #runtime(
    options?: RunOptions & {
      name?: string;
      noConnectors?: boolean;
      retry?: boolean;
      disableRetry?: boolean;
      timeoutRetry?: boolean;
      retryScenario?: "decline" | "throw-policy" | "throw-delay";
    }
  ) {
    const executor = new DynamicWorkerExecutor({
      loader: this.env.LOADER,
      timeout: options?.timeoutRetry ? 10 : undefined
    });
    return createCodemodeRuntime({
      ctx: this.ctx,
      executor,
      connectors: options?.noConnectors ? [] : [this.#items()],
      name: options?.name,
      maxExecutions: options?.maxExecutions,
      transformResult: this.#shape ? (r) => ({ shaped: r }) : undefined,
      retry: options?.disableRetry
        ? false
        : options?.retryScenario
          ? retryScenario(options.retryScenario)
          : options?.retry || options?.timeoutRetry
            ? {
                maxAttempts: 2,
                shouldRetry: ({ failure }) =>
                  failure.kind === "retryable" || failure.kind === "timeout"
              }
            : undefined
    });
  }

  enableShaping() {
    this.#shape = true;
  }

  attemptStoreLifecycle() {
    initializeRuntimeSchema(this.ctx.storage.sql);
    const attempts = new ExecutionAttemptStore(this.ctx.storage.sql);
    this.ctx.storage.sql.exec(
      `INSERT INTO cm_executions
        (id, code, status, created_at, updated_at)
        VALUES ('lifecycle', 'async () => {}', 'running', 1, 1)`
    );
    attempts.begin("lifecycle");
    const initial = attempts.current("lifecycle");
    const advanced = attempts.advance("lifecycle", initial);
    this.ctx.storage.sql.exec(
      `UPDATE cm_executions SET status = 'error' WHERE id = 'lifecycle'`
    );
    const terminalAdvance = attempts.advance("lifecycle", advanced ?? initial);
    attempts.delete("lifecycle");
    let missingThrows = false;
    try {
      attempts.current("lifecycle");
    } catch {
      missingThrows = true;
    }
    return { initial, advanced, terminalAdvance, missingThrows };
  }

  /** Exercise initialization against the exact schema released in 0.4.1. */
  backfillReleasedExecutionAttempt() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE cm_executions (
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
      INSERT INTO cm_executions
        (id, code, status, created_at, updated_at)
        VALUES ('released', 'async () => {}', 'paused', 1, 1);
    `);
    initializeRuntimeSchema(this.ctx.storage.sql);
    new ExecutionAttemptStore(this.ctx.storage.sql);
    const initial = this.ctx.storage.sql
      .exec<{ attempt: number }>(
        `SELECT attempt FROM cm_attempts WHERE execution_id = 'released'`
      )
      .toArray()[0]?.attempt;

    this.ctx.storage.sql.exec(
      `UPDATE cm_attempts SET attempt = 2 WHERE execution_id = 'released'`
    );
    initializeRuntimeSchema(this.ctx.storage.sql);
    new ExecutionAttemptStore(this.ctx.storage.sql);
    const afterRepeat = this.ctx.storage.sql
      .exec<{ attempt: number }>(
        `SELECT attempt FROM cm_attempts WHERE execution_id = 'released'`
      )
      .toArray()[0]?.attempt;
    return { initial, afterRepeat };
  }

  async run(
    code: string,
    options?: RunOptions & { name?: string }
  ): Promise<ProxyToolOutput> {
    const codemode = this.#runtime(options).tool();
    const execute = codemode.execute as (
      input: ProxyToolInput,
      ctx: unknown
    ) => Promise<ProxyToolOutput>;
    return execute({ code }, { toolCallId: "test", messages: [] });
  }

  async runWithRetry(code: string): Promise<ProxyToolOutput> {
    return this.#execute(this.#runtime({ retry: true }), code);
  }

  retryCounts() {
    return {
      checkpointReads: this.#items().checkpointReads,
      retryableCalls: this.#items().retryableCalls
    };
  }

  retryAlwaysCalls() {
    return this.#items().retryAlwaysCalls;
  }

  async runWithoutRetries(code: string): Promise<ProxyToolOutput> {
    return this.#execute(this.#runtime({ disableRetry: true }), code);
  }

  async runWithTimeoutRetry(code: string): Promise<ProxyToolOutput> {
    return this.#execute(this.#runtime({ timeoutRetry: true }), code);
  }

  async runWithRetryScenario(
    code: string,
    scenario: "decline" | "throw-policy" | "throw-delay"
  ): Promise<ProxyToolOutput> {
    return this.#execute(this.#runtime({ retryScenario: scenario }), code);
  }

  slowCalls() {
    return this.#items().slowCalls;
  }

  abortCounts() {
    const connector = this.#items();
    return {
      calls: connector.abortableCalls,
      active: connector.activeAborts,
      passes: connector.passAborts,
      reverts: connector.revertAborts
    };
  }

  /** Prove terminal executions reject a connector result that arrives late. */
  async lateResultAfterTerminal(status: "completed" | "error") {
    const facet = getCodemodeRuntime(this.ctx);
    const id = await facet.begin("async () => {}");
    const attempt = await facet.currentAttempt(id);
    const decision = await facet.decide(
      id,
      0,
      "items",
      "slow_once",
      undefined,
      false,
      false,
      attempt
    );
    if (status === "completed") {
      await facet.complete(id, { winner: true });
    } else {
      await facet.fail(id, "terminal failure");
    }
    const recorded = await facet.recordResult(
      id,
      0,
      { late: true },
      decision.kind === "execute" ? decision.attempt : attempt
    );
    const execution = await facet.getExecution(id);
    return {
      recorded,
      status: execution?.status,
      result: execution?.result,
      logState: execution?.log[0]?.state,
      logResult: execution?.log[0]?.result
    };
  }

  #execute(
    runtime: CodemodeRuntimeHandle,
    code: string
  ): Promise<ProxyToolOutput> {
    const execute = runtime.tool().execute;
    return execute({ code }, { toolCallId: "test", messages: [] });
  }

  approve(executionId: string): Promise<ProxyToolOutput> {
    return this.#runtime().approve({ executionId });
  }

  /**
   * Approve via a runtime whose connector set no longer includes "items" —
   * exercises the recorded-connector-requirements validation on resume.
   */
  approveWithoutItems(executionId: string): Promise<ProxyToolOutput> {
    return this.#runtime({ noConnectors: true }).approve({ executionId });
  }

  /** Run a snippet by name on a runtime with NO connectors configured. */
  async runSnippetWithoutItems(snippet: string): Promise<ProxyToolOutput> {
    const codemode = this.#runtime({ noConnectors: true }).tool();
    const execute = codemode.execute as (
      input: ProxyToolInput,
      ctx: unknown
    ) => Promise<ProxyToolOutput>;
    return execute(
      { code: `async () => await codemode.run(${JSON.stringify(snippet)})` },
      { toolCallId: "test", messages: [] }
    );
  }

  expirePaused(maxAgeMs?: number): Promise<string[]> {
    return this.#runtime().expirePaused({ maxAgeMs });
  }

  reject(seq: number, executionId: string): Promise<boolean> {
    return this.#runtime().reject({ seq, executionId });
  }

  rollback(executionId: string): Promise<void> {
    return this.#runtime().rollback({ executionId });
  }

  pending(executionId?: string) {
    return this.#runtime().pending(executionId);
  }

  executions(name?: string) {
    return this.#runtime({ name }).executions();
  }

  deleteExecution(id: string) {
    return this.#runtime().deleteExecution(id);
  }

  /**
   * Begin an execution directly on the facet and "die" without running a
   * pass — leaves the row stuck in `running`, like a host crash mid-pass.
   */
  beginOnly(code: string): Promise<string> {
    return getCodemodeRuntime(this.ctx).begin(code);
  }

  /** The model-facing description of the execute tool. */
  toolDescription(connectorHints?: Record<string, string>): string {
    return this.#runtime().tool({ connectorHints }).description ?? "";
  }

  saveSnippet(name: string, description: string, executionId: string) {
    return this.#runtime().saveSnippet(name, { description, executionId });
  }

  snippets() {
    return this.#runtime().snippets();
  }

  sideEffects() {
    const c = this.#items();
    return { created: c.created, deleted: c.deleted, notes: c.notes };
  }

  lifecycle() {
    const c = this.#items();
    return { opened: c.opened, disposed: c.disposed };
  }

  passEnds() {
    return this.#items().passEnds;
  }

  /**
   * Drive the facet directly to reproduce the approve→execute→reject race at the
   * decision boundary: once an approved action is decided for execution it must
   * be "executing" (not "pending"), so a concurrent reject() no-ops rather than
   * reverting an action already running on the host.
   */
  async raceRejectDuringApprovedExecute() {
    const facet = getCodemodeRuntime(this.ctx);
    const id = await facet.begin("async () => {}");
    const args = { title: "race" };

    const attempt = await facet.currentAttempt(id);
    // First pass: the approval-gated call pauses.
    await facet.decide(
      id,
      0,
      "items",
      "create_item",
      args,
      true,
      false,
      attempt
    );
    // Approve → resume returns the run to "running".
    await facet.resume(id);
    // Replay reaches the approved call: it must transition to "executing".
    const decision = await facet.decide(
      id,
      0,
      "items",
      "create_item",
      args,
      true,
      false,
      attempt
    );
    const duringExecute = (await facet.getExecution(id))?.log[0]?.state;
    // A concurrent reject lands during execution: must no-op.
    const rejected = await facet.reject(0, id);
    const afterReject = await facet.getExecution(id);
    // Execution finishes and records its result.
    await facet.recordResult(id, 0, { id: 1 }, attempt);
    const final = await facet.getExecution(id);

    return {
      decisionKind: decision.kind,
      duringExecute,
      rejected,
      statusAfterReject: afterReject?.status,
      stateAfterReject: afterReject?.log[0]?.state,
      stateFinal: final?.log[0]?.state
    };
  }
}

function retryScenario(scenario: "decline" | "throw-policy" | "throw-delay") {
  if (scenario === "decline") {
    return { shouldRetry: () => false };
  }
  if (scenario === "throw-policy") {
    return {
      shouldRetry: () => {
        throw new Error("retry policy crashed");
      }
    };
  }
  return {
    shouldRetry: () => true,
    delayMs: () => {
      throw new Error("retry delay crashed");
    }
  };
}

export default {
  fetch() {
    return new Response("ok");
  }
};
