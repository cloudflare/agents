/**
 * The Claude Code projection against hand-written SDK fixtures.
 *
 * The fixtures are written from the documented message shapes rather than
 * recorded from a live run, and the assertions are semantic: what the
 * projection must produce for the shared React hook to render, not a
 * byte-for-byte snapshot that would break on every SDK field addition.
 */
import { describe, expect, it } from "vitest";
import {
  projectSdkMessage,
  usageOf,
  type ProjectionContext,
  type SdkMessageLike
} from "../engines/claude-code-project.ts";

const CONTEXT: ProjectionContext = {
  operationId: "op-1",
  interrupted: false,
  stillQueued: [],
  started: new Set(),
  liveMessageId: null
};

function bodies(message: SdkMessageLike, context = CONTEXT) {
  return projectSdkMessage(message, context).frames;
}

function result(
  overrides: Partial<SdkMessageLike> & { readonly subtype: string }
): SdkMessageLike {
  return {
    type: "result",
    duration_ms: 1200,
    num_turns: 2,
    is_error: false,
    total_cost_usd: 0.042,
    usage: { input_tokens: 10, output_tokens: 20 },
    session_id: "sess-1",
    ...overrides
  };
}

describe("projectSdkMessage", () => {
  it("turns system/init into an engine_init extension and remembers the session", () => {
    const projection = projectSdkMessage(
      {
        type: "system",
        subtype: "init",
        session_id: "sess-1",
        model: "claude-opus-5",
        tools: ["Read", "Bash"]
      },
      CONTEXT
    );
    expect(projection.frames).toEqual([
      {
        kind: "event",
        body: {
          type: "extension",
          body: {
            type: "engine_init",
            sessionId: "sess-1",
            model: "claude-opus-5",
            tools: ["Read", "Bash"]
          }
        }
      }
    ]);
    expect(projection.patch.engineSessionId).toBe("sess-1");
  });

  it("reports a new engine session when the conversation resets", () => {
    const projection = projectSdkMessage(
      { type: "conversation_reset", new_conversation_id: "sess-2" },
      CONTEXT
    );
    expect(projection.frames).toEqual([
      {
        kind: "event",
        body: {
          type: "extension",
          body: { type: "conversation_reset", newConversationId: "sess-2" }
        }
      }
    ]);
    // The engine turns this into an `engine_session` frame, so the next
    // container resumes the new id rather than the reset one.
    expect(projection.patch.engineSessionId).toBe("sess-2");
  });

  it("surfaces a dropped transcript-mirror batch", () => {
    expect(
      bodies({
        type: "system",
        subtype: "mirror_error",
        error: "the store timed out",
        key: {
          projectKey: "-workspace",
          sessionId: "sess-1",
          subpath: "subagents/agent-1"
        }
      })
    ).toEqual([
      {
        kind: "event",
        body: {
          type: "extension",
          body: {
            type: "mirror_error",
            engineSessionId: "sess-1",
            subpath: "subagents/agent-1",
            message: "the store timed out"
          }
        }
      }
    ]);
  });

  it("projects an assistant message into message_start, message_end and parts", () => {
    const frames = bodies({
      type: "assistant",
      uuid: "u-1",
      session_id: "sess-1",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "weighing it up" },
          { type: "text", text: "Here you go." }
        ]
      }
    });
    expect(frames[0]).toMatchObject({
      body: { type: "message_start", messageId: "msg_1", role: "assistant" }
    });
    expect(frames[1]).toMatchObject({
      body: {
        type: "message_end",
        messageId: "msg_1",
        parts: [
          { type: "reasoning", text: "weighing it up" },
          { type: "text", text: "Here you go." }
        ]
      }
    });
  });

  it("does not repeat message_start for a message id it already opened", () => {
    const frames = bodies(
      {
        type: "assistant",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "more" }]
        }
      },
      { ...CONTEXT, started: new Set(["msg_1"]) }
    );
    expect(frames.map((frame) => frame.body.type)).toEqual(["message_end"]);
  });

  it("emits a tool-call part and a tool_start for a tool_use block", () => {
    const frames = bodies({
      type: "assistant",
      message: {
        id: "msg_2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "uname -a" }
          }
        ]
      }
    });
    expect(frames.at(-1)).toEqual({
      kind: "event",
      body: {
        type: "tool_start",
        toolCallId: "toolu_1",
        toolName: "Bash",
        input: { command: "uname -a" }
      }
    });
    expect(frames[1]).toMatchObject({
      body: {
        type: "message_end",
        parts: [
          {
            type: "tool-call",
            toolCallId: "toolu_1",
            toolName: "Bash",
            input: { command: "uname -a" }
          }
        ]
      }
    });
  });

  it("turns a tool_result user message into tool_end", () => {
    const frames = bodies({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "Linux 6.1",
            is_error: false
          }
        ]
      }
    });
    expect(frames).toEqual([
      {
        kind: "event",
        body: {
          type: "tool_end",
          toolCallId: "toolu_1",
          output: "Linux 6.1",
          isError: false
        }
      }
    ]);
  });

  it("ignores a plain user message: it is the prompt, already in the transcript", () => {
    expect(
      bodies({ type: "user", message: { role: "user", content: "hi" } })
    ).toEqual([]);
  });

  it("turns stream deltas into previews, never frames", () => {
    const opened = projectSdkMessage(
      {
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_3" } }
      },
      CONTEXT
    );
    expect(opened.frames).toEqual([]);
    expect(opened.patch.liveMessageId).toBe("msg_3");

    const live = { ...CONTEXT, liveMessageId: "msg_3" };
    expect(
      bodies(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hel" }
          }
        },
        live
      )
    ).toEqual([
      {
        kind: "preview",
        body: { type: "text_delta", messageId: "msg_3", delta: "Hel" }
      }
    ]);
    expect(
      bodies(
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "hmm" }
          }
        },
        live
      )
    ).toEqual([
      {
        kind: "preview",
        body: { type: "reasoning_delta", messageId: "msg_3", delta: "hmm" }
      }
    ]);
  });

  it("settles a successful result as completed with usage", () => {
    const projection = projectSdkMessage(
      result({
        subtype: "success",
        stop_reason: "end_turn",
        result: "Done.",
        modelUsage: {
          "claude-opus-5": {
            inputTokens: 100,
            outputTokens: 50,
            thinkingTokens: 8,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 5,
            costUSD: 0.04
          }
        }
      }),
      CONTEXT
    );
    expect(projection.patch.settled).toBe(true);
    const [usage, settle] = projection.frames;
    expect(usage).toMatchObject({
      body: { type: "usage", usage: { inputTokens: 100, reasoningTokens: 8 } }
    });
    expect(settle).toMatchObject({
      kind: "control",
      body: {
        type: "settle",
        operationId: "op-1",
        settlement: {
          status: "completed",
          stopReason: { type: "end_turn" },
          raw: { subtype: "success", duration_ms: 1200, num_turns: 2 }
        }
      }
    });
  });

  it("maps error_max_turns and error_max_budget_usd onto their stop reasons", () => {
    const turns = projectSdkMessage(
      result({
        subtype: "error_max_turns",
        is_error: true,
        errors: ["too many turns"]
      }),
      CONTEXT
    ).frames.at(-1);
    expect(turns).toMatchObject({
      body: {
        settlement: {
          status: "failed",
          stopReason: { type: "max_turns" },
          error: { code: "error_max_turns", message: "too many turns" }
        }
      }
    });

    const budget = projectSdkMessage(
      result({ subtype: "error_max_budget_usd", is_error: true }),
      CONTEXT
    ).frames.at(-1);
    expect(budget).toMatchObject({
      body: { settlement: { status: "failed", stopReason: { type: "budget" } } }
    });
  });

  it("settles as aborted when an interrupt was requested", () => {
    const settle = projectSdkMessage(result({ subtype: "success" }), {
      ...CONTEXT,
      interrupted: true,
      stillQueued: ["queued-1"]
    }).frames.at(-1);
    expect(settle).toMatchObject({
      body: {
        settlement: {
          status: "aborted",
          stopReason: { type: "interrupted" },
          stillQueued: ["queued-1"]
        }
      }
    });
  });

  it("reports a compaction boundary", () => {
    expect(
      bodies({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 120_000 }
      })
    ).toEqual([
      {
        kind: "event",
        body: {
          type: "extension",
          body: { type: "compacted", trigger: "manual", preTokens: 120_000 }
        }
      }
    ]);
  });

  it("drops command_lifecycle and system/status, which the harness already expresses", () => {
    const lifecycle = projectSdkMessage(
      {
        type: "command_lifecycle",
        command_uuid: "c-1",
        state: "started",
        uuid: "u-1",
        session_id: "s-1"
      } as never,
      CONTEXT
    );
    expect(lifecycle.frames).toEqual([]);
    const status = projectSdkMessage(
      {
        type: "system",
        subtype: "status",
        status: "requesting",
        uuid: "u-2",
        session_id: "s-1"
      } as never,
      CONTEXT
    );
    expect(status.frames).toEqual([]);
    const thinking = projectSdkMessage(
      {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 50,
        uuid: "u-3",
        session_id: "s-1"
      } as never,
      CONTEXT
    );
    expect(thinking.frames).toEqual([]);
  });

  it("turns an unknown subtype into engine_raw rather than dropping it", () => {
    const [frame] = bodies({
      type: "system",
      subtype: "something_new",
      session_id: "sess-1"
    });
    expect(frame).toMatchObject({
      kind: "event",
      body: {
        type: "extension",
        body: { type: "engine_raw", kind: "system", subtype: "something_new" }
      }
    });
  });

  it("falls back to the per-turn usage when no model breakdown is present", () => {
    expect(
      usageOf(
        result({
          subtype: "success",
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 2
          }
        })
      )
    ).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 1,
      cacheWriteTokens: 2,
      costUsd: 0.042
    });
  });
});
