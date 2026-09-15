import type { UIMessageChunk } from "ai";
import { describe, expect, it } from "vitest";
import type { ChannelChunk } from "../channel";
import { fromUIMessageStream, toUIMessageStream } from "../ai-sdk";

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

function asyncChunks<T>(values: T[]): AsyncIterable<T> {
  return (async function* () {
    yield* values;
  })();
}

describe("AI SDK UI stream converter", () => {
  it("roundtrips every rich non-error UI chunk shape", async () => {
    const providerMetadata = { provider: { trace: "abc" } };
    const chunks: UIMessageChunk[] = [
      { type: "start", messageId: "m1", messageMetadata: { subject: "hello" } },
      { type: "message-metadata", messageMetadata: { phase: 1 } },
      { type: "start-step" },
      { type: "text-start", id: "text-1", providerMetadata },
      { type: "text-delta", id: "text-1", delta: "hello", providerMetadata },
      { type: "text-end", id: "text-1", providerMetadata },
      { type: "reasoning-start", id: "reason-1", providerMetadata },
      {
        type: "reasoning-delta",
        id: "reason-1",
        delta: "think",
        providerMetadata
      },
      { type: "reasoning-end", id: "reason-1", providerMetadata },
      {
        type: "tool-input-start",
        toolCallId: "tool-1",
        toolName: "search",
        title: "Search",
        providerExecuted: true,
        providerMetadata,
        toolMetadata: { category: "web" },
        dynamic: true
      },
      {
        type: "tool-input-delta",
        toolCallId: "tool-1",
        inputTextDelta: '{"q":1}'
      },
      {
        type: "tool-input-available",
        toolCallId: "tool-1",
        toolName: "search",
        input: { q: 1 },
        title: "Search",
        providerExecuted: true,
        providerMetadata,
        toolMetadata: { category: "web" },
        dynamic: true
      },
      {
        type: "tool-input-error",
        toolCallId: "tool-2",
        toolName: "fetch",
        input: {},
        errorText: "bad"
      },
      {
        type: "tool-approval-request",
        approvalId: "approval-1",
        toolCallId: "tool-1",
        signature: "sig"
      },
      {
        type: "tool-approval-response",
        approvalId: "approval-1",
        approved: true,
        providerExecuted: true,
        providerMetadata
      },
      {
        type: "tool-output-available",
        toolCallId: "tool-1",
        output: { ok: true },
        preliminary: true,
        providerMetadata
      },
      {
        type: "tool-output-error",
        toolCallId: "tool-2",
        errorText: "failed",
        providerMetadata
      },
      { type: "tool-output-denied", toolCallId: "tool-3" },
      {
        type: "source-url",
        sourceId: "source-1",
        url: "https://example.com",
        title: "Example",
        providerMetadata
      },
      {
        type: "source-document",
        sourceId: "source-2",
        mediaType: "application/pdf",
        title: "Report",
        filename: "report.pdf",
        providerMetadata
      },
      {
        type: "file",
        url: "https://example.com/file",
        mediaType: "text/plain",
        providerMetadata
      },
      {
        type: "reasoning-file",
        url: "https://example.com/reason",
        mediaType: "text/plain",
        providerMetadata
      },
      {
        type: "data-progress",
        id: "data-1",
        data: { percent: 50 },
        transient: true
      },
      { type: "custom", kind: "cloudflare.trace", providerMetadata },
      { type: "finish-step" },
      { type: "finish", finishReason: "stop", messageMetadata: { done: true } }
    ];

    const neutral = fromUIMessageStream(asyncChunks(chunks));
    await expect(collect(toUIMessageStream(neutral))).resolves.toEqual(chunks);
  });

  it("frames simple text and reasoning and generates a source id", async () => {
    const ui = await collect(
      toUIMessageStream(
        new ReadableStream<ChannelChunk>({
          start(controller) {
            controller.enqueue({ type: "text", text: "one" });
            controller.enqueue({ type: "text", text: " two" });
            controller.enqueue({ type: "reasoning", text: "because" });
            controller.enqueue({ type: "source", url: "https://example.com" });
            controller.close();
          }
        })
      )
    );

    expect(ui.map((chunk) => chunk.type)).toEqual([
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "source-url"
    ]);
    expect(ui[0]).toMatchObject({ type: "text-start", id: expect.any(String) });
    expect(ui[1]).toMatchObject({
      type: "text-delta",
      id: ui[0].id,
      delta: "one"
    });
    expect(ui[7]).toMatchObject({
      type: "source-url",
      sourceId: expect.any(String)
    });
  });

  it("rejects malformed explicit boundaries and deltas", async () => {
    const cases: ChannelChunk[][] = [
      [{ type: "text", id: "missing", text: "bad" }],
      [{ type: "text-end", id: "missing" }],
      [
        { type: "text-start", id: "duplicate" },
        { type: "text-start", id: "duplicate" }
      ],
      [
        { type: "text-start", id: "closed" },
        { type: "text-end", id: "closed" },
        { type: "text", id: "closed", text: "late" }
      ]
    ];

    for (const chunks of cases) {
      const stream = new ReadableStream<ChannelChunk>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        }
      });
      await expect(collect(toUIMessageStream(stream))).rejects.toThrow();
    }
  });

  it.each<UIMessageChunk>([
    { type: "error", errorText: "UI failed" },
    { type: "abort", reason: "UI stopped" }
  ])("errors instead of encoding $type as success", async (chunk) => {
    await expect(
      collect(fromUIMessageStream(asyncChunks([chunk])))
    ).rejects.toThrow(chunk.type === "error" ? "UI failed" : "UI stopped");
  });

  it("cancels the source iterator without eager consumption", async () => {
    let reads = 0;
    let finalized = false;
    const source = (async function* () {
      try {
        while (true) {
          reads++;
          yield {
            type: "text-delta",
            id: "text-1",
            delta: "x"
          } as UIMessageChunk;
        }
      } finally {
        finalized = true;
      }
    })();
    const reader = fromUIMessageStream(source).getReader();
    await reader.read();
    expect(reads).toBe(1);
    await reader.cancel();
    expect(finalized).toBe(true);
  });
});
