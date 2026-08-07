import { describe, expect, it } from "vitest";
import { parseMessageDiagnostics, summarizeMessages } from "../src/diagnostics";

describe("count-only evaluation diagnostics", () => {
  it("counts model steps and unique tool calls without retaining content", () => {
    const diagnostics = summarizeMessages([
      { role: "user", parts: [{ type: "text", text: "secret material" }] },
      {
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "reasoning", text: "private reasoning" },
          {
            type: "tool-codemode",
            toolCallId: "call-1",
            output: { content: "sensitive output" }
          },
          {
            type: "tool-codemode",
            toolCallId: "call-1",
            output: { content: "updated state" }
          },
          { type: "dynamic-tool", toolName: "finish", toolCallId: "call-2" }
        ]
      }
    ]);

    expect(diagnostics).toEqual({
      messageCount: 2,
      assistantMessageCount: 1,
      modelStepCount: 1,
      toolCallCount: 2,
      toolNames: ["codemode", "finish"]
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/secret|private|sensitive/);
  });

  it("validates the runner's diagnostics envelope", () => {
    expect(
      parseMessageDiagnostics({
        messageCount: 2,
        assistantMessageCount: 1,
        modelStepCount: 1,
        toolCallCount: 1,
        toolNames: ["codemode", "codemode"]
      })
    ).toEqual({
      messageCount: 2,
      assistantMessageCount: 1,
      modelStepCount: 1,
      toolCallCount: 1,
      toolNames: ["codemode"]
    });
    expect(() => parseMessageDiagnostics({ toolNames: [] })).toThrow(
      /messageCount/
    );
  });
});
