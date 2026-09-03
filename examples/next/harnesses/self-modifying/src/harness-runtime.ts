import { createWorker } from "@cloudflare/worker-bundler";
import type {
  HarnessHost,
  HarnessTurnInput,
  HarnessTurnResult
} from "./runtime-types";
import { SYSTEM_TOOL_DEFINITIONS } from "./system-tools";

const ENTRY_MODULE = "__self_modifying_entry.ts";
const CUSTOM_TOOLS_MODULE = "self-modifying:custom-tools";
const ENTRY_SOURCE = `import { WorkerEntrypoint } from "cloudflare:workers";
import harness from "./src/index";

function requireHarness() {
  if (!harness || typeof harness !== "object") {
    throw new Error("src/index.ts must default-export a harness object");
  }
  if (!harness.manifest || typeof harness.manifest.name !== "string" ||
      typeof harness.manifest.version !== "string") {
    throw new Error("the harness must expose manifest.name and manifest.version");
  }
  if (typeof harness.runTurn !== "function") {
    throw new Error("the harness must expose runTurn(input, host)");
  }
  return harness;
}

export default class SelfModifyingTurnEntrypoint extends WorkerEntrypoint {
  check() {
    const value = requireHarness();
    return { name: value.manifest.name, version: value.manifest.version };
  }

  run(input, host) {
    return requireHarness().runTurn(input, host);
  }
}
`;

/** A candidate source tree that compiled into Dynamic Worker modules. */
export type CompiledHarness = {
  readonly sourceHash: string;
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly manifest: {
    readonly name: string;
    readonly version: string;
  };
};

/** A candidate source tree that cannot be activated. */
export class HarnessBuildError extends Error {
  readonly _tag = "HarnessBuildError" as const;

  /** Record the stable activation phase and original failure. */
  constructor(
    readonly phase: "source" | "bundle" | "check",
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
  }
}

function disposeQuietly(resource: unknown): void {
  if (
    typeof resource !== "object" ||
    resource === null ||
    !(Symbol.dispose in resource)
  ) {
    return;
  }
  // SAFETY: The branch above proves resource is an object carrying this
  // symbol. The value remains unknown until the function check below.
  const dispose = (resource as { [Symbol.dispose]?: unknown })[Symbol.dispose];
  if (typeof dispose !== "function") return;
  try {
    dispose.call(resource);
  } catch {
    // Cleanup must not hide the build or turn result.
  }
}

function canonicalSource(source: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.entries(source).sort(([left], [right]) => left.localeCompare(right))
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stringModules(
  modules: Readonly<Record<string, string | object>>
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, module] of Object.entries(modules)) {
    if (typeof module !== "string") {
      throw new HarnessBuildError(
        "bundle",
        `Harness bundle produced unsupported non-JavaScript module ${JSON.stringify(name)}`
      );
    }
    result[name] = module;
  }
  return result;
}

function parseManifest(value: unknown): CompiledHarness["manifest"] {
  if (typeof value !== "object" || value === null) {
    throw new HarnessBuildError("check", "Harness check returned no manifest");
  }
  // SAFETY: The branch above narrowed the Dynamic Worker result to a
  // non-null, non-array object. Each consumed field is parsed below.
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || typeof record.version !== "string") {
    throw new HarnessBuildError(
      "check",
      "Harness check did not return string name and version fields"
    );
  }
  return { name: record.name, version: record.version };
}

function customToolRegistrySource(
  source: Readonly<Record<string, string>>
): string {
  const toolFiles = Object.keys(source)
    .filter(
      (path) =>
        path.startsWith("src/tools/") &&
        path.endsWith(".ts") &&
        !path.endsWith(".d.ts")
    )
    .sort();
  const imports = toolFiles.map(
    (path, index) =>
      `import * as customModule${index} from ${JSON.stringify(`./${path.slice(0, -3)}`)};`
  );
  const modules = toolFiles
    .map((_, index) => `customModule${index}`)
    .join(", ");
  const systemToolNames = SYSTEM_TOOL_DEFINITIONS.map(
    (definition) => definition.name
  );
  return `${imports.join("\n")}

const modules = [${modules}];
const systemToolNames = new Set(${JSON.stringify(systemToolNames)});
const seenObjects = new Set();
const customTools = [];
const customToolNames = new Set();

for (const module of modules) {
  let found = false;
  for (const candidate of Object.values(module)) {
    if (!candidate || typeof candidate !== "object" || seenObjects.has(candidate)) continue;
    const definition = candidate.definition;
    if (!definition || typeof definition !== "object" || typeof definition.name !== "string" ||
        typeof definition.description !== "string" || !definition.inputSchema ||
        typeof definition.inputSchema !== "object" || typeof candidate.execute !== "function") continue;
    found = true;
    seenObjects.add(candidate);
    if (systemToolNames.has(definition.name)) {
      throw new Error("Custom tool " + JSON.stringify(definition.name) + " conflicts with a System tool");
    }
    if (customToolNames.has(definition.name)) {
      throw new Error("Duplicate Custom tool " + JSON.stringify(definition.name));
    }
    customToolNames.add(definition.name);
    customTools.push(candidate);
  }
  if (!found) throw new Error("Every src/tools/*.ts module must export a CustomTool");
}

export const CUSTOM_TOOL_DEFINITIONS = customTools.map((tool) => tool.definition);

export async function runCustomTool(call, turn, host) {
  const tool = customTools.find((candidate) => candidate.definition.name === call.name);
  return tool ? tool.execute(call.input, turn, host) : undefined;
}
`;
}

