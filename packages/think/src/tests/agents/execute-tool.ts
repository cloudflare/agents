/**
 * Test agent for the unified execute tool (Stage 3b): a real Think agent
 * whose execute tool is backed by createCodemodeRuntime — real facet, real
 * DynamicWorkerExecutor sandbox, real Workers RPC for connector calls.
 */
import { tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { WorkspaceFsLike } from "@cloudflare/shell";
import { createWorkspaceStateBackend } from "@cloudflare/shell";
import { Think } from "../../think";
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
      state: createWorkspaceStateBackend(
        this.workspace as unknown as WorkspaceFsLike
      ),
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
