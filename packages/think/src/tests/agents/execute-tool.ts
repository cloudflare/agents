/**
 * Test agent for the unified execute tool (Stage 3b): a real Think agent
 * whose execute tool is backed by createCodemodeRuntime — real facet, real
 * DynamicWorkerExecutor sandbox, real Workers RPC for connector calls.
 */
import { tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { DurableObjectStorageLike } from "@cloudflare/computer";
import { Think } from "../../think";
import { Workspace as BashWorkspace } from "../../workspace/workspace-bash";
import { workspaceToolProvider } from "../../workspace/types";
import { Workspace } from "../../workspace/workspace";
import {
  createExecuteRuntime,
  createExecuteTool,
  type ExecuteRuntime
} from "../../tools/execute";

// `result` is kept to RPC-serializable primitives so the DurableObjectStub
// method types don't collapse to `never` in tests.
type ExecuteOutput = {
  status: string;
  executionId?: string;
  result?: string | number | boolean | null;
  error?: string;
  pending?: Array<{ connector: string; method: string }>;
};

async function invoke(
  executeTool: { execute?: unknown },
  code: string
): Promise<ExecuteOutput> {
  const execute = executeTool.execute as (input: {
    code: string;
  }) => Promise<ExecuteOutput>;
  return execute({ code });
}

export class ThinkExecuteToolAgent extends Think {
  getModel(): LanguageModel {
    throw new Error("Model is not used in execute-tool tests");
  }

  #runtime(): ExecuteRuntime {
    return createExecuteRuntime({
      ctx: this.ctx,
      tools: {
        add: tool({
          description: "Add two numbers",
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => ({ sum: a + b })
        }),
        launchMissiles: tool({
          description: "Approval-gated — must be stripped from the sandbox",
          inputSchema: z.object({}),
          needsApproval: true,
          execute: async () => "boom"
        })
      },
      workspace: this.workspace,
      loader: this.env.LOADER
    });
  }

  /** Run code on the explicit-options runtime (tools.* + state.*). */
  async runExecute(code: string): Promise<ExecuteOutput> {
    return invoke(this.#runtime().tool, code);
  }

  /** Run code through the `createExecuteTool(this)` one-liner. */
  async runOneLiner(code: string): Promise<ExecuteOutput> {
    return invoke(createExecuteTool(this), code);
  }

  /** The sandbox type surface advertised by the `tools` connector. */
  async toolsConnectorTypes(): Promise<string> {
    const { connectors } = this.#runtime();
    const toolset = connectors.find((c) => c.name() === "tools");
    if (!toolset) throw new Error("tools connector missing");
    return toolset.getTypeScriptTypes();
  }

  /**
   * Audit trail via the agent-accessible handle — `createExecuteRuntime(this)`
   * (exercised by runOneLiner) assigns `this.codemode`.
   */
  async codemodeExecutionStatuses(): Promise<string[]> {
    if (!this.codemode) return [];
    return (await this.codemode.executions()).map((e) => e.status);
  }
}

export class ThinkComputerWorkspaceExecuteAgent extends Think {
  override workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike
  });

  #replay?: ExecuteRuntime;

  getModel(): LanguageModel {
    throw new Error("Model is not used in Computer workspace tests");
  }

  #replayRuntime(): ExecuteRuntime {
    this.#replay ??= createExecuteRuntime(this, {
      tools: {
        checkpoint: tool({
          description: "Pause execution for a replay test",
          inputSchema: z.object({}),
          needsApproval: true,
          execute: async () => "approved"
        })
      }
    });
    return this.#replay;
  }

  async runWorkspaceExecute(code: string): Promise<ExecuteOutput> {
    return invoke(createExecuteTool(this), code);
  }

  async runExplicitWorkspaceExecute(code: string): Promise<ExecuteOutput> {
    return invoke(
      createExecuteTool({
        ctx: this.ctx,
        workspace: this.workspace,
        loader: this.env.LOADER
      }),
      code
    );
  }

  async runWorkspaceReplay(code: string): Promise<ExecuteOutput> {
    return invoke(this.#replayRuntime().tool, code);
  }

  async approveWorkspaceReplay(executionId: string): Promise<unknown> {
    return this.#replayRuntime().runtime.approve({ executionId });
  }

  async writeWorkspaceFile(path: string, content: string): Promise<void> {
    await this.workspace.fs.writeFile(path, content);
  }
}

export class ThinkBashWorkspaceAgent extends Think {
  override workspace = new BashWorkspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    binding: "ThinkBashWorkspaceAgent",
    id: this.ctx.id.toString(),
    backend: {
      loader: this.env.LOADER,
      ctx: this.ctx
    }
  });

  getModel(): LanguageModel {
    throw new Error("Model is not used in bash workspace tests");
  }

  async runBash(command: string): Promise<unknown> {
    const bash = this.workspace[workspaceToolProvider]().bash.execute;
    if (!bash) throw new Error("Bash workspace tool is missing");
    return bash(
      { command },
      {
        toolCallId: "test",
        messages: [],
        abortSignal: new AbortController().signal,
        context: {}
      }
    );
  }

  async runCodemodeState(code: string): Promise<ExecuteOutput> {
    return invoke(createExecuteTool(this), code);
  }

  async readFile(path: string): Promise<string> {
    return this.workspace.fs.readFile(path, "utf8");
  }
}
