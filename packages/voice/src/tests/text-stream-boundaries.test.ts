import { describe, expect, it } from "vitest";
import { iterateText, iterateTextEvents } from "../text-stream";
import type { TextStreamEvent } from "../text-stream";

async function collectText(source: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
}

async function collectEvents(
  source: AsyncIterable<TextStreamEvent>
): Promise<TextStreamEvent[]> {
  const events: TextStreamEvent[] = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}

describe("fullStream text boundaries", () => {
  it("treats non-tool metadata as a text boundary", async () => {
    async function* fullStream() {
      yield { type: "text-delta", id: "a", text: "New" };
      yield { type: "source", sourceId: "s1", url: "https://example.com" };
      yield { type: "text-delta", id: "a", text: "York" };
    }

    const events = await collectEvents(iterateTextEvents(fullStream()));
    expect(events).toEqual([
      { type: "text", text: "New" },
      { type: "boundary" },
      { type: "text", text: " " },
      { type: "text", text: "York" }
    ]);
  });

  it("does not insert duplicate spaces around existing whitespace", async () => {
    async function* trailingWhitespace() {
      yield { type: "text-delta", id: "a", text: "Hello " };
      yield { type: "raw", rawValue: { event: "metadata" } };
      yield { type: "text-delta", id: "a", text: "world" };
    }

    async function* leadingWhitespace() {
      yield { type: "text-delta", id: "a", text: "Hello" };
      yield { type: "raw", rawValue: { event: "metadata" } };
      yield { type: "text-delta", id: "a", text: " world" };
    }

    await expect(
      collectText(iterateText(trailingWhitespace()))
    ).resolves.toEqual(["Hello ", "world"]);
    await expect(
      collectText(iterateText(leadingWhitespace()))
    ).resolves.toEqual(["Hello", " world"]);
  });

  it("collapses repeated boundary events before the next text delta", async () => {
    async function* fullStream() {
      yield { type: "text-delta", id: "a", text: "Hello" };
      yield { type: "tool-call", toolName: "first" };
      yield { type: "tool-result", toolName: "first" };
      yield { type: "source", sourceId: "s1", url: "https://example.com" };
      yield { type: "text-delta", id: "b", text: "world" };
    }

    const events = await collectEvents(iterateTextEvents(fullStream()));
    expect(events).toEqual([
      { type: "text", text: "Hello" },
      { type: "boundary" },
      { type: "text", text: " " },
      { type: "text", text: "world" }
    ]);
  });

  it("inserts spaces across multiple separated tool transitions", async () => {
    async function* fullStream() {
      yield { type: "text-delta", id: "a", text: "One" };
      yield { type: "tool-call", toolName: "first" };
      yield { type: "text-delta", id: "b", text: "two" };
      yield { type: "tool-call", toolName: "second" };
      yield { type: "text-delta", id: "c", text: "three" };
    }

    const chunks = await collectText(iterateText(fullStream()));
    expect(chunks).toEqual(["One", " ", "two", " ", "three"]);
  });

  it("does not add spaces when a boundary has no text before or after it", async () => {
    async function* noTextBeforeTool() {
      yield { type: "tool-call", toolName: "first" };
      yield { type: "text-delta", id: "a", text: "Hello" };
    }

    async function* noTextAfterTool() {
      yield { type: "text-delta", id: "a", text: "Hello" };
      yield { type: "tool-call", toolName: "first" };
    }

    await expect(collectText(iterateText(noTextBeforeTool()))).resolves.toEqual(
      ["Hello"]
    );
    await expect(collectText(iterateText(noTextAfterTool()))).resolves.toEqual([
      "Hello"
    ]);
  });

  it("flushes text before preserving stream errors", async () => {
    const error = new Error("provider failed");
    async function* fullStream() {
      yield { type: "text-delta", id: "a", text: "Partial response." };
      yield { type: "error", error };
      yield { type: "text-delta", id: "b", text: "ignored" };
    }

    const events = await collectEvents(iterateTextEvents(fullStream()));
    expect(events).toEqual([
      { type: "text", text: "Partial response." },
      { type: "boundary" },
      { type: "error", error }
    ]);
    await expect(collectText(iterateText(fullStream()))).rejects.toThrow(
      "provider failed"
    );
  });
});
