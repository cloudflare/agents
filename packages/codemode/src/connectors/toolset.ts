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
import { sanitizeToolName } from "../utils";
import { CodemodeConnector, type ConnectorTools } from "./base";
import type { ToolAnnotations, ToolExecuteContext } from "./types";

type AIToolExecutionOptions = {
  toolCallId: string;
  messages: [];
  abortSignal?: AbortSignal;
  /** AI SDK 7 tool context. Code Mode does not currently supply one. */
  context?: undefined;
  /** AI SDK 6 tool context. Code Mode does not currently supply one. */
  experimental_context?: undefined;
};

type AIToolExecute = (
  args: unknown,
  options: AIToolExecutionOptions
) => unknown;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (typeof value !== "object" || value === null) return false;
  return (
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

/**
 * AI SDK tools may stream progressive snapshots. A Code Mode connector call
 * has one durable result, so consume the stream and retain its terminal value.
 */
async function terminalToolResult(value: unknown): Promise<unknown> {
  const resolved = await value;
  if (!isAsyncIterable(resolved)) return resolved;

  let terminal: unknown;
  for await (const snapshot of resolved) terminal = snapshot;
  return terminal;
}

function executionOptions(ctx?: ToolExecuteContext): AIToolExecutionOptions {
  const toolCallId =
    ctx?.callId ??
    (ctx?.seq !== undefined
      ? `${ctx.executionId}:${ctx.seq}`
      : `${ctx?.executionId ?? "codemode:direct"}:${crypto.randomUUID()}`);
  return {
    toolCallId,
    messages: [],
    ...(ctx?.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
    context: undefined,
    experimental_context: undefined
  };
}

function schemaOf(value: unknown): ReturnType<typeof asSchema> | undefined {
  return value == null
    ? undefined
    : asSchema(value as Parameters<typeof asSchema>[0]);
}

async function jsonSchemaOf(
  schema: ReturnType<typeof asSchema> | undefined
): Promise<JSONSchema7 | undefined> {
  return schema
    ? ((await schema.jsonSchema) as JSONSchema7 | undefined)
    : undefined;
}

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
  /**
   * Code Mode replay and approval policy keyed by the original ToolSet name.
   * Explicit `requiresApproval` values override the AI SDK tool's
   * `needsApproval` setting.
   */
  policies?: Record<string, ToolAnnotations>;
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

  protected override async tools(): Promise<ConnectorTools> {
    const out: ConnectorTools = {};
    const sources = new Map<string, string>();
    const executableTools = this.#executableTools();
    for (const policyName of Object.keys(this.#options.policies ?? {})) {
      if (!(policyName in executableTools)) {
        throw new Error(
          `Policy for unknown or non-executable tool "${policyName}" on ` +
            `${this.name()}. Policies use original ToolSet names.`
        );
      }
    }

    for (const [toolName, t] of Object.entries(executableTools)) {
      const execute = t.execute as AIToolExecute;

      const name = sanitizeToolName(toolName);
      const existing = sources.get(name);
      if (existing !== undefined) {
        throw new Error(
          `Tools "${existing}" and "${toolName}" on ${this.name()} both ` +
            `map to "${name}" — rename one of them.`
        );
      }
      sources.set(name, toolName);

      const rawInputSchema =
        "inputSchema" in t
          ? t.inputSchema
          : (t as Record<string, unknown>).parameters;
      const inputSchema = schemaOf(rawInputSchema);
      const outputSchema = schemaOf(
        "outputSchema" in t ? t.outputSchema : undefined
      );
      const [inputJsonSchema, outputJsonSchema] = await Promise.all([
        jsonSchemaOf(inputSchema),
        jsonSchemaOf(outputSchema)
      ]);

      // boolean `false` means no approval; `true` or a function (which can't
      // be pre-evaluated against sandbox args) gates the call behind the
      // runtime's durable pause/approve/resume flow.
      const needsApproval = (t as { needsApproval?: unknown }).needsApproval;
      const policy = this.#options.policies?.[toolName];
      const requiresApproval =
        policy?.requiresApproval ??
        (needsApproval !== undefined && needsApproval !== false);

      const run = (args: unknown, ctx?: ToolExecuteContext) =>
        terminalToolResult(execute(args, executionOptions(ctx)));

      out[name] = {
        description:
          typeof t.description === "function" ? undefined : t.description,
        inputSchema: inputJsonSchema,
        outputSchema: outputJsonSchema,
        ...(requiresApproval ? { requiresApproval: true } : {}),
        ...(policy?.replay ? { replay: policy.replay } : {}),
        execute: inputSchema?.validate
          ? async (args: unknown, ctx?: ToolExecuteContext) => {
              const result = await inputSchema.validate!(args);
              if (!result.success) throw result.error;
              return run(result.value, ctx);
            }
          : run
      };
    }
    return out;
  }
}

/** Convenience constructor mirroring `stateConnector` / `new BrowserConnector`. */
export function toolSetConnector(
  ctx: DurableObjectState | ExecutionContext,
  options: ToolSetConnectorOptions
): ToolSetConnector {
  return new ToolSetConnector(ctx, options);
}
