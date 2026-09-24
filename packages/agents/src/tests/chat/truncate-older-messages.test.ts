import { describe, expect, it } from "vitest";
import type { ModelMessage, ToolModelMessage } from "ai";
import {
  truncateOlderMessages,
  truncateOlderToolResults
} from "../../chat/truncate-older-messages";
import type { SessionMessage } from "../../sessions";

type ToolResultOutput = Extract<
  ToolModelMessage["content"][number],
  { type: "tool-result" }
>["output"];

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

  it("never truncates provider-executed tool outputs", () => {
    const providerOutput = [
      { url: "https://a", encryptedContent: "e".repeat(2000) }
    ];
    const old = toolMessage("old-search", providerOutput);
    (old.parts[0] as { providerExecuted?: boolean }).providerExecuted = true;
    const messages = [
      old,
      textMessage("recent-1", "recent one"),
      textMessage("recent-2", "recent two")
    ];

    const truncated = truncateOlderMessages(messages, {
      keepRecent: 2,
      maxToolOutputChars: 100
    });

    expect(firstOutput(truncated[0])).toBe(providerOutput);
  });

  it("leaves tool outputs intact when toolOutputs is false", () => {
    const output = { content: "x".repeat(1000) };
    const messages = [
      toolMessage("old-tool", output),
      textMessage("old-user", "q".repeat(200)),
      textMessage("recent-1", "recent one"),
      textMessage("recent-2", "recent two")
    ];

    const truncated = truncateOlderMessages(messages, {
      keepRecent: 2,
      maxToolOutputChars: 100,
      maxTextChars: 100,
      toolOutputs: false
    });

    expect(firstOutput(truncated[0])).toBe(output);
    expect((truncated[1].parts[0] as { text: string }).text).toContain(
      "[truncated"
    );
  });
});

describe("truncateOlderToolResults", () => {
  function toolResults(
    ...results: Array<[toolCallId: string, output: ToolResultOutput]>
  ): ModelMessage {
    return {
      role: "tool",
      content: results.map(([toolCallId, output]) => ({
        type: "tool-result",
        toolCallId,
        toolName: "read",
        output
      }))
    };
  }

  function outputOf(message: ModelMessage, index = 0): ToolResultOutput {
    const part = (message as ToolModelMessage).content[index];
    if (part.type !== "tool-result") throw new Error("not a tool result");
    return part.output;
  }

  it("truncates converted results of older messages and keeps recent ones", () => {
    const messages = [
      toolMessage("old", {}),
      toolMessage("recent", {}),
      textMessage("recent-user", "hi")
    ];
    const oldJson: ToolResultOutput = {
      type: "json",
      value: { rows: "x".repeat(1000) }
    };
    const recentText: ToolResultOutput = {
      type: "text",
      value: "y".repeat(1000)
    };
    const modelMessages = [
      toolResults(["tc-old", oldJson]),
      toolResults(["tc-recent", recentText])
    ];

    const truncated = truncateOlderToolResults(modelMessages, messages, {
      keepRecent: 2,
      maxToolOutputChars: 100
    });

    const old = outputOf(truncated[0]);
    expect(old.type).toBe("json");
    expect(JSON.stringify(old)).toContain("[truncated");
    expect(outputOf(truncated[1])).toBe(recentText);
    expect(outputOf(modelMessages[0])).toBe(oldJson);
  });

  it("truncates text items of content results and keeps media", () => {
    const messages = [
      toolMessage("old", {}),
      textMessage("recent-1", "recent one"),
      textMessage("recent-2", "recent two")
    ];
    const media = {
      type: "image-data" as const,
      data: "AAAA",
      mediaType: "image/png"
    };
    const modelMessages = [
      toolResults([
        "tc-old",
        {
          type: "content",
          value: [{ type: "text", text: "z".repeat(1000) }, media]
        }
      ])
    ];

    const [message] = truncateOlderToolResults(modelMessages, messages, {
      keepRecent: 2,
      maxToolOutputChars: 100
    });

    const output = outputOf(message);
    if (output.type !== "content") throw new Error("expected content");
    const [text, kept] = output.value;
    expect(text.type === "text" && text.text).toContain("[truncated");
    expect(kept).toBe(media);
  });

  it("bounds the combined text of a content result by one budget", () => {
    const messages = [
      toolMessage("old", {}),
      textMessage("recent-1", "recent one"),
      textMessage("recent-2", "recent two")
    ];
    const media = {
      type: "image-data" as const,
      data: "AAAA",
      mediaType: "image/png"
    };
    const modelMessages = [
      toolResults([
        "tc-old",
        {
          type: "content",
          value: [
            ...Array.from({ length: 10 }, () => ({
              type: "text" as const,
              text: "q".repeat(400)
            })),
            media
          ]
        }
      ])
    ];

    const [message] = truncateOlderToolResults(modelMessages, messages, {
      keepRecent: 2,
      maxToolOutputChars: 500
    });

    const output = outputOf(message);
    if (output.type !== "content") throw new Error("expected content");
    const texts = output.value.flatMap((item) =>
      item.type === "text" ? [item.text] : []
    );
    expect(texts.join("").length).toBeLessThanOrEqual(500);
    expect(texts[0]).toBe("q".repeat(400));
    expect(texts[1]).toContain("[truncated");
    expect(output.value.at(-1)).toBe(media);
  });

  it("marks text dropped after earlier items fill the budget exactly", () => {
    const messages = [
      toolMessage("old", {}),
      textMessage("recent-1", "recent one"),
      textMessage("recent-2", "recent two")
    ];
    const modelMessages = [
      toolResults([
        "tc-old",
        {
          type: "content",
          value: [
            { type: "text", text: "a".repeat(500) },
            { type: "text", text: "error details" }
          ]
        }
      ])
    ];

    const [message] = truncateOlderToolResults(modelMessages, messages, {
      keepRecent: 2,
      maxToolOutputChars: 500
    });

    const output = outputOf(message);
    if (output.type !== "content") throw new Error("expected content");
    const texts = output.value.flatMap((item) =>
      item.type === "text" ? [item.text] : []
    );
    expect(texts.join("").length).toBeLessThanOrEqual(500);
    expect(texts.at(-1)).toContain("[truncated");
  });

  it("leaves provider-executed results intact", () => {
    const old = toolMessage("old", {});
    (old.parts[0] as { providerExecuted?: boolean }).providerExecuted = true;
    const messages = [
      old,
      textMessage("recent-1", "recent one"),
      textMessage("recent-2", "recent two")
    ];
    const modelMessages = [
      toolResults(["tc-old", { type: "text", value: "p".repeat(1000) }])
    ];

    expect(
      truncateOlderToolResults(modelMessages, messages, {
        keepRecent: 2,
        maxToolOutputChars: 100
      })
    ).toBe(modelMessages);
  });
});
