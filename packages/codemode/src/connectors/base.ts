import { WorkerEntrypoint } from "cloudflare:workers";
import type { JSONSchema7 } from "json-schema";
import {
  generateTypesFromJsonSchema,
  type JsonSchemaToolDescriptors
} from "../json-schema-types";
import type { ConnectorDescription, ToolAnnotations } from "./types";

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
  execute: (args: unknown) => Promise<unknown> | unknown;
  /** Optional compensation for rollback: undo an applied call. */
  revert?: (args: unknown, result: unknown) => Promise<void> | void;
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

  async executeTool(method: string, args: unknown): Promise<unknown> {
    const tool = (await this.resolvedTools())[method];
    if (!tool) throw new Error(`Tool "${method}" not found on ${this.name()}`);
    return tool.execute(args);
  }

  async revertAction(
    method: string,
    args: unknown,
    result: unknown
  ): Promise<void> {
    const tool = (await this.resolvedTools())[method];
    await tool?.revert?.(args, result);
  }

  async getTypeScriptTypes(): Promise<string> {
    const { descriptors } = await this.describe();
    return generateTypesFromJsonSchema(descriptors).replace(
      "declare const codemode",
      `declare const ${this.name()}`
    );
  }
}
