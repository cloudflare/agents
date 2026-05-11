import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  byteLength,
  enforceRowSizeLimit,
  ROW_MAX_BYTES
} from "../../../../chat/sanitize";
import { truncateOlderMessages } from "../../../../experimental/memory/utils/compaction";
import type { SessionMessage } from "../../../../experimental/memory/session/types";

function textMessage(id: string, text: string): SessionMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }]
  };
}

function toolMessage(id: string, output: unknown): SessionMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-read",
        toolCallId: `tc-${id}`,
        toolName: "read",
        state: "output-available",
        input: { path: "/large.txt" },
        output
      }
    ]
  };
}

function firstOutput(message: SessionMessage): unknown {
  return message.parts[0].output;
}

describe("truncateOlderMessages", () => {
  it("truncates older object tool outputs without changing their shape", () => {
    const largeContent = "x".repeat(1000);
    const messages = [
      toolMessage("old-tool", {
        path: "/large.txt",
        content: largeContent,
        totalLines: 1
      }),
      textMessage("old-user", "next"),
      textMessage("recent-1", "recent one"),
      textMessage("recent-2", "recent two")
    ];

    const truncated = truncateOlderMessages(messages, {
      keepRecent: 2,
      maxToolOutputChars: 100
    });
    const output = firstOutput(truncated[0]);

    expect(output).toMatchObject({
      path: "/large.txt",
      totalLines: 1
    });
    expect(typeof output).toBe("object");
    expect((output as { content: string }).content).toContain("[truncated");
    expect((output as { content: string }).content.length).toBeLessThan(
      largeContent.length
    );
    expect(firstOutput(messages[0])).toMatchObject({ content: largeContent });
  });

  it("preserves truncation context for nested arrays with small budgets", () => {
    const messages = [
      toolMessage("old-tool", {
        a: Array.from({ length: 1000 }, (_, i) => i),
        b: Array.from({ length: 1000 }, (_, i) => i),
        c: Array.from({ length: 1000 }, (_, i) => i),
        d: Array.from({ length: 1000 }, (_, i) => i),
        e: Array.from({ length: 1000 }, (_, i) => i),
        f: Array.from({ length: 1000 }, (_, i) => i),
        g: Array.from({ length: 1000 }, (_, i) => i)
      }),
      textMessage("recent-1", "recent one"),
      textMessage("recent-2", "recent two")
    ];

    const truncated = truncateOlderMessages(messages, {
      keepRecent: 2,
      maxToolOutputChars: 500
    });
    const output = firstOutput(truncated[0]) as {
      a: Array<Record<string, unknown> | string>;
    };

    expect(output.a).toHaveLength(1);
    expect(output.a[0]).not.toBe("");
    expect(output.a[0]).toMatchObject({
      __truncated: true,
      __truncatedChars: expect.any(Number)
    });
  });

  it("leaves recent tool outputs intact", () => {
    const recentOutput = {
      path: "/recent.txt",
      content: "y".repeat(1000),
      totalLines: 1
    };
    const messages = [
      textMessage("old-1", "old"),
      textMessage("old-2", "old"),
      toolMessage("recent-tool", recentOutput)
    ];

    const truncated = truncateOlderMessages(messages, {
      keepRecent: 2,
      maxToolOutputChars: 100
    });

    expect(firstOutput(truncated[2])).toBe(recentOutput);
  });

  it("keeps string tool outputs as strings", () => {
    const messages = [
      toolMessage("old-tool", "z".repeat(1000)),
      textMessage("recent-1", "recent one"),
      textMessage("recent-2", "recent two")
    ];

    const truncated = truncateOlderMessages(messages, {
      keepRecent: 2,
      maxToolOutputChars: 100
    });
    const output = firstOutput(truncated[0]);

    expect(typeof output).toBe("string");
    expect(output).toContain("[truncated");
  });
});

describe("enforceRowSizeLimit", () => {
  it("compacts oversized object tool outputs without changing their shape", () => {
    const largeContent = "x".repeat(2_000_000);
    const message: UIMessage = {
      id: "tool-big",
      role: "assistant",
      parts: [
        {
          type: "tool-read",
          toolCallId: "tc-1",
          toolName: "read",
          state: "output-available",
          input: { path: "/large.txt" },
          output: {
            path: "/large.txt",
            content: largeContent,
            totalLines: 1
          }
        } as UIMessage["parts"][number]
      ]
    };

    const result = enforceRowSizeLimit(message);
    const output = result.parts[0] as { output: unknown };

    expect(output.output).toMatchObject({
      path: "/large.txt",
      totalLines: 1
    });
    expect((output.output as { content: string }).content).toContain(
      "[truncated"
    );
    expect((output.output as { content: string }).content.length).toBeLessThan(
      largeContent.length
    );
  });

  it("falls back to a compact marker when object shape is too large to preserve", () => {
    const primitiveHeavyOutput = Object.fromEntries(
      Array.from({ length: 140_000 }, (_, i) => [`key-${i}`, i])
    );
    const message: UIMessage = {
      id: "tool-primitive-heavy",
      role: "assistant",
      parts: [
        {
          type: "tool-map",
          toolCallId: "tc-1",
          toolName: "map",
          state: "output-available",
          input: {},
          output: primitiveHeavyOutput
        } as UIMessage["parts"][number]
      ]
    };

    const result = enforceRowSizeLimit(message);
    const output = (result.parts[0] as { output: Record<string, unknown> })
      .output;

    expect(byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      ROW_MAX_BYTES
    );
    expect(output.__truncated).toBe(true);
    expect(output.__truncatedChars).toBeGreaterThan(ROW_MAX_BYTES);
  });
});
