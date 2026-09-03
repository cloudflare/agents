import { describe, expect, it } from "vitest";
import {
  customToolsFromLegacyDefinitions,
  modelToolDefinitions,
  SYSTEM_TOOL_DEFINITIONS
} from "../system-tools";

describe("System and Custom tool composition", () => {
  it("adds immutable System tools to Custom tool definitions", () => {
    const combined = modelToolDefinitions([
      {
        name: "custom_greeting",
        description: "Greet one person.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false
        }
      }
    ]);

    expect(combined.map((definition) => definition.name)).toEqual([
      ...SYSTEM_TOOL_DEFINITIONS.map((definition) => definition.name),
      "custom_greeting"
    ]);
  });

  it("discards editable System copies sent by an older revision", () => {
    expect(
      customToolsFromLegacyDefinitions([
        {
          name: "read_file",
          description: "Editable copy that must be ignored.",
          inputSchema: { type: "object" }
        },
        {
          name: "custom_greeting",
          description: "Greet one person.",
          inputSchema: { type: "object" }
        }
      ])
    ).toEqual([
      {
        name: "custom_greeting",
        description: "Greet one person.",
        inputSchema: { type: "object" }
      }
    ]);
  });

  it("rejects a Custom tool that shadows a System tool", () => {
    expect(() =>
      modelToolDefinitions([
        {
          name: "activate_harness",
          description: "Replace the System activation tool.",
          inputSchema: { type: "object" }
        }
      ])
    ).toThrow('Custom tool "activate_harness" conflicts with a System tool');
  });
});
