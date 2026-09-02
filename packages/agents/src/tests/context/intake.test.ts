import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  capText,
  shapeHistory,
  shapeMessage
} from "../../context";
import type { SessionMessage } from "../../sessions";

/**
 * Intake shaping decides what a stored tool result contributes to a request.
 *
 * The property that matters most is stability: shaping one message depends on
 * that message alone, so the same message produces the same bytes on every
 * turn and the prompt prefix a provider caches is never rewritten. That is
 * what separates this from truncating old history, which moves its boundary
 * as the conversation grows.
 */

function toolMessage(
  output: unknown,
  extra: Record<string, unknown> = {}
): SessionMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: [
      { type: "text", text: "calling a tool" },
      {
        type: "tool-read",
        toolCallId: "call-1",
        state: "output-available",
        output,
        ...extra
      }
    ]
  };
}

describe("intake shaping", () => {
  it("leaves output within the limits untouched, by reference", () => {
    const message = toolMessage({ text: "small enough" });
    expect(shapeMessage(message)).toBe(message);
  });

  it("caps oversized text and says where to continue", () => {
    const body = "x".repeat(DEFAULT_MAX_TOOL_OUTPUT_BYTES * 2);
    const shaped = shapeMessage(toolMessage({ text: body }));
    const text = (shaped.parts[1].output as { text: string }).text;

    expect(text.length).toBeLessThan(body.length);
    // A cap without a way forward is a dead end; the model is told the offset
    // to resume from, which is what makes an aggressive cap safe.
    expect(text).toContain(
      `continue from offset=${DEFAULT_MAX_TOOL_OUTPUT_BYTES}`
    );
    expect(text).toContain(`${DEFAULT_MAX_TOOL_OUTPUT_BYTES} bytes truncated`);
  });

  it("caps on lines before bytes when lines run out first", () => {
    const body = `${"line\n".repeat(3_000)}`;
    const shaped = shapeMessage(toolMessage({ text: body }), { maxLines: 10 });
    const text = (shaped.parts[1].output as { text: string }).text;

    expect(text.split("\n").length).toBeLessThanOrEqual(12);
    expect(text).toContain("truncated");
  });

  it("drops host-named duplicate fields", () => {
    // Pi carries a raw provider payload beside the rendered content; that
    // duplicate alone accounted for megabytes in the largest real messages
    // measured. Which field is redundant is the host's call, not ours.
    const message = toolMessage(
      { text: "ok" },
      { details: { huge: "x".repeat(1_000) } }
    );
    const shaped = shapeMessage(message, { dropFields: ["details"] });

    expect(shaped.parts[1]).not.toHaveProperty("details");
    expect(shaped.parts[1].output).toEqual({ text: "ok" });
  });

  it("shapes strings nested inside tool output", () => {
    const body = "y".repeat(DEFAULT_MAX_TOOL_OUTPUT_BYTES * 2);
    const shaped = shapeMessage(
      toolMessage({ content: [{ type: "text", text: body }] })
    );
    const nested = (shaped.parts[1].output as { content: { text: string }[] })
      .content[0];

    expect(nested.text.length).toBeLessThan(body.length);
  });

  it("never shapes anything outside a tool part", () => {
    const body = "z".repeat(DEFAULT_MAX_TOOL_OUTPUT_BYTES * 2);
    const message: SessionMessage = {
      id: "m1",
      role: "assistant",
      parts: [{ type: "text", text: body }]
    };
    // A long assistant answer is not tool output and is not the cap's business.
    expect(shapeMessage(message)).toBe(message);
  });

  it("shapes the same message identically regardless of what precedes it", () => {
    // The cache-safety property, stated as a test: shaping is a function of
    // one message, so a stable prefix stays byte-identical across turns.
    const message = toolMessage({
      text: "q".repeat(DEFAULT_MAX_TOOL_OUTPUT_BYTES * 2)
    });
    const early = shapeMessage(message);
    const late = shapeMessage(message);
    expect(JSON.stringify(late)).toBe(JSON.stringify(early));
  });

  it("cuts on a byte budget without splitting a surrogate pair", () => {
    // 4-byte emoji, with a budget landing mid-run.
    const body = "🙂".repeat(1_000);
    const capped = capText(body, { maxBytes: 101, maxLines: 0 });
    const head = capped.slice(0, capped.indexOf("\n\n["));

    expect(head).toBe("🙂".repeat(25));
    // Valid UTF-8 throughout: a lone surrogate would survive neither the
    // encoder nor SQLite.
    expect(new TextEncoder().encode(head).length).toBeLessThanOrEqual(101);
    expect(head.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)).toBeNull();
  });

  it("streams a shaped history without materializing it", async () => {
    const body = "w".repeat(DEFAULT_MAX_TOOL_OUTPUT_BYTES * 2);
    async function* source() {
      yield toolMessage({ text: body });
      yield toolMessage({ text: "short" });
    }
    const out: SessionMessage[] = [];
    for await (const message of shapeHistory(source())) out.push(message);

    expect(out).toHaveLength(2);
    expect(
      (out[0].parts[1].output as { text: string }).text.length
    ).toBeLessThan(body.length);
    expect((out[1].parts[1].output as { text: string }).text).toBe("short");
  });
});
