/**
 * Client tool schema handling for the cf_agent_chat protocol.
 *
 * Converts client-provided tool schemas (JSON wire format) into AI SDK
 * tool definitions. By default these tools have no `execute` function —
 * when the model calls them, the tool call is sent back to the client.
 *
 * When an `execute` delegate is supplied (e.g. a parent agent that drives a
 * Think sub-agent over RPC and can run the client tools itself), the tools are
 * built WITH an `execute` so the model's call is resolved inline within the
 * same turn instead of being surfaced as a dangling tool call.
 *
 * Used by both @cloudflare/ai-chat and @cloudflare/think.
 */

import type { JSONSchema7, Tool, ToolSet } from "ai";
import { tool, jsonSchema } from "ai";

/**
 * Wire-format tool schema sent from the client.
 * Uses `parameters` (JSONSchema7) rather than AI SDK's `inputSchema`
 * because Zod schemas cannot be serialized over the wire.
 */
export type ClientToolSchema = {
  /** Unique name for the tool */
  name: string;
  /** Human-readable description of what the tool does */
  description?: Tool["description"];
  /** JSON Schema defining the tool's input parameters */
  parameters?: JSONSchema7;
};

/**
 * Executes a client-defined tool and returns its output.
 *
 * Used for the RPC path (e.g. a parent agent delegating to a Think sub-agent)
 * where the caller can run the client tools itself, rather than the
 * browser/WebSocket path where results are sent back asynchronously.
 */
export type ClientToolExecutor = (call: {
  /** The name of the client tool the model called. */
  toolName: string;
  /** The model-generated input for the tool call. */
  input: unknown;
  /** The AI SDK tool-call id for the invocation. */
  toolCallId: string;
}) => unknown | Promise<unknown>;

/**
 * Converts client tool schemas to AI SDK tool format.
 *
 * By default these tools have no `execute` function — when the AI model calls
 * them, the tool call is sent back to the client for execution.
 *
 * When `options.execute` is provided, each tool is built WITH an `execute` that
 * delegates to it. This is used by the RPC path (e.g. a parent agent driving a
 * Think sub-agent) so the model's client-tool call is resolved inline within
 * the same turn.
 *
 * @param clientTools - Array of tool schemas from the client
 * @param options - Optional `execute` delegate to run the tools inline
 * @returns Record of AI SDK tools that can be spread into your tools object
 */
export function createToolsFromClientSchemas(
  clientTools?: ClientToolSchema[],
  options?: { execute?: ClientToolExecutor }
): ToolSet {
  if (!clientTools || clientTools.length === 0) {
    return {};
  }

  const seenNames = new Set<string>();
  for (const t of clientTools) {
    if (seenNames.has(t.name)) {
      console.warn(
        `[createToolsFromClientSchemas] Duplicate tool name "${t.name}" found. Later definitions will override earlier ones.`
      );
    }
    seenNames.add(t.name);
  }

  const execute = options?.execute;
  // The AI SDK's `tool()` overloads infer the input type as `never` when an
  // `execute` is combined with a runtime `jsonSchema(...)`. Cast to a
  // permissive signature (same approach as `agentTool()`), since the wire
  // schema is untyped JSON.
  const createTool = tool as unknown as (config: {
    description: string;
    inputSchema: ReturnType<typeof jsonSchema>;
    execute?: (
      input: unknown,
      executeOptions?: { toolCallId?: string }
    ) => unknown | Promise<unknown>;
  }) => Tool;

  return Object.fromEntries(
    clientTools.map((t) => [
      t.name,
      createTool({
        description: t.description ?? "",
        inputSchema: jsonSchema(t.parameters ?? { type: "object" }),
        ...(execute
          ? {
              execute: (
                input: unknown,
                executeOptions?: { toolCallId?: string }
              ) =>
                execute({
                  toolName: t.name,
                  input,
                  toolCallId: executeOptions?.toolCallId ?? ""
                })
            }
          : {})
      })
    ])
  );
}
