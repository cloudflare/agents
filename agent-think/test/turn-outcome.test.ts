import { describe, expect, it } from "vitest";
import {
  AGENT_THINK_MAX_STEPS,
  classifyTurnOutcome
} from "../src/turn-outcome";

type TestPart = { type: string; text?: string };

function toolSteps(count: number): TestPart[] {
  return Array.from({ length: count }, (_, index) => [
    { type: "step-start" },
    { type: "tool-bash", toolCallId: `call-${index}` }
  ]).flat();
}

function result(
  parts: TestPart[],
  status: "completed" | "error" | "aborted" = "completed",
  error?: string
) {
  return { message: { parts }, status, error };
}

describe("classifyTurnOutcome", () => {
  it("allows 250 steps for long review and demo runs", () => {
    expect(AGENT_THINK_MAX_STEPS).toBe(250);
  });

  it("reports max-step exhaustion when the final step ends with a tool call", () => {
    const outcome = classifyTurnOutcome(
      result(toolSteps(AGENT_THINK_MAX_STEPS)),
      AGENT_THINK_MAX_STEPS
    );

    expect(outcome).toMatchObject({
      outcome: "error",
      reason: "max_steps",
      steps: AGENT_THINK_MAX_STEPS,
      finalStepHasToolCall: true
    });
    expect(outcome.error).toContain(`${AGENT_THINK_MAX_STEPS}-step`);
  });

  it("does not mistake a final text step at the cap for exhaustion", () => {
    const parts = [
      ...toolSteps(AGENT_THINK_MAX_STEPS - 1),
      { type: "step-start" },
      { type: "text", text: "Finished." }
    ];

    expect(
      classifyTurnOutcome(result(parts), AGENT_THINK_MAX_STEPS)
    ).toMatchObject({
      outcome: "done",
      reason: "completed",
      steps: AGENT_THINK_MAX_STEPS,
      assistantChars: 9,
      finalStepHasToolCall: false
    });
  });

  it("reports exhaustion even when an earlier step emitted text", () => {
    const parts = [
      { type: "step-start" },
      { type: "text", text: "Still working." },
      ...toolSteps(AGENT_THINK_MAX_STEPS - 1)
    ];

    expect(
      classifyTurnOutcome(result(parts), AGENT_THINK_MAX_STEPS)
    ).toMatchObject({
      outcome: "error",
      reason: "max_steps",
      assistantChars: 14,
      finalStepHasToolCall: true
    });
  });

  it("preserves stream errors", () => {
    expect(
      classifyTurnOutcome(result([], "error", "provider failed"), 100)
    ).toEqual({
      outcome: "error",
      reason: "stream_error",
      error: "provider failed",
      steps: 0,
      assistantChars: 0,
      finalStepHasToolCall: false
    });
  });

  it("does not report aborted turns as done", () => {
    expect(classifyTurnOutcome(result([], "aborted"), 100)).toMatchObject({
      outcome: "error",
      reason: "aborted",
      error: "Turn was aborted before completion."
    });
  });
});
