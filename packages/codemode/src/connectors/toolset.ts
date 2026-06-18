/**
 * ToolSetConnector — adapt an AI SDK `ToolSet` to the connector model.
 *
 * Each tool in the set becomes one connector tool under a single namespace
 * (default `"tools"`). Tools with `needsApproval` map to `requiresApproval`:
 * calling one pauses the run durably until the host approves
 * (`runtime.approve()`), then the run resumes where it stopped — the
 * runtime's pause/approve/resume flow, not the AI SDK's per-call approval.
 * A function-valued `needsApproval` cannot be evaluated against sandbox
 * arguments ahead of time, so it conservatively always requires approval.
 *
 * Lives in the `/ai` entry because schema handling (`asSchema`) needs the
 * `ai` peer dependency.
 */
import { asSchema } from "ai";
import type { ToolSet } from "ai";
import type { JSONSchema7 } from "json-schema";
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
  #warnedSkipped = false;

  constructor(
    ctx: DurableObjectState | ExecutionContext,
    options: ToolSetConnectorOptions
  ) {
    super(ctx, {});
    this.#options = options;
  }

  /**
   * Only tools with an `execute` function can run inside the sandbox.
   * Execute-less tools (client-side / provider-executed) are excluded from
   * both the runtime bindings and the generated types — advertising a method
   * the sandbox can't call would send the model down a dead end.
   */
  #executableTools(): ToolSet {
    const executable: ToolSet = {};
    const skipped: string[] = [];
    for (const [toolName, t] of Object.entries(this.#options.tools)) {
      if ("execute" in t && typeof t.execute === "function") {
        executable[toolName] = t;
      } else {
        skipped.push(toolName);
      }
    }
    if (skipped.length > 0 && !this.#warnedSkipped) {
      this.#warnedSkipped = true;
      console.warn(
        `[codemode] ToolSetConnector "${this.name()}" skipped tools without ` +
          `an execute function (client-side or provider-executed): ` +
          `${skipped.join(", ")}. They are not callable from sandboxed code.`
      );
    }
    return executable;
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
    for (const [toolName, t] of Object.entries(this.#executableTools())) {
      const execute = t.execute as (args: unknown) => Promise<unknown>;

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

      // boolean `false` means no approval; `true` or a function (which can't
      // be pre-evaluated against sandbox args) gates the call behind the
      // runtime's durable pause/approve/resume flow.
      const needsApproval = (t as { needsApproval?: unknown }).needsApproval;
      const requiresApproval =
        needsApproval !== undefined && needsApproval !== false;

      out[name] = {
        description: t.description,
        inputSchema: schema?.jsonSchema as JSONSchema7 | undefined,
        ...(requiresApproval ? { requiresApproval: true } : {}),
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
   * field descriptions as `@param` lines. Restricted to the same executable
   * subset that `tools()` exposes, so the types never advertise a method the
   * sandbox can't call.
   */
  override async getTypeScriptTypes(): Promise<string> {
    return generateTypes(this.#executableTools(), this.name());
  }
}

/** Convenience constructor mirroring `stateConnector` / `new BrowserConnector`. */
export function toolSetConnector(
  ctx: DurableObjectState | ExecutionContext,
  options: ToolSetConnectorOptions
): ToolSetConnector {
  return new ToolSetConnector(ctx, options);
}
