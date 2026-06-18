/**
 * StateConnector — the `state.*` filesystem API as a codemode connector.
 *
 * Inside the sandbox the model calls `state.readFile({ path })`,
 * `state.applyEdits({ edits })`, etc. — every method takes a single object
 * argument (a deliberate break from the positional `ToolProvider` surface),
 * mapped to the backend's positional parameters via `STATE_METHODS`.
 *
 * Reads are marked `replay: "reexecute"`: their results (file contents,
 * listings, search hits) never enter the durable replay log; a resumed
 * execution re-reads the filesystem instead. Writes are logged and replayed
 * from the log. Binary arguments/results flow through codemode's codec.
 */
import {
  CodemodeConnector,
  type ConnectorTool,
  type ConnectorTools
} from "@cloudflare/codemode";
import {
  STATE_METHOD_NAMES,
  type StateBackend,
  type StateMethodName
} from "./backend";
import {
  STATE_METHODS,
  callStateMethod,
  paramNames,
  requiredParams
} from "./state-methods";
import { STATE_TYPES } from "./prompt";

// Parameters that are always strings get a real schema type; structured
// parameters (values, instruction lists, plans, options bags) stay open —
// the authoritative signatures come from STATE_TYPES, not these schemas.
const STRING_PARAMS = new Set([
  "path",
  "pattern",
  "src",
  "dest",
  "query",
  "search",
  "replacement",
  "target",
  "linkPath",
  "base",
  "destination",
  "pathA",
  "pathB",
  "newContent"
]);

type InputSchema = NonNullable<ConnectorTool["inputSchema"]>;

function inputSchemaFor(method: StateMethodName): InputSchema {
  const spec = STATE_METHODS[method];
  const properties: Record<string, InputSchema> = {};
  for (const name of paramNames(spec)) {
    properties[name] = STRING_PARAMS.has(name) ? { type: "string" } : {};
  }
  const required = requiredParams(spec);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {})
  };
}

export class StateConnector extends CodemodeConnector {
  #backend: StateBackend;

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    backend: StateBackend
  ) {
    super(ctx, {});
    this.#backend = backend;
  }

  override name(): string {
    return "state";
  }

  protected override instructions(): string {
    return [
      "A persistent virtual filesystem. Every method takes a single object",
      'argument: state.readFile({ path: "/notes.txt" }),',
      'state.writeFile({ path, content }), state.glob({ pattern: "src/**" }).',
      "For multi-file refactors prefer planEdits() + applyEditPlan(); for",
      "search-and-replace across a tree use replaceInFiles() — it is",
      "transactional by default."
    ].join(" ");
  }

  protected override tools(): ConnectorTools {
    const tools: ConnectorTools = {};
    for (const method of STATE_METHOD_NAMES) {
      if (typeof this.#backend[method] !== "function") continue;
      const spec = STATE_METHODS[method];
      tools[method] = {
        description: spec.description,
        inputSchema: inputSchemaFor(method),
        ...(spec.kind === "read" ? { replay: "reexecute" as const } : {}),
        execute: (args: unknown) => callStateMethod(this.#backend, method, args)
      };
    }
    return tools;
  }

  override async getTypeScriptTypes(): Promise<string> {
    return STATE_TYPES;
  }
}

/**
 * Create a `StateConnector` for `createCodemodeRuntime`.
 *
 * ```ts
 * import { stateConnector, createWorkspaceStateBackend } from "@cloudflare/shell";
 *
 * const runtime = createCodemodeRuntime({
 *   ctx: this.ctx,
 *   executor,
 *   connectors: [
 *     stateConnector(this.ctx, createWorkspaceStateBackend(this.workspace))
 *   ]
 * });
 * ```
 */
export function stateConnector(
  ctx: DurableObjectState | ExecutionContext,
  backend: StateBackend
): StateConnector {
  return new StateConnector(ctx, backend);
}
