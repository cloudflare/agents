import { parse } from "acorn";
import type { RunHostFunctionManifestEntry } from "./dynamic-worker-protocol";
import dynamicWorkerRuntimeSource from "./dynamic-worker-runtime?dynamic-worker-source";

const RUN_DYNAMIC_WORKER_EXECUTOR_SOURCE =
  'import __runUser__ from "./run.js";\n' + dynamicWorkerRuntimeSource;

function createRunSourceModule(source: string, parameters: string): string {
  const prefix = `export default async function __runUser__(${parameters}) {`;
  const moduleSource = `${prefix}\n${source}\n}`;

  const program = parse(moduleSource, {
    ecmaVersion: "latest",
    sourceType: "module"
  });
  const [statement] = program.body;
  const declaration =
    statement?.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : undefined;
  const runFunction =
    declaration?.type === "FunctionDeclaration" ? declaration : undefined;
  if (
    program.body.length !== 1 ||
    !runFunction?.async ||
    runFunction.generator ||
    runFunction.body.start !== prefix.length - 1 ||
    runFunction.body.end !== moduleSource.length
  ) {
    throw new SyntaxError("Run source must be an async function body.");
  }

  return moduleSource;
}

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
