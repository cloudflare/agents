import { describe, expect, it } from "vitest";
import { truncateOlderMessages } from "../../chat/truncate-older-messages";
import type { SessionMessage } from "../../sessions";

/**
 * Read-time truncation is a chat concern: it shapes what goes to the model,
 * never what Sessions stores. Sessions itself never truncates content.
 */

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
