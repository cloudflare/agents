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
    // A tool's `recovery` field is the harness's, not the model's.
    if ("recovery" in definition) delete definition.recovery;
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
    const returned: unknown = execute(input, {
      toolCallId: options.toolCallId,
      messages: options.messages,
      abortSignal: options.abortSignal,
      context: undefined
    });
    // As in the AI SDK: what `execute` returns as an async iterable streams;
    // a promise of one is its last value, with no progress. An extension's
    // tool resolves to its outputs once it knows they stream, so it streams.
    const streams = isAsyncIterable(returned) || resolvesToStream(tool);
    const result: unknown = await returned;
    if (!isAsyncIterable(result)) return { ok: true, output: result };
    // As in the AI SDK, each value a streaming tool yields is reported as
    // it comes; the last is also its result.
    let last: unknown;
    for await (const output of result) {
      if (streams) options.onPreliminary(output);
      last = output;
    }
    return { ok: true, output: last };
  } catch (error) {
    return {
      ok: false,
      errorText: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Marks a tool whose `execute` resolves to its outputs when they stream
 * (an extension's, across its boundary), so `executeTool` streams them.
 *
 * @internal
 */
export const RESOLVES_TO_STREAM = Symbol.for("agents.harness.resolvesToStream");

function resolvesToStream(tool: Tool): boolean {
  return (
    (tool as { [RESOLVES_TO_STREAM]?: boolean })[RESOLVES_TO_STREAM] === true
  );
}