/** Compile, isolate, and validate one editable harness source snapshot. */
export async function compileHarness(
  loader: WorkerLoader,
  source: Readonly<Record<string, string>>
): Promise<CompiledHarness> {
  if (!("src/index.ts" in source)) {
    throw new HarnessBuildError(
      "source",
      "Working source must contain /harness/src/index.ts"
    );
  }

  let bundled;
  try {
    bundled = await createWorker({
      files: { ...source, [ENTRY_MODULE]: ENTRY_SOURCE },
      entryPoint: ENTRY_MODULE,
      target: "es2022",
      minify: false,
      sourcemap: true,
      virtualModules: {
        [CUSTOM_TOOLS_MODULE]: customToolRegistrySource(source)
      }
    });
  } catch (cause) {
    throw new HarnessBuildError(
      "bundle",
      cause instanceof Error ? cause.message : String(cause),
      cause
    );
  }

  const modules = stringModules(bundled.modules);
  const worker = loader.load({
    compatibilityDate: "2026-06-11",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: bundled.mainModule,
    modules,
    globalOutbound: null,
    limits: { cpuMs: 1000, subRequests: 8 }
  });

  try {
    // SAFETY: ENTRY_SOURCE defines the default WorkerEntrypoint and its
    // check method. The result is still parsed as unknown below.
    const entrypoint = worker.getEntrypoint() as unknown as {
      check(): Promise<unknown>;
    };
    try {
      const manifest = parseManifest(await entrypoint.check());
      return {
        sourceHash: await sha256(canonicalSource(source)),
        mainModule: bundled.mainModule,
        modules,
        manifest
      };
    } catch (cause) {
      if (cause instanceof HarnessBuildError) throw cause;
      throw new HarnessBuildError(
        "check",
        cause instanceof Error ? cause.message : String(cause),
        cause
      );
    } finally {
      disposeQuietly(entrypoint);
    }
  } finally {
    disposeQuietly(worker);
  }
}

function parseTurnResult(value: unknown): HarnessTurnResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Editable harness result must be an object");
  }
  // SAFETY: The runtime checks the dynamic value is a non-null object before
  // reading fields, then parses every field used by trusted code below.
  const record = value as Record<string, unknown>;
  if (
    typeof record.output !== "string" ||
    typeof record.rounds !== "number" ||
    !Number.isSafeInteger(record.rounds) ||
    typeof record.isolateRun !== "number" ||
    !Number.isSafeInteger(record.isolateRun)
  ) {
    throw new Error(
      "Editable harness result must contain output, integer rounds, and integer isolateRun"
    );
  }
  const metadata = record.metadata;
  if (
    metadata !== undefined &&
    (typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata))
  ) {
    throw new Error("Editable harness result metadata must be a JSON object");
  }
  return {
    output: record.output,
    rounds: record.rounds,
    isolateRun: record.isolateRun,
    ...(metadata === undefined
      ? {}
      : {
          // SAFETY: The branch above narrowed metadata to a non-null,
          // non-array object received through Workers RPC's structured clone.
          metadata: metadata as HarnessTurnResult["metadata"]
        })
  };
}

/** Run one turn in a fresh Dynamic Worker loaded from its pinned revision. */
export async function runHarnessTurn(input: {
  readonly loader: WorkerLoader;
  readonly mainModule: string;
  readonly modules: Readonly<Record<string, string>>;
  readonly turn: HarnessTurnInput;
  readonly host: HarnessHost;
}): Promise<HarnessTurnResult> {
  const worker = input.loader.load({
    compatibilityDate: "2026-06-11",
    compatibilityFlags: ["nodejs_compat"],
    mainModule: input.mainModule,
    modules: input.modules,
    globalOutbound: null,
    limits: { cpuMs: 5000, subRequests: 64 }
  });

  try {
    // SAFETY: Every persisted build came from ENTRY_SOURCE, which defines
    // this run method. Its dynamic return value is parsed before use.
    const entrypoint = worker.getEntrypoint() as unknown as {
      run(turn: HarnessTurnInput, host: HarnessHost): Promise<unknown>;
    };
    try {
      return parseTurnResult(await entrypoint.run(input.turn, input.host));
    } finally {
      disposeQuietly(entrypoint);
    }
  } finally {
    disposeQuietly(worker);
  }
}
