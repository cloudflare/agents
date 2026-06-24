import { describe, expect, it } from "vitest";
import type { Executor } from "../executor";
import { runCode } from "../run-code";
import { CodemodeExecutionError } from "../retry";

function executorWith(
  result: Awaited<ReturnType<Executor["execute"]>>
): Executor {
  return { execute: async () => result };
}

describe("runCode executor boundary", () => {
  it("returns successful results and logs", async () => {
    await expect(
      runCode({
        code: "async () => 42",
        executor: executorWith({ result: 42, logs: ["done"] }),
        providers: []
      })
    ).resolves.toEqual({ result: 42, logs: ["done"] });
  });

  it("normalizes an unclassified executor error", async () => {
    await expect(
      runCode({
        code: "async () => 42",
        executor: executorWith({
          result: undefined,
          error: "sandbox failed",
          logs: ["before failure"]
        }),
        providers: []
      })
    ).rejects.toMatchObject({
      message:
        "Code execution failed: sandbox failed\n\nConsole output:\nbefore failure",
      failure: { kind: "error", message: "sandbox failed" },
      logs: ["before failure"]
    } satisfies Partial<CodemodeExecutionError>);
  });

  it("preserves a structured retryable failure", async () => {
    await expect(
      runCode({
        code: "async () => 42",
        executor: executorWith({
          result: undefined,
          error: "rate limited",
          failure: {
            kind: "retryable",
            message: "rate limited",
            retryAfterMs: 250
          }
        }),
        providers: []
      })
    ).rejects.toMatchObject({
      failure: {
        kind: "retryable",
        message: "rate limited",
        retryAfterMs: 250
      }
    } satisfies Partial<CodemodeExecutionError>);
  });
});
