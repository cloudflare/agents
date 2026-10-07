import { describe, expect, it } from "vitest";
import { codexCli } from "../presets/codex";

const TURN = {
  operationId: "op",
  prompt: "hi",
  settings: { model: "gpt-5.1" },
  state: {}
};

/** Lines `codex exec --json` printed for a turn that ran one command. */
const LINES = [
  { type: "thread.started", thread_id: "t-1" },
  {
    type: "item.completed",
    item: { id: "item_0", type: "error", message: "metadata" }
  },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: "Running it." }
  },
  {
    type: "item.started",
    item: {
      id: "item_2",
      type: "command_execution",
      command: "ls",
      aggregated_output: "",
      exit_code: null,
      status: "in_progress"
    }
  },
  {
    type: "item.completed",
    item: {
      id: "item_2",
      type: "command_execution",
      command: "ls",
      aggregated_output: "a.txt\n",
      exit_code: 0,
      status: "completed"
    }
  },
  {
    type: "item.completed",
    item: { id: "item_3", type: "agent_message", text: "DONE" }
  },
  { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }
];

describe("codex preset", () => {
  it("starts a thread, then resumes it, reading the prompt from stdin", () => {
    const first = codexCli.command(TURN);
    expect(first.argv.slice(0, 3)).toEqual(["codex", "exec", "--json"]);
    expect(first.argv.at(-1)).toBe("-");
    expect(first.stdin).toBe("hi");
    const next = codexCli.command({ ...TURN, state: { threadId: "t-1" } });
    expect(next.argv.slice(0, 4)).toEqual(["codex", "exec", "resume", "t-1"]);
    expect(next.argv).toContain("gpt-5.1");
  });

  it("routes through AI Gateway when OPENAI_BASE_URL is set", () => {
    process.env.OPENAI_BASE_URL = "https://gateway.example/openai";
    try {
      const argv = codexCli.command(TURN).argv;
      expect(argv).toContain("model_provider=gateway");
      expect(argv.join(" ")).toContain(
        'base_url="https://gateway.example/openai"'
      );
    } finally {
      delete process.env.OPENAI_BASE_URL;
    }
  });

  it("projects a turn into one assistant message, state, and an outcome", () => {
    const parser = codexCli.parser(TURN);
    const updates = LINES.map((line) => parser.line(JSON.stringify(line)));
    expect(updates[0]).toEqual({ state: { threadId: "t-1" } });
    expect(updates[1]?.events).toEqual([
      { type: "log", level: "warn", message: "metadata" }
    ]);
    const last = updates.at(-2)?.events?.[0];
    expect(last).toMatchObject({
      type: "message",
      message: {
        id: "op:assistant",
        role: "assistant",
        parts: [
          { type: "text", text: "Running it." },
          {
            type: "tool",
            toolCallId: "item_2",
            toolName: "shell",
            input: { command: "ls" },
            state: "done",
            output: "a.txt\n"
          },
          { type: "text", text: "DONE" }
        ]
      }
    });
    expect(updates.at(-1)).toEqual({
      events: [{ type: "usage", inputTokens: 10, outputTokens: 2 }],
      outcome: { status: "done", text: "DONE" }
    });
  });

  it("reports a failed turn and an exit without one", () => {
    const parser = codexCli.parser(TURN);
    expect(
      parser.line(
        JSON.stringify({ type: "turn.failed", error: { message: "quota" } })
      )
    ).toEqual({
      outcome: { status: "unanswered", reason: "quota" }
    });
    parser.line(JSON.stringify({ type: "error", message: "401 Unauthorized" }));
    expect(parser.end({ code: 1, stderr: "" })).toEqual({
      status: "unanswered",
      reason: "codex exited with 1: 401 Unauthorized"
    });
  });
});
