import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  byteLength,
  enforceRowSizeLimit,
  ROW_MAX_BYTES
} from "../../chat/sanitize";
import {
  COMPACTION_PREFIX,
  createCompactFunction,
  isCompactionMessage,
  type SessionMessage
} from "../../sessions";

function textMessage(id: string, text: string, role = "user"): SessionMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

/** A conversation long enough to have a compressible middle. */
function conversation(count: number): SessionMessage[] {
  return Array.from({ length: count }, (_, index) =>
    textMessage(
      `m${index}`,
      `turn ${index} ${"body ".repeat(20)}`,
      index % 2 === 0 ? "user" : "assistant"
    )
  );
}

describe("createCompactFunction", () => {
  it("returns null for a conversation with no compressible middle", async () => {
    const compact = createCompactFunction({
      summarize: async () => {
        throw new Error("must not summarize");
      }
    });
    expect(await compact(conversation(5))).toBeNull();
  });

  it("summarizes the middle and protects the head and tail", async () => {
    let prompt = "";
    const compact = createCompactFunction({
      summarize: async (received) => {
        prompt = received;
        return "the summary";
      },
      keepRecentTokens: 1
    });
    const messages = conversation(12);

    const result = await compact(messages);
    expect(result).not.toBeNull();
    // The first three messages stay verbatim, so the range starts at m3.
    expect(result?.fromMessageId).toBe("m3");
    expect(result?.summary).toBe("the summary");
    // At least the last two messages are protected from the range.
    expect(result?.toMessageId).not.toBe("m11");
    expect(prompt).toContain("turn 3");
    expect(prompt).not.toContain("turn 11");
  });

  it("feeds a previous overlay back in and never puts it in the range", async () => {
    let prompt = "";
    const compact = createCompactFunction({
      summarize: async (received) => {
        prompt = received;
        return "second summary";
      },
      keepRecentTokens: 1
    });
    const messages = conversation(12);
    const overlay = textMessage(
      `${COMPACTION_PREFIX}earlier`,
      "previous summary",
      "assistant"
    );
    messages.splice(4, 0, overlay);
    expect(isCompactionMessage(overlay)).toBe(true);

    const result = await compact(messages);
    expect(result?.fromMessageId).not.toContain(COMPACTION_PREFIX);
    expect(result?.toMessageId).not.toContain(COMPACTION_PREFIX);
    expect(prompt).toContain("previous summary");
  });

  it("returns null when the model produces an empty summary", async () => {
    const compact = createCompactFunction({
      summarize: async () => "   ",
      keepRecentTokens: 1
    });
    expect(await compact(conversation(12))).toBeNull();
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
