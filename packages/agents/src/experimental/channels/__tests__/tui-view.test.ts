import { describe, expect, it } from "vitest";
import type { ToolPart, TranscriptMessage, TurnStatus } from "../protocol";
import type { WebChannelClientState } from "../web/client";
import {
  type Block,
  initialUi,
  isExpanded,
  type Local,
  moveSelection,
  nameOf,
  parseOutput,
  prompts,
  sanitize,
  status,
  toggleAll,
  toggleBlock,
  toolPhase,
  transcriptBlocks
} from "../web/tui/view";

const user = (
  id: string,
  text: string,
  metadata?: TranscriptMessage["metadata"]
): TranscriptMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
  ...(metadata && { metadata })
});

const state = (
  messages: TranscriptMessage[],
  turns: TurnStatus[] = []
): WebChannelClientState => ({
  connected: true,
  you: { id: "me" },
  messages,
  turns
});

const local = (over: Partial<Local> = {}): Local => ({
  sent: new Map(),
  outbox: [],
  runningSince: new Map(),
  notices: [],
  ...over
});

describe("tui view", () => {
  it("attributes user messages by the ids this client sent", () => {
    const blocks = transcriptBlocks(
      state([
        user("m1", "mine"),
        user("m2", "theirs"),
        user("m3", "named", { sender: { name: "Ann" } })
      ]),
      local({ sent: new Map([["e1", { messageId: "m1", text: "mine" }]]) })
    );
    expect(blocks).toEqual([
      { kind: "user", key: "m1", text: "mine", from: { you: true } },
      { kind: "user", key: "m2", text: "theirs", from: { you: false } },
      {
        kind: "user",
        key: "m3",
        text: "named",
        from: { you: false, name: "Ann" }
      }
    ]);
  });

  it("reads a sender name from common metadata shapes", () => {
    expect(nameOf({ sender: "Bo" })).toEqual({ name: "Bo" });
    expect(nameOf({ participant: { id: "p1" } })).toEqual({ name: "p1" });
    expect(nameOf({ owner: "x" })).toEqual({});
    expect(nameOf(undefined)).toEqual({});
  });

  it("splits an assistant message into blocks, streaming the last part", () => {
    const assistant: TranscriptMessage = {
      id: "r1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "hmm" },
        {
          type: "tool",
          toolCallId: "c1",
          toolName: "getLocation",
          state: "input-available",
          input: {}
        },
        { type: "file", mediaType: "image/png", url: "u", filename: "a.png" },
        { type: "text", text: "Hello" }
      ]
    };
    const running: TurnStatus = {
      turnId: "t1",
      startedBy: "e1",
      status: "running",
      responseId: "r1"
    };
    const blocks = transcriptBlocks(state([assistant], [running]), local());
    expect(blocks.map((b) => [b.kind, b.key])).toEqual([
      ["reasoning", "r1:0"],
      ["tool", "tool:c1"],
      ["attachment", "r1:2"],
      ["text", "r1:3"]
    ]);
    expect(blocks[0]).toMatchObject({ streaming: false });
    expect(blocks[1]).toMatchObject({ turnId: "t1", turn: "running" });
    expect(blocks[3]).toMatchObject({ streaming: true });
  });

  it("links a saved message to the turn awaiting input on it", () => {
    const assistant: TranscriptMessage = {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool",
          toolCallId: "c1",
          toolName: "forgetEverything",
          state: "approval-requested",
          approval: { id: "ap1" }
        }
      ]
    };
    const awaiting: TurnStatus = {
      turnId: "t1",
      startedBy: "e1",
      status: "settled",
      outcome: "awaiting-input",
      messageIds: ["a1"]
    };
    const [block] = transcriptBlocks(state([assistant], [awaiting]), local());
    expect(block).toMatchObject({
      kind: "tool",
      turnId: "t1",
      turn: "awaiting"
    });
  });

  it("places notices after their message, or at the end", () => {
    const blocks = transcriptBlocks(
      state([user("m1", "a"), user("m2", "b")]),
      local({
        notices: [
          { key: "n1", text: "end", tone: "info" },
          { key: "n2", text: "after m1", tone: "error", after: "m1" },
          { key: "n3", text: "gone", tone: "info", after: "zz" }
        ]
      })
    );
    expect(blocks.map((b) => b.key)).toEqual(["m1", "n2", "m2", "n1", "n3"]);
  });

  it("summarises turns and sends for the status bar", () => {
    const turns: TurnStatus[] = [
      { turnId: "t1", startedBy: "e1", status: "running", responseId: "r1" },
      { turnId: "t2", startedBy: "e2", status: "queued" },
      { turnId: "t3", startedBy: "x", status: "queued" },
      {
        turnId: "t4",
        startedBy: "y",
        status: "settled",
        outcome: "awaiting-input",
        messageIds: []
      }
    ];
    const view = local({
      sent: new Map([
        ["e1", { messageId: "m1", text: "first" }],
        ["e2", { messageId: "m2", text: "second" }]
      ]),
      outbox: [{ eventId: "e5", label: "third" }],
      runningSince: new Map([["t1", 1_000]])
    });
    expect(status(state([], turns), view, 66_500, true)).toEqual({
      connected: true,
      seen: true,
      you: "me",
      running: { turnId: "t1", yours: true, seconds: 65 },
      queued: [
        { turnId: "t2", label: "second", yours: true },
        { turnId: "t3", label: "", yours: false }
      ],
      awaiting: 1,
      sending: [{ eventId: "e5", label: "third" }]
    });
  });
});

