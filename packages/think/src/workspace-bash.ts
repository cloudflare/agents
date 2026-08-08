import { Workspace as ComputerWorkspace } from "./workspace";
import {
  WorkspaceServiceProxy,
  type WorkspaceOptions as ComputerWorkspaceOptions,
  type WorkspaceStub
} from "@cloudflare/computer";
import {
  WorkerShellBackend,
  type WorkerShellBackendOptions
} from "@cloudflare/computer/backends/worker-shell";
import { createExecTool } from "@cloudflare/computer/tools";
import type { ToolSet } from "ai";
import {
  workspaceStubProvider,
  workspaceToolProvider,
  type ThinkWorkspace,
  type WorkspaceStubProvider,
  type WorkspaceToolProvider
} from "./workspace-contract";

export { WorkspaceServiceProxy };
export type { WorkerShellBackendOptions };

export interface BashWorkspaceToolOptions {
  backendId?: string;
  description?: string;
  maxBytes?: number;
}

export interface BashWorkspaceOptions extends Omit<
  ComputerWorkspaceOptions,
  "backends"
> {
  /** Durable Object namespace binding that owns this Think instance. */
  binding: string;
  /** `this.ctx.id.toString()` for this Think instance. */
  id: string;
  backend: Omit<WorkerShellBackendOptions, "workspace">;
  tool?: Omit<BashWorkspaceToolOptions, "backendId">;
}

export function createBashWorkspaceTools(
  workspace: ThinkWorkspace,
  options: BashWorkspaceToolOptions = {}
): ToolSet {
  const backendId = options.backendId ?? "worker-shell";
  const bash = createExecTool({
    workspace,
    defaultBackend: backendId,
    backends: {
      [backendId]: {
        description:
          options.description ??
          "A fast in-Worker shell for file inspection and text processing."
      }
    },
    maxBytes: options.maxBytes
  });
  const execute = bash.execute;
  if (execute) {
    bash.execute = async (input, context) => {
      await workspace.fs.mkdir("/workspace", { recursive: true });
      return execute(input, context);
    };
  }
  return { bash };
}

/** Computer workspace configured with the Worker Shell backend. */
export class BashWorkspace
  extends ComputerWorkspace
  implements WorkspaceToolProvider, WorkspaceStubProvider
{
  readonly #backendId: string;
  readonly #toolOptions: Omit<BashWorkspaceToolOptions, "backendId">;

  constructor(options: BashWorkspaceOptions) {
    const {
      binding,
      id,
      backend: backendOptions,
      tool = {},
      ...workspaceOptions
    } = options;
    const backend = new WorkerShellBackend({
      ...backendOptions,
      workspace: { binding, id }
    });
    super({ ...workspaceOptions, backends: [backend] });
    this.#backendId = backend.id;
    this.#toolOptions = tool;
  }

  [workspaceToolProvider](): ToolSet {
    return createBashWorkspaceTools(this, {
      ...this.#toolOptions,
      backendId: this.#backendId
    });
  }

  async [workspaceStubProvider](): Promise<WorkspaceStub> {
    await this.ready();
    return this.stub();
  }
}

export { BashWorkspace as Workspace };
