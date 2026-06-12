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
import { DynamicWorkerExecutor } from "../executor";
import { createCodemodeRuntime } from "../runtime-handle";
import {
  getCodemodeRuntime,
  type ProxyToolInput,
  type ProxyToolOutput
} from "../proxy-tool";

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

  name() {
    return "items";
  }

  protected tools(): ConnectorTools {
    return {
      list_items: {
        description: "List all items.",
        execute: () => [...this.created]
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
        revert: (_args, result) => {
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

  #runtime(options?: RunOptions & { name?: string; noConnectors?: boolean }) {
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    return createCodemodeRuntime({
      ctx: this.ctx,
      executor,
      connectors: options?.noConnectors ? [] : [this.#items()],
      name: options?.name,
      maxExecutions: options?.maxExecutions,
      transformResult: this.#shape ? (r) => ({ shaped: r }) : undefined
    });
  }

  enableShaping() {
    this.#shape = true;
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

    // First pass: the approval-gated call pauses.
    await facet.decide(id, 0, "items", "create_item", args, true);
    // Approve → resume returns the run to "running".
    await facet.resume(id);
    // Replay reaches the approved call: it must transition to "executing".
    const decision = await facet.decide(
      id,
      0,
      "items",
      "create_item",
      args,
      true
    );
    const duringExecute = (await facet.getExecution(id))?.log[0]?.state;
    // A concurrent reject lands during execution: must no-op.
    const rejected = await facet.reject(0, id);
    const afterReject = await facet.getExecution(id);
    // Execution finishes and records its result.
    await facet.recordResult(id, 0, { id: 1 });
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

export default {
  fetch() {
    return new Response("ok");
  }
};
