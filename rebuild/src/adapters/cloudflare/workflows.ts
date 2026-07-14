import { NotFoundError } from "../../kernel/errors.js";
import type { WorkflowRuntime } from "../../ports/workflow-runtime.js";

type WorkflowStatus = {
  status: string;
  output?: unknown;
  error?: { message?: string } | string;
};

type WorkflowInstanceLike = {
  status(): Promise<WorkflowStatus>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  restart(): Promise<void>;
  terminate(): Promise<void>;
  sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
};

type WorkflowLike = {
  create(options: { id: string; params?: unknown }): Promise<unknown>;
  get(id: string): Promise<WorkflowInstanceLike>;
};

function statusError(error: WorkflowStatus["error"]): string | undefined {
  if (error === undefined) return undefined;
  if (typeof error === "string") return error;
  return error.message;
}

export function createWorkflowRuntime(
  resolve: (name: string) => Workflow | undefined
): WorkflowRuntime {
  function bindingFor(name: string): WorkflowLike {
    const binding = resolve(name) as WorkflowLike | undefined;
    if (!binding) throw new NotFoundError(`Unknown workflow binding: ${name}`);
    return binding;
  }

  async function instanceFor(
    name: string,
    id: string
  ): Promise<WorkflowInstanceLike> {
    return bindingFor(name).get(id);
  }

  return {
    async create(name, options): Promise<void> {
      await bindingFor(name).create(options);
    },
    async sendEvent(name, id, event): Promise<void> {
      await (await instanceFor(name, id)).sendEvent(event);
    },
    async terminate(name, id): Promise<void> {
      await (await instanceFor(name, id)).terminate();
    },
    async pause(name, id): Promise<void> {
      await (await instanceFor(name, id)).pause();
    },
    async resume(name, id): Promise<void> {
      await (await instanceFor(name, id)).resume();
    },
    async restart(name, id): Promise<void> {
      await (await instanceFor(name, id)).restart();
    },
    async status(name, id): Promise<{
      status: string;
      output?: unknown;
      error?: string;
    } | null> {
      const binding = bindingFor(name);
      let instance: WorkflowInstanceLike;
      try {
        instance = await binding.get(id);
      } catch {
        return null;
      }

      const current = await instance.status();
      return {
        status: current.status,
        ...(current.output !== undefined ? { output: current.output } : {}),
        ...(current.error !== undefined
          ? { error: statusError(current.error) }
          : {})
      };
    }
  };
}
