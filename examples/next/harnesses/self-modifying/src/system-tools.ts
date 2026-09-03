import type { HarnessToolDefinition } from "./runtime-types";

/** Trusted tool definitions supplied to every model round by the host. */
export const SYSTEM_TOOL_DEFINITIONS: readonly HarnessToolDefinition[] = [
  {
    name: "read_file",
    description: "Read one editable harness source file under /harness.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "write_file",
    description: "Write one editable harness source file under /harness.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    name: "delete_file",
    description: "Delete one editable harness source file under /harness.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "list_files",
    description: "List the editable harness source files.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "activate_harness",
    description:
      "Bundle and validate the working source, then activate it for the next turn.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false
    }
  },
  {
    name: "list_revisions",
    description: "List activated harness revisions, newest first.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false
    }
  },
  {
    name: "restore_revision",
    description:
      "Restore an earlier source snapshot and activate it as a new forward revision.",
    inputSchema: {
      type: "object",
      properties: { revisionId: { type: "number" } },
      required: ["revisionId"],
      additionalProperties: false
    }
  },
  {
    name: "journal_note",
    description: "Append a short note to the trusted immutable journal.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false
    }
  }
];

const SYSTEM_TOOL_NAMES = new Set(
  SYSTEM_TOOL_DEFINITIONS.map((definition) => definition.name)
);

/** Remove editable copies of System definitions sent by an older revision. */
export function customToolsFromLegacyDefinitions(
  tools: readonly HarnessToolDefinition[]
): readonly HarnessToolDefinition[] {
  return tools.filter((tool) => !SYSTEM_TOOL_NAMES.has(tool.name));
}

/** Combine trusted System tools with non-conflicting Custom tools. */
export function modelToolDefinitions(
  customTools: readonly HarnessToolDefinition[]
): readonly HarnessToolDefinition[] {
  for (const customTool of customTools) {
    if (SYSTEM_TOOL_NAMES.has(customTool.name)) {
      throw new Error(
        `Custom tool ${JSON.stringify(customTool.name)} conflicts with a System tool`
      );
    }
  }
  return [...SYSTEM_TOOL_DEFINITIONS, ...customTools];
}
