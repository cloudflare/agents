import type { RunHostFunctionManifestEntry } from "./dynamic-worker-protocol";
import dynamicWorkerRuntimeSource from "./dynamic-worker-runtime?dynamic-worker-source";
import { createRunSourceModule } from "./run-source";

const RUN_DYNAMIC_WORKER_EXECUTOR_SOURCE =
  'import __runUser__ from "./run.js";\n' + dynamicWorkerRuntimeSource;

/** Build the two package-owned modules loaded for one Run invocation. */
export function createDynamicWorkerModules(
  source: string,
  manifest: readonly RunHostFunctionManifestEntry[]
): Record<string, string> {
  const parameters = manifest.map(({ namespace }) => namespace).join(", ");
  return {
    "executor.js": RUN_DYNAMIC_WORKER_EXECUTOR_SOURCE,
    "run.js": createRunSourceModule(source, parameters)
  };
}