describe("tui view helpers", () => {
  it("strips what could drive the terminal", () => {
    expect(
      sanitize("a\tb\r\nc\x1b[31mred\x1b[0m\x1b]8;;http://x\x07link\x07\x9b")
    ).toBe("a    b\ncredlink");
  });

  it("toggles blocks one at a time and all of a kind", () => {
    const blocks: Block[] = [
      { kind: "reasoning", key: "r", text: "", streaming: false },
      {
        kind: "tool",
        key: "t",
        part: {
          type: "tool",
          toolCallId: "c",
          toolName: "x",
          state: "output-available"
        }
      }
    ];
    const [reasoning, tool] = blocks as [
      Extract<Block, { kind: "reasoning" }>,
      Extract<Block, { kind: "tool" }>
    ];
    let ui = initialUi;
    expect([isExpanded(reasoning, ui), isExpanded(tool, ui)]).toEqual([
      false,
      true
    ]);
    ui = toggleBlock(ui, "t");
    expect(isExpanded(tool, ui)).toBe(false);
    ui = toggleAll(ui, "tool", blocks);
    expect(isExpanded(tool, ui)).toBe(false);
    expect(ui.toggled.size).toBe(0);
    ui = toggleAll(ui, "reasoning", blocks);
    expect(isExpanded(reasoning, ui)).toBe(true);
  });

  it("moves the selection through collapsible blocks", () => {
    const blocks: Block[] = [
      { kind: "reasoning", key: "a", text: "", streaming: false },
      { kind: "text", key: "b", text: "", streaming: false },
      { kind: "reasoning", key: "c", text: "", streaming: false }
    ];
    expect(moveSelection(blocks, undefined, "up")).toBe("c");
    expect(moveSelection(blocks, undefined, "down")).toBeUndefined();
    expect(moveSelection(blocks, "c", "up")).toBe("a");
    expect(moveSelection(blocks, "a", "up")).toBe("a");
    expect(moveSelection(blocks, "c", "down")).toBeUndefined();
  });

  it("names where a tool call stands", () => {
    const part = (over: Partial<ToolPart>): ToolPart => ({
      type: "tool",
      toolCallId: "c",
      toolName: "x",
      state: "input-available",
      ...over
    });
    expect(toolPhase(part({}), "running")).toBe("running");
    expect(toolPhase(part({}))).toBe("stopped");
    const client = part({ owner: "me" });
    expect(toolPhase(client, "running")).toBe("preparing");
    expect(toolPhase(client, "awaiting")).toBe("client");
    const approval = part({ state: "approval-requested" });
    expect(toolPhase(approval, "running")).toBe("preparing");
    expect(toolPhase(approval, "awaiting")).toBe("approval");
    expect(toolPhase(approval)).toBe("stopped");
    expect(
      toolPhase(
        part({
          state: "approval-responded",
          approval: { id: "a", approved: false }
        }),
        "running"
      )
    ).toBe("denied");
    expect(
      toolPhase(
        part({ state: "output-available", preliminary: true }),
        "running"
      )
    ).toBe("running");
    expect(toolPhase(part({ state: "output-available" }))).toBe("done");
    expect(toolPhase(part({ state: "output-error" }))).toBe("error");
  });

  it("asks this participant only for approvals and its own client calls", () => {
    const block = (
      over: Partial<ToolPart>,
      turn?: "running" | "awaiting"
    ): Block => ({
      kind: "tool",
      key: `tool:${over.toolCallId}`,
      part: {
        type: "tool",
        toolCallId: "c",
        toolName: "x",
        state: "input-available",
        ...over
      },
      ...(turn && { turnId: "t", turn })
    });
    const blocks = [
      block({ toolCallId: "a", state: "approval-requested" }, "awaiting"),
      block({ toolCallId: "b", owner: "me" }, "awaiting"),
      block({ toolCallId: "c", owner: "them" }, "awaiting"),
      block({ toolCallId: "d", owner: "me" }, "running"),
      { ...block({ toolCallId: "e", owner: "me" }, "awaiting"), sending: true }
    ] as Block[];
    expect(prompts(blocks, "me").map((b) => b.key)).toEqual([
      "tool:a",
      "tool:b"
    ]);
  });

  it("keeps one block per tool call when a live response overlaps its save", () => {
    const call = {
      type: "tool",
      toolCallId: "c1",
      toolName: "x",
      state: "input-available"
    } as const;
    const blocks = transcriptBlocks(
      state(
        [
          { id: "saved", role: "assistant", parts: [call] },
          { id: "r1", role: "assistant", parts: [call] }
        ],
        [{ turnId: "t1", startedBy: "e", status: "running", responseId: "r1" }]
      ),
      local()
    );
    expect(blocks).toEqual([
      {
        kind: "tool",
        key: "tool:c1",
        part: call,
        turnId: "t1",
        turn: "running",
        yours: false
      }
    ]);
  });

  it("reads typed client tool output as JSON when it parses", () => {
    expect(parseOutput('{"a":1}')).toEqual({ a: 1 });
    expect(parseOutput("Lisbon")).toBe("Lisbon");
  });
});
