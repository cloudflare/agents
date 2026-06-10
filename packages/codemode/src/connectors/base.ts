import { WorkerEntrypoint } from "cloudflare:workers";
import type { JSONSchema7 } from "json-schema";
import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors
} from "../json-schema-types";
import type {
  ConnectorDescription,
  ExecutionEndStatus,
  ToolAnnotations,
  ToolExecuteContext
} from "./types";

/**
 * A single connector tool — everything about it in one place: docs, schema,
 * approval requirement, execution, and (optionally) how to undo it.
 *
 * AI SDK tools are shape-compatible: a `ToolSet` can be returned from
 * `tools()` directly.
 */
export type ConnectorTool = {
  description?: string;
  /** JSON Schema for the tool input. Defaults to an open object. */
  inputSchema?: JSONSchema7;
  outputSchema?: JSONSchema7;
  /** Pause for user approval before executing. Omit to execute immediately. */
  requiresApproval?: boolean;
  execute: (
    args: unknown,
    ctx?: ToolExecuteContext
  ) => Promise<unknown> | unknown;
  /** Optional compensation for rollback: undo an applied call. */
  revert?: (
    args: unknown,
    result: unknown,
    ctx?: ToolExecuteContext
  ) => Promise<void> | void;
};

export type ConnectorTools = Record<string, ConnectorTool>;

// AI SDK v4 tools carry the schema as `parameters`; v5 as `inputSchema`
// (possibly a zod schema rather than JSON Schema). Use whichever looks like
// JSON Schema; fall back to an open object.
function toolInputSchema(t: ConnectorTool): JSONSchema7 {
  const loose = t as { inputSchema?: unknown; parameters?: unknown };
  for (const candidate of [loose.inputSchema, loose.parameters]) {
    if (
      candidate &&
      typeof candidate === "object" &&
      ("type" in candidate || "properties" in candidate || "$ref" in candidate)
    ) {
      return candidate as JSONSchema7;
    }
  }
  return { type: "object" };
}

/**
 * Base class for codemode connectors.
 *
 * A connector answers three questions: what global name does the model use
 * (`name`), what guidance does the model get (`instructions`), and what tools
 * exist (`tools` — each tool carries its own docs, schema, approval
 * requirement, execution, and optional revert).
 *
 * The RPC surface (`describe`, `executeTool`, `revertAction`,
 * `getTypeScriptTypes`) is wire plumbing derived from the tools record — the
 * proxy tool calls it; connector authors don't implement it.
 */
export abstract class CodemodeConnector<
  Env = unknown,
  Props = unknown
> extends WorkerEntrypoint<Env, Props> {
  /**
   * Connectors are used in-process by the runtime (their `name()`, `describe()`,
   * and `executeTool()` are called directly), so they're constructed with `new`
   * — typically from inside an Agent / Durable Object.
   *
   * Inside a Durable Object `this.ctx` is a `DurableObjectState`, not an
   * `ExecutionContext`. The base `WorkerEntrypoint` constructor only stores it,
   * so we widen the parameter to accept either — pass `this.ctx` directly with
   * no cast:
   *
   * ```ts
   * const github = new GithubConnector(this.ctx, this.env, conn);
   * ```
   */
  constructor(ctx: DurableObjectState | ExecutionContext, env: Env) {
    super(ctx as ExecutionContext, env);
  }

  abstract name(): string;

  protected instructions(): string | undefined {
    return undefined;
  }

  /**
   * The single authoring surface: one record, one entry per tool.
   * Derived connectors (MCP, OpenAPI) generate this for you.
   */
  protected abstract tools(): ConnectorTools | Promise<ConnectorTools>;

  /**
   * Decoration hook, called once per tool. Override to adjust tools you
   * didn't author inline — e.g. mark a derived MCP tool as requiring
   * approval, or attach a revert:
   *
   * ```ts
   * protected tool(name: string, t: ConnectorTool): ConnectorTool {
   *   if (name === "create_issue") {
   *     return { ...t, requiresApproval: true };
   *   }
   *   return t;
   * }
   * ```
   */
  protected tool(_name: string, t: ConnectorTool): ConnectorTool {
    return t;
  }

  #toolsPromise?: Promise<ConnectorTools>;

  protected resolvedTools(): Promise<ConnectorTools> {
    return (this.#toolsPromise ??= (async () => {
      const tools = await this.tools();
      const out: ConnectorTools = {};
      for (const [name, t] of Object.entries(tools)) {
        if (!t || typeof t !== "object") continue;
        out[name] = this.tool(name, t);
      }
      return out;
    })());
  }

  // -------------------------------------------------------------------------
  // RPC surface — derived from the tools record, called by the proxy tool.
  // -------------------------------------------------------------------------

  async describe(): Promise<ConnectorDescription> {
    const tools = await this.resolvedTools();
    const descriptors: JsonSchemaToolDescriptors = {};
    const annotations: Record<string, ToolAnnotations> = {};
    for (const [name, t] of Object.entries(tools)) {
      descriptors[name] = {
        description: t.description,
        inputSchema: toolInputSchema(t),
        outputSchema: t.outputSchema
      };
      if (t.requiresApproval) {
        annotations[name] = { requiresApproval: true };
      }
    }
    return {
      name: this.name(),
      instructions: this.instructions(),
      descriptors,
      annotations
    };
  }

  async executeTool(
    method: string,
    args: unknown,
    ctx?: ToolExecuteContext
  ): Promise<unknown> {
    const tool = (await this.resolvedTools())[method];
    if (!tool) throw new Error(`Tool "${method}" not found on ${this.name()}`);
    return tool.execute(args, ctx);
  }

  /**
   * Revert an applied action. Returns whether a revert actually ran — reads and
   * tools without a `revert` are a no-op and return `false`, so the runtime can
   * mark only the entries it truly reverted.
   */
  async revertAction(
    method: string,
    args: unknown,
    result: unknown,
    ctx?: ToolExecuteContext
  ): Promise<boolean> {
    const tool = (await this.resolvedTools())[method];
    if (!tool?.revert) return false;
    await tool.revert(args, result, ctx);
    return true;
  }

  /**
   * Called once when a codemode execution reaches a terminal state — completed,
   * errored, rejected, or rolled back — and will not resume. Override to tear
   * down any per-execution resource this connector opened for that run, keyed
   * by `executionId` (e.g. close a browser/CDP session).
   *
   * It is deliberately *not* called when a run pauses for approval: a paused
   * run may resume later, possibly in a fresh Worker invocation, so a resource
   * scoped to the whole run must outlive a pause. This hook is the single point
   * where teardown is safe.
   *
   * Contract for implementers:
   * - Be idempotent. It may fire more than once for the same execution (a
   *   completed run that is later rolled back) and a no-op is expected the
   *   second time.
   * - Don't rely on instance memory. It may run on a different connector
   *   instance than the one that opened the resource (the host can reconstruct
   *   connectors per request, and the opening pass may have hibernated), so
   *   read what you need from durable storage keyed by `executionId`.
   * - Don't throw. Teardown failures must not turn a finished run into a
   *   failure; the runtime ignores rejections from this hook.
   *
   * The default is a no-op, so connectors that own no per-execution state
   * don't implement it.
   */
  async disposeExecution(
    _executionId: string,
    _status: ExecutionEndStatus
  ): Promise<void> {}

  async getTypeScriptTypes(): Promise<string> {
    const { descriptors } = await this.describe();
    return generateTypesFromJsonSchema(descriptors).replace(
      "declare const codemode",
      `declare const ${this.name()}`
    );
  }
}
