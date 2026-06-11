/**
 * ToolSetConnector — adapt an AI SDK `ToolSet` to the connector model.
 *
 * Each tool in the set becomes one connector tool under a single namespace
 * (default `"tools"`). Tools with `needsApproval` are stripped, matching the
 * historical `filterTools` behavior of the non-runtime code tool: an AI SDK
 * approval has no resume path inside the sandbox. Mark approval-gated work
 * with `requiresApproval` on a hand-written connector tool instead, which
 * gets the runtime's durable pause/approve/resume flow.
 *
 * Lives in the `/ai` entry because schema handling (`asSchema`) needs the
 * `ai` peer dependency.
 */
import { asSchema } from "ai";
import type { ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
import { filterTools } from "../resolve";
import { generateTypes } from "../tool-types";
import { sanitizeToolName } from "../utils";
import { CodemodeConnector, type ConnectorTools } from "./base";

export interface ToolSetConnectorOptions {
  /**
   * The namespace the sandbox sees, e.g. `"tools"` → `tools.getWeather(...)`.
   * Defaults to `"tools"`. (`"codemode"` is reserved for the platform SDK.)
   */
  name?: string;
  /** Extra model guidance, surfaced with the connector's type block. */
  instructions?: string;
  /** The AI SDK tools to expose. */
  tools: ToolSet;
}

export class ToolSetConnector extends CodemodeConnector {
  #options: ToolSetConnectorOptions;
  #filtered: ToolSet;

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    options: ToolSetConnectorOptions
  ) {
    super(ctx, {});
    this.#options = options;
    this.#filtered = filterTools(options.tools) as ToolSet;
  }

  override name(): string {
    return this.#options.name ?? "tools";
  }

  protected override instructions(): string | undefined {
    return this.#options.instructions;
  }

  protected override tools(): ConnectorTools {
    const out: ConnectorTools = {};
    const sources = new Map<string, string>();
    for (const [toolName, t] of Object.entries(this.#filtered)) {
      const execute =
        "execute" in t
          ? (t.execute as (args: unknown) => Promise<unknown>)
          : undefined;
      if (!execute) continue;

      const name = sanitizeToolName(toolName);
      const existing = sources.get(name);
      if (existing !== undefined) {
        throw new Error(
          `Tools "${existing}" and "${toolName}" on ${this.name()} both ` +
            `map to "${name}" — rename one of them.`
        );
      }
      sources.set(name, toolName);

      const rawSchema =
        "inputSchema" in t
          ? t.inputSchema
          : (t as Record<string, unknown>).parameters;
      const schema =
        rawSchema != null
          ? asSchema(rawSchema as Parameters<typeof asSchema>[0])
          : undefined;

      out[name] = {
        description: t.description,
        inputSchema: schema?.jsonSchema as JSONSchema7 | undefined,
        execute: schema?.validate
          ? async (args: unknown) => {
              const result = await schema.validate!(args);
              if (!result.success) throw result.error;
              return execute(result.value);
            }
          : (args: unknown) => execute(args)
      };
    }
    return out;
  }

  /**
   * Generate the sandbox type block from the original AI SDK schemas (Zod or
   * `jsonSchema()` wrappers) rather than the converted JSON Schema, preserving
   * field descriptions as `@param` lines.
   */
  override async getTypeScriptTypes(): Promise<string> {
    return generateTypes(this.#filtered, this.name());
  }
}

/** Convenience constructor mirroring `stateConnector` / `new BrowserConnector`. */
export function toolSetConnector(
  ctx: DurableObjectState | ExecutionContext,
  options: ToolSetConnectorOptions
): ToolSetConnector {
  return new ToolSetConnector(ctx, options);
}
