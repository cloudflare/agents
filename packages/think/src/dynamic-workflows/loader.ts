import {
  createDynamicWorkflowEntrypoint,
  type WorkflowRunner
} from "@cloudflare/dynamic-workflows";

type DynamicThinkWorkflowMeta = {
  wfId: string;
  agentBinding: string;
  agentName: string;
};

type DynamicThinkWorkflowEnv = {
  LOADER: WorkerLoader;
  [key: string]: unknown;
};

type AgentStub = {
  getWorkflowCode(wfId: string): Promise<string>;
};

/**
 * DynamicThinkWorkflow — register this as the `class_name` in your
 * `[[workflows]]` wrangler binding. When the engine calls `run()`, it
 * loads the generated ThinkWorkflow code from the agent via RPC, bundles
 * it with its npm dependencies (ThinkWorkflow, zod, etc.) via worker-bundler,
 * loads it as a Dynamic Worker, and dispatches execution to it.
 *
 * The generated code runs as a real ThinkWorkflow — `step.prompt()`,
 * `this.agent`, `step.do()`, `step.waitForEvent()` all work natively.
 *
 * @example
 * ```ts
 * // wrangler.jsonc
 * {
 *   "workflows": [{
 *     "name": "dynamic-think",
 *     "binding": "DYNAMIC_THINK_WF",
 *     "class_name": "DynamicThinkWorkflow"
 *   }]
 * }
 *
 * // server.ts
 * export { DynamicThinkWorkflow } from "@cloudflare/think/dynamic-workflows";
 * ```
 */
export const DynamicThinkWorkflow =
  createDynamicWorkflowEntrypoint<DynamicThinkWorkflowEnv>(
    async ({ env, metadata }) => {
      const { createWorker } = await import("@cloudflare/worker-bundler");
      const meta = metadata as unknown as DynamicThinkWorkflowMeta;

      const agentNS = env[meta.agentBinding] as DurableObjectNamespace;
      const agentStub = agentNS.get(
        agentNS.idFromName(meta.agentName)
      ) as unknown as AgentStub;
      const code = await agentStub.getWorkflowCode(meta.wfId);

      const { mainModule, modules } = await createWorker({
        files: {
          "workflow.ts": code,
          "package.json": JSON.stringify({
            dependencies: {
              "@cloudflare/think": "*",
              zod: "*"
            }
          })
        }
      });

      const worker = env.LOADER.get(`dwt-${meta.wfId}`, async () => ({
        mainModule,
        modules,
        compatibilityDate: "2026-01-01",
        env: { [meta.agentBinding]: env[meta.agentBinding] }
      }));

      return worker.getEntrypoint(
        "GeneratedWorkflow"
      ) as unknown as WorkflowRunner;
    }
  );
