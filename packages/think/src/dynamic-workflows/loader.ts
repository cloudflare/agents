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
  _getWorkflowCode(wfId: string): Promise<string>;
};

/**
 * Compatibility date applied to generated Dynamic Workers. Pinned because the
 * loader has no access to the host worker's own compatibility date at runtime.
 * Known limitation: generated workflows run against this fixed runtime surface
 * — bump it deliberately when generated code needs newer runtime behaviour.
 */
const DYNAMIC_WORKFLOW_COMPATIBILITY_DATE = "2026-01-01";

function assertDynamicThinkWorkflowMeta(
  metadata: unknown
): asserts metadata is DynamicThinkWorkflowMeta {
  const meta = metadata as Partial<DynamicThinkWorkflowMeta> | null | undefined;
  if (
    !meta ||
    typeof meta.wfId !== "string" ||
    typeof meta.agentBinding !== "string" ||
    typeof meta.agentName !== "string"
  ) {
    throw new Error(
      "DynamicThinkWorkflow metadata is missing required fields " +
        "(wfId, agentBinding, agentName)"
    );
  }
}

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
      assertDynamicThinkWorkflowMeta(metadata);
      const meta = metadata;

      // Bundling + RPC fetch only run on a cache miss. `LOADER.get` returns the
      // already-built worker on subsequent step dispatches, retries, and
      // resumptions, so we avoid recompiling the TypeScript on every step.
      const worker = env.LOADER.get(`dwt-${meta.wfId}`, async () => {
        const { createWorker } = await import("@cloudflare/worker-bundler");

        const agentNS = env[meta.agentBinding] as DurableObjectNamespace;
        const agentStub = agentNS.get(
          agentNS.idFromName(meta.agentName)
        ) as unknown as AgentStub;
        const code = await agentStub._getWorkflowCode(meta.wfId);

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

        return {
          mainModule,
          modules,
          compatibilityDate: DYNAMIC_WORKFLOW_COMPATIBILITY_DATE,
          env: { [meta.agentBinding]: env[meta.agentBinding] }
        };
      });

      return worker.getEntrypoint(
        "GeneratedWorkflow"
      ) as unknown as WorkflowRunner;
    }
  );
