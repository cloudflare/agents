import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentTool } from "../agent-tools";
import { __DO_NOT_USE_WILL_BREAK__agentContext as agentContext } from "../internal_context";
import type {
  AgentToolFailure,
  ChatCapableAgentClass,
  RunAgentToolOptions,
  RunAgentToolResult
} from "../agent-tool-types";

/**
 * Drive `agentTool().execute` against a stubbed `runAgentTool` so we can assert
 * the structured failure envelope each terminal status produces — the signal a
 * parent agent (or orchestration harness) needs to tell a transient,
 * re-dispatchable interruption apart from a terminal failure.
 */
function runWithStub(
  result: RunAgentToolResult,
  capture?: (options: RunAgentToolOptions) => void
): Promise<unknown> {
  const stubAgent = {
    async runAgentTool(
      _cls: ChatCapableAgentClass,
      options: RunAgentToolOptions
    ): Promise<RunAgentToolResult> {
      capture?.(options);
      return result;
    }
  };

  const subAgent = agentTool(class {} as unknown as ChatCapableAgentClass, {
    description: "Run a sub-agent",
    inputSchema: z.object({ task: z.string() })
  });

  const execute = subAgent.execute as (
    input: unknown,
    options?: { toolCallId?: string; abortSignal?: AbortSignal }
  ) => Promise<unknown>;

  return agentContext.run(
    {
      agent: stubAgent,
      connection: undefined,
      request: undefined,
      email: undefined
    },
    () => execute({ task: "do a thing" }, { toolCallId: "call-1" })
  );
}

describe("agentTool failure envelope", () => {
  it("marks an interrupted run as retryable and surfaces its reason", async () => {
    const out = (await runWithStub({
      runId: "r1",
      agentType: "Child",
      status: "interrupted",
      error: "child reset by deploy"
    })) as AgentToolFailure;

    expect(out).toMatchObject({
      ok: false,
      status: "interrupted",
      retryable: true,
      error: "child reset by deploy"
    });
  });

  it("marks an explicit cancellation as aborted and non-retryable", async () => {
    const out = (await runWithStub({
      runId: "r2",
      agentType: "Child",
      status: "aborted",
      error: "stop"
    })) as AgentToolFailure;

    expect(out).toMatchObject({
      ok: false,
      status: "aborted",
      retryable: false
    });
  });

  it("marks a genuine error as non-retryable", async () => {
    const out = (await runWithStub({
      runId: "r3",
      agentType: "Child",
      status: "error",
      error: "boom"
    })) as AgentToolFailure;

    expect(out).toMatchObject({
      ok: false,
      status: "error",
      retryable: false,
      error: "boom"
    });
  });

  it("returns the summary string on completion (no failure envelope)", async () => {
    const out = await runWithStub({
      runId: "r4",
      agentType: "Child",
      status: "completed",
      summary: "all done"
    });

    expect(out).toBe("all done");
  });

  it("derives a stable runId from the tool call id so recovery re-attaches instead of re-running (#1630)", async () => {
    let captured: RunAgentToolOptions | undefined;
    await runWithStub(
      {
        runId: "agent-tool:call-1",
        agentType: "Child",
        status: "completed",
        summary: "done"
      },
      (options) => {
        captured = options;
      }
    );

    // Stable, derived from the (recovery-preserved) toolCallId — NOT a fresh
    // nanoid — so a re-issued turn resolves to the same child run.
    expect(captured?.runId).toBe("agent-tool:call-1");
    expect(captured?.parentToolCallId).toBe("call-1");
  });
});
