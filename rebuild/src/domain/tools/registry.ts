import { z } from "zod";
import { AbortedError, ValidationError, toErrorValue, type ErrorValue } from "../../kernel/errors.js";
import type { Clock } from "../../ports/clock.js";
import type { ChatMessage } from "../messages/model.js";
import { toDescriptor, type Tool, type ToolDescriptor, type ToolExecutionContext, type ToolSet } from "./types.js";

// ---------------------------------------------------------------------------
// Hook types (audit 08 §2)
// ---------------------------------------------------------------------------

export interface ToolCallDecision {
  action: "allow" | "block" | "substitute";
  input?: unknown;
  output?: unknown;
  reason?: string;
}

export interface BeforeToolCallContext {
  toolName: string;
  toolCallId: string;
  input: unknown;
  stepNumber: number;
  messages: ReadonlyArray<ChatMessage>;
  signal: AbortSignal;
}

export type AfterToolCallContext = {
  toolName: string;
  toolCallId: string;
  input: unknown;
  stepNumber: number;
  durationMs: number;
} & ({ success: true; output: unknown } | { success: false; error: ErrorValue });

export interface ToolHooks {
  beforeToolCall?: (
    ctx: BeforeToolCallContext
  ) => void | ToolCallDecision | Promise<void | ToolCallDecision>;
  afterToolCall?: (ctx: AfterToolCallContext) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface ToolSources {
  builtin?: ToolSet;
  external?: ToolSet;
  actions?: ToolSet;
  user?: ToolSet;
  client?: ToolSet;
}

export interface AssembleToolsOptions {
  hooks?: ToolHooks;
  filter?: (all: ToolSet) => ToolSet;
  clock: Clock;
}

export interface AssembledTools {
  /** Wrapped tools (post-merge, post-filter): hook-wrapped, validated execute. */
  tools: ToolSet;
  descriptors(activeTools?: string[]): ToolDescriptor[];
  execute(name: string, input: unknown, ctx: ToolExecutionContext): Promise<{ output: unknown; isError: boolean }>;
  isClientTool(name: string): boolean;
  needsApproval(name: string, input: unknown): Promise<boolean>;
  capabilityBlock(): string;
}

/**
 * An execution context extended with the turn loop's step number. The public
 * ToolExecutionContext (domain/tools/types.ts) intentionally doesn't carry
 * this — it's a detail of hook bookkeeping, not of what a tool's `execute`
 * needs. Callers that have a step number (the turn loop) may include it on
 * the ctx object they pass in; TS's structural typing lets that pass through
 * a `ToolExecutionContext`-typed parameter without complaint. When absent, 0
 * is used.
 */
type CtxWithStep = ToolExecutionContext & { stepNumber?: number };

export function assembleTools(sources: ToolSources, options: AssembleToolsOptions): AssembledTools {
  const merged = mergeSources(sources);
  const filtered = applyFilter(merged, options.filter);

  const wrapped: ToolSet = {};
  for (const [name, original] of Object.entries(filtered)) {
    wrapped[name] = wrapTool(name, original, options.hooks, options.clock);
  }

  return {
    tools: wrapped,

    descriptors(activeTools?: string[]): ToolDescriptor[] {
      const active = activeTools ? new Set(activeTools) : undefined;
      const names = Object.keys(wrapped).filter((name) => !active || active.has(name));
      return names.map((name) => toDescriptor(name, wrapped[name]!));
    },

    async execute(name, input, ctx) {
      const original = filtered[name];
      if (!original) {
        return {
          output: { error: { name: "ToolNotFoundError", message: `unknown tool: ${name}` } },
          isError: true,
        };
      }
      return runTool(name, original, input, ctx, options.hooks, options.clock);
    },

    isClientTool(name: string): boolean {
      const t = filtered[name];
      return t !== undefined && t.execute === undefined;
    },

    async needsApproval(name: string, input: unknown): Promise<boolean> {
      const t = filtered[name];
      if (!t || t.needsApproval === undefined) return false;
      if (typeof t.needsApproval === "function") {
        return await t.needsApproval(input);
      }
      return t.needsApproval;
    },

    capabilityBlock(): string {
      return buildCapabilityBlock(wrapped);
    },
  };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge precedence: builtin < external < actions < user, each later source
 * overriding same-named tools from earlier ones. Client tools are then added
 * only where they don't collide with any server-sourced name — a colliding
 * client tool is silently dropped and the server tool wins (doc 08 §2).
 */
function mergeSources(sources: ToolSources): ToolSet {
  const merged: ToolSet = {};
  for (const src of [sources.builtin, sources.external, sources.actions, sources.user]) {
    if (!src) continue;
    for (const [name, t] of Object.entries(src)) {
      merged[name] = t;
    }
  }
  if (sources.client) {
    for (const [name, t] of Object.entries(sources.client)) {
      if (name in merged) continue; // dropped: collides with a server tool
      merged[name] = t;
    }
  }
  return merged;
}

function applyFilter(merged: ToolSet, filter?: (all: ToolSet) => ToolSet): ToolSet {
  if (!filter) return merged;
  const result = filter(merged);
  for (const name of Object.keys(result)) {
    if (!(name in merged)) {
      throw new ValidationError(`tool filter is remove-only: "${name}" is not in the merged tool set`);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Wrapping & execution
// ---------------------------------------------------------------------------

function wrapTool(name: string, original: Tool, hooks: ToolHooks | undefined, clock: Clock): Tool {
  if (!original.execute) {
    // Client tool: no server-side execute to wrap.
    return { ...original };
  }
  return {
    ...original,
    async execute(input: unknown, ctx: ToolExecutionContext) {
      const { output } = await runTool(name, original, input, ctx, hooks, clock);
      return output;
    },
  };
}

async function runTool(
  name: string,
  original: Tool,
  input: unknown,
  ctx: ToolExecutionContext,
  hooks: ToolHooks | undefined,
  clock: Clock
): Promise<{ output: unknown; isError: boolean }> {
  const stepNumber = (ctx as CtxWithStep).stepNumber ?? 0;
  const toolCallId = ctx.toolCallId;

  let decision: ToolCallDecision | undefined;
  if (hooks?.beforeToolCall) {
    decision =
      (await hooks.beforeToolCall({
        toolName: name,
        toolCallId,
        input,
        stepNumber,
        messages: ctx.messages,
        signal: ctx.signal,
      })) ?? undefined;
  }

  if (decision?.action === "block") {
    return { output: { blocked: true, reason: decision.reason }, isError: false };
  }
  if (decision?.action === "substitute") {
    return { output: decision.output, isError: false };
  }

  const effectiveInput = decision?.action === "allow" && decision.input !== undefined ? decision.input : input;

  if (!original.execute) {
    // Should not happen — wrapTool only wraps tools with execute — but guard
    // defensively since AssembledTools.execute() can also be called for any
    // registered name.
    return { output: { error: { name: "ToolNotFoundError", message: `"${name}" has no server execute` } }, isError: true };
  }

  const validated = validateInput(original.inputSchema, effectiveInput);
  if (!validated.ok) {
    return { output: { error: validated.error }, isError: true };
  }

  const start = clock.now();
  try {
    const output = await original.execute(validated.value, ctx);
    const durationMs = clock.now() - start;
    if (hooks?.afterToolCall) {
      await hooks.afterToolCall({
        toolName: name,
        toolCallId,
        input: effectiveInput,
        stepNumber,
        durationMs,
        success: true,
        output,
      });
    }
    return { output, isError: false };
  } catch (err) {
    if (err instanceof AbortedError) {
      throw err;
    }
    const durationMs = clock.now() - start;
    const errorValue = toErrorValue(err);
    if (hooks?.afterToolCall) {
      await hooks.afterToolCall({
        toolName: name,
        toolCallId,
        input: effectiveInput,
        stepNumber,
        durationMs,
        success: false,
        error: errorValue,
      });
    }
    return { output: { error: errorValue }, isError: true };
  }
}

function validateInput(
  schema: Tool["inputSchema"],
  input: unknown
): { ok: true; value: unknown } | { ok: false; error: ErrorValue } {
  if (schema instanceof z.ZodType) {
    const result = schema.safeParse(input);
    if (!result.success) {
      return { ok: false, error: { name: "ToolInputValidationError", message: result.error.message } };
    }
    return { ok: true, value: result.data };
  }
  // { jsonSchema } passthrough form: no validator available (no new deps);
  // pass the input through unvalidated.
  return { ok: true, value: input };
}

// ---------------------------------------------------------------------------
// Capability prompt block
// ---------------------------------------------------------------------------

const CAPABILITY_ORDER = ["workspace", "skills", "execution", "external", "delegation", "client"] as const;

function buildCapabilityBlock(tools: ToolSet): string {
  const groups = new Map<string, string[]>();
  for (const [name, t] of Object.entries(tools)) {
    const capability = t.metadata?.capability;
    if (typeof capability !== "string" || capability.length === 0) continue;
    const list = groups.get(capability);
    if (list) {
      list.push(name);
    } else {
      groups.set(capability, [name]);
    }
  }
  if (groups.size === 0) return "";

  const known = CAPABILITY_ORDER.filter((c) => groups.has(c));
  const rest = [...groups.keys()].filter((c) => !(CAPABILITY_ORDER as readonly string[]).includes(c)).sort();
  const orderedCapabilities: string[] = [...known, ...rest];

  const lines = orderedCapabilities.map((capability) => {
    const names = [...groups.get(capability)!].sort();
    return `- ${capability}: ${names.join(", ")}`;
  });

  return ["Available tool capabilities:", ...lines].join("\n");
}
