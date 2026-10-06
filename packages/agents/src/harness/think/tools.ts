/**
 * The harness runs server tools itself, one durable call at a time, so the
 * model is only ever offered tool definitions: no `execute`, no
 * `needsApproval`. That way the AI SDK ends each model call at its tool
 * calls, and the harness decides how to run, approve, or recover each one.
 */
import type { ModelMessage, Tool, ToolSet } from "ai";

/** The model-facing copy of a tool set, restricted to `activeTools` if given. */
export function modelTools(
  tools: ToolSet,
  activeTools: readonly string[] | undefined
): ToolSet {
  const active = activeTools ? new Set(activeTools) : undefined;
  const offered: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (active && !active.has(name)) continue;
    if (tool.type === "provider") {
      offered[name] = tool;
      continue;
    }
    const {
      execute: _execute,
      needsApproval: _needsApproval,
      ...definition
    } = tool;
    // SAFETY: a tool without `execute` and `needsApproval` is still a tool
    // of the same kind; both fields are optional on every Tool variant.
    offered[name] = definition as ToolSet[string];
  }
  return offered;
}

/** Whether the harness runs this tool, as opposed to a client or provider. */
export function isServerTool(tools: ToolSet, name: string): boolean {
  const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
  return (
    tool !== undefined &&
    tool.type !== "provider" &&
    typeof tool.execute === "function"
  );
}

/** Whether a tool's own `needsApproval` asks for approval of this call. */
export async function toolNeedsApproval(
  tool: Tool,
  input: unknown,
  options: { readonly toolCallId: string; readonly messages: ModelMessage[] }
): Promise<boolean> {
  const needsApproval = tool.needsApproval;
  if (typeof needsApproval === "function") {
    return Boolean(
      await needsApproval(input, { ...options, context: undefined })
    );
  }
  return needsApproval === true;
}

/** A tool call's outcome. */
export type ToolOutcome =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly errorText: string };

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

/**
 * Run one tool's `execute`. A streaming tool's outputs before its last are
 * reported to `onPreliminary`; its last output is the result.
 */
export async function executeTool(
  tool: Tool,
  input: unknown,
  options: {
    readonly toolCallId: string;
    readonly messages: ModelMessage[];
    readonly abortSignal: AbortSignal;
    readonly onPreliminary: (output: unknown) => void;
  }
): Promise<ToolOutcome> {
  const execute = tool.execute;
  if (typeof execute !== "function") {
    return { ok: false, errorText: "The tool has no execute function" };
  }
  try {
    const result: unknown = await execute(input, {
      toolCallId: options.toolCallId,
      messages: options.messages,
      abortSignal: options.abortSignal,
      context: undefined
    });
    if (!isAsyncIterable(result)) return { ok: true, output: result };
    let last: unknown;
    let seen = false;
    for await (const output of result) {
      if (seen) options.onPreliminary(last);
      last = output;
      seen = true;
    }
    return { ok: true, output: last };
  } catch (error) {
    return {
      ok: false,
      errorText: error instanceof Error ? error.message : String(error)
    };
  }
}
