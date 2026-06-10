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
import { CodemodeConnector, type ConnectorTools } from "../connectors";
import { DynamicWorkerExecutor } from "../executor";
import { createCodemodeRuntime } from "../runtime-handle";
import type { ProxyToolInput, ProxyToolOutput } from "../proxy-tool";

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

  name() {
    return "items";
  }

  protected tools(): ConnectorTools {
    return {
      list_items: {
        description: "List all items.",
        execute: () => [...this.created]
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
}

type RunOptions = { maxExecutions?: number };

export class CodemodeTestHost extends DurableObject<Env> {
  #connector?: ItemsConnector;

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
      maxExecutions: options?.maxExecutions
    });
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
}

export default {
  fetch() {
    return new Response("ok");
  }
};
