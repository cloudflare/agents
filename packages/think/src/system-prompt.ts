/**
 * The capability block Think appends to a turn's system prompt: one line per
 * kind of tool the turn exposes.
 */

import type { ToolSet } from "ai";

const CAPABILITY_BLOCK_HEADING = "You are running inside a Think agent.";

/**
 * Append the capability block for `tools` to `baseSystem`. A prompt that
 * already carries the block (an override that includes it) is returned as-is.
 */
export function systemPromptForTurn(
  baseSystem: string,
  tools: ToolSet
): string {
  if (baseSystem.includes(CAPABILITY_BLOCK_HEADING)) {
    return baseSystem;
  }

  return `${baseSystem.trimEnd()}\n\n${capabilityBlock(tools)}`;
}

/** The capability block for the tools a turn exposes. */
export function capabilityBlock(tools: ToolSet): string {
  const toolNames = new Set(Object.keys(tools));
  const hasTools = toolNames.size > 0;
  const hasWorkspaceTools = [
    "read",
    "write",
    "edit",
    "ls",
    "find",
    "grep",
    "delete"
  ].some((toolName) => toolNames.has(toolName));
  const hasExtensionTools =
    toolNames.has("load_extension") || toolNames.has("list_extensions");
  const hasExecuteTool = toolNames.has("execute");
  const hasFetchTools = [...toolNames].some((name) =>
    name.startsWith("fetch_")
  );

  const lines = [
    CAPABILITY_BLOCK_HEADING,
    "",
    "Capabilities available in this turn:"
  ];

  if (hasWorkspaceTools) {
    lines.push(
      "- You can inspect and edit the agent workspace using the available file tools."
    );
  }

  if (hasTools) {
    lines.push(
      "- Use the tools exposed in this turn when they materially improve accuracy or let you act on the user's request. Treat tool descriptions and schemas as the source of truth."
    );
    lines.push(
      "- Some tools may call server code, browser/client code, MCP servers, extensions, or delegated agents. Use them according to their descriptions."
    );
  }

  if (hasExtensionTools) {
    lines.push(
      "- If extension tools are available, use them only when loading or inspecting extensions directly helps with the task."
    );
  }

  if (hasExecuteTool) {
    lines.push(
      "- If sandboxed execution is available, prefer it for safe, bounded checks or coordinated multi-step operations."
    );
  }

  if (hasFetchTools) {
    lines.push(
      "- If fetch tools are available, use them to read allowlisted HTTP resources (documentation, APIs). They are read-only and bounded; respect their allowlist and do not assume access to other URLs."
    );
  }

  lines.push(
    "- Do not claim access to capabilities that are not exposed as tools in this turn."
  );

  return lines.join("\n");
}
