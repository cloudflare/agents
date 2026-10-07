import { describe, expect, it } from "vitest";
import { ClaudeProjection } from "../presets/claude-code-events";

const NOW = 1_000;

describe("ClaudeProjection", () => {
  it("streams deltas under the API message id", () => {
    const projection = new ClaudeProjection(() => NOW);
    expect(
      projection.project(
        {
          type: "stream_event",
          event: { type: "message_start", message: { id: "m1" } }
        },
        "op"
      )
    ).toEqual([]);
    expect(
      projection.project(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hel" }
          }
        },
        "op"
      )
    ).toEqual([{ type: "text-delta", messageId: "m1", delta: "Hel" }]);
    expect(
      projection.project(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "hmm" }
          }
        },
        "op"
      )
    ).toEqual([{ type: "reasoning-delta", messageId: "m1", delta: "hmm" }]);
  });

  it("accumulates blocks into one message and fills tool results in", () => {
    const projection = new ClaudeProjection(() => NOW);
    projection.project(
      {
        type: "assistant",
        uuid: "u1",
        parent_tool_use_id: null,
        message: { id: "m1", content: [{ type: "thinking", thinking: "plan" }] }
      },
      "op"
    );
    projection.project(
      {
        type: "assistant",
        uuid: "u2",
        parent_tool_use_id: null,
        message: {
          id: "m1",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "ls" }
            }
          ]
        }
      },
      "op"
    );
    // A replayed SDK message adds nothing.
    expect(
      projection.project(
        {
          type: "assistant",
          uuid: "u2",
          message: {
            id: "m1",
            content: [{ type: "tool_use", id: "t1", name: "Bash" }]
          }
        },
        "op"
      )
    ).toEqual([]);
    const [event] = projection.project(
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: "a.txt" }]
            }
          ]
        }
      },
      "op"
    );
    expect(event).toEqual({
      type: "message",
      message: {
        id: "m1",
        role: "assistant",
        operationId: "op",
        createdAt: NOW,
        parts: [
          { type: "reasoning", text: "plan" },
          {
            type: "tool",
            toolCallId: "t1",
            toolName: "Bash",
            input: { command: "ls" },
            state: "done",
            output: "a.txt"
          }
        ]
      }
    });
  });

  it("leaves subagent traffic out", () => {
    const projection = new ClaudeProjection(() => NOW);
    expect(
      projection.project(
        {
          type: "assistant",
          parent_tool_use_id: "t1",
          message: { id: "m2", content: [{ type: "text", text: "inner" }] }
        },
        "op"
      )
    ).toEqual([]);
  });

  it("maps results to outcomes and usage", () => {
    const projection = new ClaudeProjection(() => NOW);
    const success = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done!",
      total_cost_usd: 0.25,
      usage: { input_tokens: 10, output_tokens: 5 }
    };
    expect(projection.project(success, "op")).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.25 }
    ]);
    expect(projection.outcome(success, false)).toEqual({
      status: "done",
      text: "done!"
    });
    expect(projection.outcome(success, true)).toEqual({
      status: "unanswered",
      reason: "aborted"
    });
    expect(
      projection.outcome(
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["too many"]
        },
        false
      )
    ).toEqual({ status: "unanswered", reason: "error_max_turns: too many" });
    expect(
      projection.outcome(
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "API Error: 401"
        },
        false
      )
    ).toEqual({ status: "unanswered", reason: "API Error: 401" });
  });
});

describe("claude-code preset", () => {
  it("resumes the session id the CLI reported, reading the prompt from stdin", async () => {
    const { claudeCodeCli } = await import("../presets/claude-code");
    const turn = {
      operationId: "op",
      prompt: "hi",
      settings: { model: "claude-sonnet-4-5" },
      state: {}
    };
    const first = claudeCodeCli.command(turn);
    expect(first.argv).not.toContain("--resume");
    expect(first.stdin).toBe("hi");
    const parser = claudeCodeCli.parser(turn);
    expect(
      parser.line(
        JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" })
      )
    ).toMatchObject({
      state: { sessionId: "s-1" }
    });
    expect(
      parser.line(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: "s-1"
        })
      )
    ).toMatchObject({ outcome: { status: "done", text: "ok" } });
    const next = claudeCodeCli.command({
      ...turn,
      state: { sessionId: "s-1" }
    });
    expect(next.argv.join(" ")).toContain("--resume s-1");
  });
});
