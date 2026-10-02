import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ToolPart } from "../protocol";
import { type Context, TranscriptView } from "../web/tui/components/blocks";
import { PendingView, StatusBar } from "../web/tui/components/footer";
import { ClientToolModal, ReasonModal } from "../web/tui/components/modal";
import { type Block, initialUi, type Status } from "../web/tui/view";

const tool: ToolPart = {
  type: "tool",
  toolCallId: "c1",
  toolName: "aVeryLongToolNameThatKeepsGoing",
  state: "approval-requested",
  input: { path: "/a/very/long/path/that/does/not/fit/anywhere", n: 1 },
  approval: { id: "a1" }
};

const blocks: Block[] = [
  {
    kind: "user",
    key: "m1",
    text: "a long message ".repeat(10),
    from: { you: false, name: "Ann with a long name" }
  },
  {
    kind: "reasoning",
    key: "r",
    text: "thinking ".repeat(40),
    streaming: true
  },
  {
    kind: "text",
    key: "t",
    text: "# Title\n\nSome `code` and\n\n```ts\nconst x: number = 1; // a long trailing comment\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    streaming: false
  },
  { kind: "tool", key: "tool:c1", part: tool, turnId: "t1", turn: "awaiting" },
  { kind: "attachment", key: "f", label: "file a-very-long-file-name.png" },
  { kind: "notice", key: "n", text: "✗ Turn failed: ".repeat(5), tone: "error" }
];

const status: Status = {
  connected: false,
  seen: true,
  you: "terminal-123456",
  running: { turnId: "t", yours: true, seconds: 75, cancelling: true },
  queued: [{ turnId: "q", label: "queued ".repeat(20), yours: true }],
  awaiting: 2,
  sending: [{ eventId: "e", label: "sending ".repeat(20) }]
};

const fakeTui = {
  terminal: { rows: 24, columns: 80 },
  requestRender() {}
} as unknown as TUI;

describe("tui rendering", () => {
  for (const width of [6, 12, 30, 80]) {
    it(`fits every line in ${width} columns`, () => {
      for (const expanded of [true, false]) {
        const context: Context = {
          frame: 3,
          you: "me",
          ui: {
            ...initialUi,
            toolsExpanded: expanded,
            reasoningExpanded: expanded,
            selected: "tool:c1"
          }
        };
        const transcript = new TranscriptView(context);
        transcript.update(blocks);
        const pending = new PendingView();
        pending.status = status;
        pending.prompts = ["aVeryLongToolNameThatKeepsGoing"];
        const bar = new StatusBar("example.com/agents/a/b/channels", context);
        bar.status = status;
        const lines = [
          ...transcript.render(width),
          ...pending.render(width),
          ...bar.render(width),
          ...new ClientToolModal(
            fakeTui,
            tool,
            () => {},
            () => {}
          ).render(width),
          ...new ReasonModal(
            tool,
            () => {},
            () => {}
          ).render(width)
        ];
        for (const line of lines) {
          expect(visibleWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(
            width
          );
        }
      }
    });
  }
});
