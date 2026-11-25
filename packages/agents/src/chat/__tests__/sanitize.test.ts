import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { byteLength, enforceRowSizeLimit, ROW_MAX_BYTES } from "../sanitize";

/**
 * `enforceRowSizeLimit` ships only for released Think (0.21-0.24) and
 * ai-chat (0.10-0.11), which call it on assistant messages with large tool
 * outputs before storing them. These tests keep that path covered while it
 * ships.
 */
describe("enforceRowSizeLimit", () => {
  it("compacts oversized object tool outputs without changing their shape", () => {
    const largeContent = "x".repeat(ROW_MAX_BYTES + 200_000);
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
    expect(byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      ROW_MAX_BYTES
    );
  });

  it("falls back to a compact marker when object shape is too large to preserve", () => {
    const primitiveHeavyOutput = Object.fromEntries(
      Array.from({ length: Math.ceil(ROW_MAX_BYTES / 14) }, (_, i) => [
        `key-${i}`,
        i
      ])
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
