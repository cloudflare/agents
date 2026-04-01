/**
 * Client tool schema handling for the cf_agent_chat protocol.
 *
 * Converts client-provided tool schemas (JSON wire format) into AI SDK
 * tool definitions. These tools have no `execute` function — when the
 * model calls them, the tool call is sent back to the client.
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
 * Converts client tool schemas to AI SDK tool format.
 *
 * These tools have no `execute` function — when the AI model calls them,
 * the tool call is sent back to the client for execution.
 *
 * @param clientTools - Array of tool schemas from the client
 * @returns Record of AI SDK tools that can be spread into your tools object
 */
export function createToolsFromClientSchemas(
  clientTools?: ClientToolSchema[]
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

  return Object.fromEntries(
    clientTools.map((t) => [
      t.name,
      tool({
        description: t.description ?? "",
        inputSchema: jsonSchema(t.parameters ?? { type: "object" })
      })
    ])
  );
}
