import { describe, expect, it } from "vitest";
import {
  type AnthropicRequest,
  checkpointsOf,
  DEFAULT_SCRIPT,
  modelCheckpoints,
  type Resolved,
  renderReply,
  resolveStep,
  type Script,
  scriptProblem,
  type StreamItem
} from "../script";

type Message = NonNullable<AnthropicRequest["messages"]>[number];

const user = (content: Message["content"]): Message => ({
  role: "user",
  content
});
const assistant = (...content: Array<Record<string, unknown>>): Message => ({
  role: "assistant",
  content: content as Array<{ type: string }>
});
const text = (value: string) => ({ type: "text", text: value });
const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input
});
const toolResult = (id: string): Message =>
  user([{ type: "tool_result", tool_use_id: id, content: "ok" }]);
const request = (...messages: Message[]): AnthropicRequest => ({
  stream: true,
  messages
});

/** The fields of the SSE events these tests read. */
type Event = {
  type: string;
  index: number;
  content_block: { type: string; id?: string };
  delta: {
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
};

/** The SSE events of a reply, without its checkpoints. */
const events = (items: StreamItem[]) =>
  items.flatMap((item) =>
    item.type === "event" ? [item.data as unknown as Event] : []
  );

/** What a client would assemble from the reply. */
function reply(items: StreamItem[]) {
  const blocks: Array<{ type: string; text: string; id?: string }> = [];
  let stopReason: string | undefined;
  for (const e of events(items)) {
    if (e.type === "content_block_start") {
      blocks.push({
        type: e.content_block.type,
        text: "",
        id: e.content_block.id
      });
    } else if (e.type === "content_block_delta") {
      const d = e.delta;
      blocks[e.index].text += d.text ?? d.thinking ?? d.partial_json ?? "";
    } else if (e.type === "message_delta") {
      stopReason = e.delta.stop_reason;
    }
  }
  return { blocks, stopReason };
}

const checkpoints = (items: StreamItem[]) =>
  items.flatMap((item) => (item.type === "checkpoint" ? [item.id] : []));

/** One turn: text and a tool, then more text after the tool, then a reply. */
const TOOL_THEN_TEXT: Script = [
  {
    id: "mix",
    steps: [
      {
        blocks: [
          { kind: "thinking", text: "Let me look that up." },
          { kind: "text", text: "Looking it up." },
          { kind: "tool", name: "lookup", input: { key: "k" } },
          { kind: "text", text: "Done looking." }
        ]
      },
      { blocks: [{ kind: "text", text: "The answer is 42." }] }
    ]
  }
];

const resolved = (r: Resolved) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("resolveStep", () => {
  it("answers a turn's first request with its first step", () => {
    const r = resolved(
      resolveStep(request(user("[t1] Say hello.")), DEFAULT_SCRIPT)
    );
    expect([r.turn.id, r.step, r.resume]).toEqual(["t1", 0, undefined]);
  });

  it("answers the request after a tool result with the next step", () => {
    const r = resolved(
      resolveStep(
        request(
          user("[t2] Record alpha."),
          assistant(
            text("Recording alpha now."),
            toolUse("toolu_t2_s0_b2", "record", { key: "alpha" })
          ),
          toolResult("toolu_t2_s0_b2")
        ),
        DEFAULT_SCRIPT
      )
    );
    expect([r.turn.id, r.step, r.resume]).toEqual(["t2", 1, undefined]);
  });

  it("answers from the newest marked user message", () => {
    const r = resolved(
      resolveStep(
        request(
          user("[t1] Say hello."),
          assistant(text("Hello! How can I help you today?")),
          user("[t2] Record alpha.")
        ),
        DEFAULT_SCRIPT
      )
    );
    expect([r.turn.id, r.step]).toEqual(["t2", 0]);
  });

  it("answers a message naming several turns with the latest in the script", () => {
    const r = resolved(
      resolveStep(request(user("[t8] and [t7]")), DEFAULT_SCRIPT)
    );
    expect(r.turn.id).toBe("t8");
  });

  it("ignores markers the script does not have", () => {
    const r = resolveStep(request(user("[nope] hi")), DEFAULT_SCRIPT);
    expect(r).toEqual({ ok: false, reason: "no turn marker" });
  });

  it("continues a reply that stopped short of its text", () => {
    const r = resolved(
      resolveStep(
        request(user("[t1] Say hello."), assistant(text("Hello! How"))),
        DEFAULT_SCRIPT
      )
    );
    expect([r.step, r.resume]).toEqual([0, { text: 10, tools: 0 }]);
  });

  it("counts resent thinking as thinking, not reply text", () => {
    const r = resolved(
      resolveStep(
        request(
          user("[t1] Say hello."),
          assistant(text("The user greets me, so"))
        ),
        DEFAULT_SCRIPT
      )
    );
    expect(r.resume).toEqual({ text: 0, tools: 0 });
  });

  it("marks a request to continue a complete final step as nothing left", () => {
    const r = resolved(
      resolveStep(
        request(
          user("[t1] Say hello."),
          assistant(text("Hello! How can I help you today?")),
          user("Continue from where you left off.")
        ),
        DEFAULT_SCRIPT
      )
    );
    expect([r.step, r.nothingLeft]).toEqual([0, true]);
  });

  it("does not answer past the turn's last step otherwise", () => {
    const r = resolveStep(
      request(
        user("[t1] Say hello."),
        assistant(text("Hello! How can I help you today?")),
        user([{ type: "tool_result", tool_use_id: "x", content: "" }])
      ),
      DEFAULT_SCRIPT
    );
    expect(r).toEqual({ ok: false, reason: "t1 has no step 1" });
  });
});

describe("renderReply", () => {
  it("streams the whole step, passing its checkpoints in order", () => {
    const r = resolved(
      resolveStep(request(user("[t2] Record alpha.")), DEFAULT_SCRIPT)
    );
    const items = renderReply(r, "faithful", 0);
    expect(reply(items)).toEqual({
      blocks: [
        {
          type: "thinking",
          text: "I should call the record tool with the key alpha.",
          id: undefined
        },
        { type: "text", text: "Recording alpha now.", id: undefined },
        { type: "tool_use", text: '{"key":"alpha"}', id: "toolu_t2_s0_b2" }
      ],
      stopReason: "tool_use"
    });
    expect(checkpoints(items)).toEqual(
      modelCheckpoints("t2", 0, DEFAULT_SCRIPT[1].steps[0])
    );
  });

  it("continues with the rest of the text, numbering checkpoints by the step", () => {
    const r = resolved(
      resolveStep(
        request(user("[t1] Say hello."), assistant(text("Hello! How"))),
        DEFAULT_SCRIPT
      )
    );
    const items = renderReply(r, "faithful", 0);
    expect(reply(items).blocks).toEqual([
      { type: "text", text: " can I help you today?", id: undefined }
    ]);
    expect(checkpoints(items)).toEqual([
      "t1.s0.request",
      "t1.s0.b1.text.start",
      "t1.s0.b1.text.end",
      "t1.s0.done"
    ]);
  });

  it("restarts an interrupted step under restart, with new tool call IDs", () => {
    const r = resolved(
      resolveStep(
        request(user("[t2] Record alpha."), assistant(text("Recording"))),
        DEFAULT_SCRIPT
      )
    );
    const { blocks } = reply(renderReply(r, "restart", 3));
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(blocks[2].id).toBe("toolu_t2_s0_b2_g3");
  });

  for (const continuation of ["faithful", "restart"] as const) {
    it(`answers nothing left with an empty reply under ${continuation}`, () => {
      const r = resolved(
        resolveStep(
          request(
            user("[t2] Record alpha."),
            assistant(
              text("Recording alpha now."),
              toolUse("toolu_t2_s0_b2", "record", { key: "alpha" })
            ),
            toolResult("toolu_t2_s0_b2"),
            assistant(text("Recorded alpha.")),
            user("Continue from where you left off.")
          ),
          DEFAULT_SCRIPT
        )
      );
      expect(r.nothingLeft).toBe(true);
      expect(reply(renderReply(r, continuation, 1))).toEqual({
        blocks: [],
        stopReason: "end_turn"
      });
    });
  }

  it("ends a continuation that only finishes text with end_turn", () => {
    const r = resolved(
      resolveStep(
        request(
          user("[mix] go"),
          assistant(
            text("Looking it up."),
            toolUse("toolu_mix_s0_b2", "lookup", { key: "k" }),
            text("Done")
          )
        ),
        TOOL_THEN_TEXT
      )
    );
    expect(reply(renderReply(r, "faithful", 0))).toEqual({
      blocks: [{ type: "text", text: " looking.", id: undefined }],
      stopReason: "end_turn"
    });
  });

  it("answers an unmatched request with a visible fallback", () => {
    const r = resolveStep(request(user("hello")), DEFAULT_SCRIPT);
    expect(reply(renderReply(r, "faithful", 0)).blocks).toEqual([
      { type: "text", text: "(fake-model: no turn marker)", id: undefined }
    ]);
  });
});

describe("scripts", () => {
  it("accepts the default script", () => {
    expect(scriptProblem(DEFAULT_SCRIPT)).toBeUndefined();
  });

  it.each([
    [[], "script must be a non-empty array of turns"],
    [
      [{ id: "a b", steps: [] }],
      "script[0].id must be letters, digits, _ or -"
    ],
    [
      [
        { id: "a", steps: [{ blocks: [{ kind: "text", text: "x" }] }] },
        { id: "a", steps: [{ blocks: [{ kind: "text", text: "y" }] }] }
      ],
      "script[1].id a is not unique"
    ],
    [[{ id: "a", steps: [] }], "script[0].steps must be a non-empty array"],
    [
      [{ id: "a", steps: [{ blocks: [{ kind: "poem" }] }] }],
      "script[0].steps[0].blocks[0].kind must be thinking, text or tool"
    ],
    [
      [
        {
          id: "a",
          steps: [{ blocks: [{ kind: "tool", name: "t", input: [] }] }]
        }
      ],
      "script[0].steps[0].blocks[0].input must be an object"
    ]
  ])("rejects %j", (script, problem) => {
    expect(scriptProblem(script)).toBe(problem);
  });

  it("lists model and tool checkpoints in run order", () => {
    expect(checkpointsOf(TOOL_THEN_TEXT)).toEqual([
      "mix.s0.request",
      "mix.s0.b0.thinking.start",
      "mix.s0.b0.thinking.end",
      "mix.s0.b1.text.start",
      "mix.s0.b1.text.end",
      "mix.s0.b2.tool.start",
      "mix.s0.b2.tool.end",
      "mix.s0.b3.text.start",
      "mix.s0.b3.text.end",
      "mix.s0.done",
      "mix.tool.k",
      "mix.s1.request",
      "mix.s1.b0.text.start",
      "mix.s1.b0.text.end",
      "mix.s1.done"
    ]);
  });
});
