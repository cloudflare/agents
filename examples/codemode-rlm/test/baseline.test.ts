import type { ToolCallContext } from "@cloudflare/think";
import { describe, expect, it } from "vitest";
import { BasicThinkAgent } from "../src/baseline";

function baseline(): BasicThinkAgent {
  const agent = Object.create(BasicThinkAgent.prototype) as BasicThinkAgent;
  Object.defineProperty(agent, "env", { value: {} });
  return agent;
}

describe("BasicThinkAgent tool isolation", () => {
  it("exposes and forces only the terminal answer tool", () => {
    const agent = baseline();
    const turn = agent.beforeTurn({} as never);

    expect(Object.keys(agent.getTools())).toEqual(["submit_answer"]);
    expect(turn.activeTools).toEqual(["submit_answer"]);
    expect(turn.toolChoice).toEqual({
      type: "tool",
      toolName: "submit_answer"
    });
  });

  it("blocks any unexpected tool call", () => {
    const agent = baseline();

    expect(
      agent.beforeToolCall({ toolName: "codemode" } as ToolCallContext)
    ).toEqual({
      action: "block",
      reason: "The direct Think control exposes only submit_answer."
    });
    expect(
      agent.beforeToolCall({ toolName: "submit_answer" } as ToolCallContext)
    ).toBeUndefined();
  });
});
