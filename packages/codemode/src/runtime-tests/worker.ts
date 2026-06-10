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
  type ExecutionEndStatus
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

  name() {
    return "items";
  }

  protected tools(): ConnectorTools {
    return {
      list_items: {
        description: "List all items.",
        execute: () => [...this.created]
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

  #runtime(options?: RunOptions) {
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    return createCodemodeRuntime({
      ctx: this.ctx,
      executor,
      connectors: [this.#items()],
      maxExecutions: options?.maxExecutions,
      transformResult: this.#shape ? (r) => ({ shaped: r }) : undefined
    });
  }

  enableShaping() {
    this.#shape = true;
  }

  async run(code: string, options?: RunOptions): Promise<ProxyToolOutput> {
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

  reject(seq: number, executionId: string): Promise<void> {
    return this.#runtime().reject({ seq, executionId });
  }

  rollback(executionId: string): Promise<void> {
    return this.#runtime().rollback({ executionId });
  }

  pending(executionId?: string) {
    return this.#runtime().pending(executionId);
  }

  executions() {
    return this.#runtime().executions();
  }

  deleteExecution(id: string) {
    return this.#runtime().deleteExecution(id);
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

  /**
   * Drive the facet directly to reproduce the approve→execute→reject race at the
   * decision boundary: once an approved action is decided for execution it must
   * be "executing" (not "pending"), so a concurrent reject() no-ops rather than
   * reverting an action already running on the host.
   */
  async raceRejectDuringApprovedExecute() {
    const facet = getCodemodeRuntime(this.ctx, [this.#items()]);
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
