import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  ChannelHost,
  fallback,
  type ChannelMessage,
  type DeliveryResult
} from "..";
import { createSendMessageTool, toChannelChunks } from "../ai-sdk";

function executable(tool: ReturnType<typeof createSendMessageTool>) {
  return tool.execute as unknown as (
    message: ChannelMessage
  ) => Promise<DeliveryResult>;
}

const surface = {
  channelKey: "test",
  version: 1,
  address: null,
  label: "Test destination"
} as const;

function host(deliver = vi.fn(async () => ({ status: "delivered" as const }))) {
  return {
    deliver,
    channelHost: new ChannelHost({ channels: { test: { deliver } } })
  };
}

describe("AI SDK message adapter", () => {
  it("adapts a Host-resolved surface to a caller-described tool", async () => {
    const deliver = vi.fn(
      async (): Promise<DeliveryResult> => ({
        status: "delivered",
        reference: "message-1"
      })
    );
    const { channelHost } = host(deliver);

    const messageTool = createSendMessageTool(channelHost, surface, {
      description: "Escalate to a human",
      needsApproval: true,
      metadata: { purpose: "escalation" },
      inputExamples: [{ input: { markdown: "Please **help**" } }]
    });

    expect(messageTool.description).toBe("Escalate to a human");
    expect(messageTool.needsApproval).toBe(true);
    expect(messageTool.metadata).toEqual({ purpose: "escalation" });

    await expect(
      executable(messageTool)({ title: "Urgent", markdown: "Please **help**" })
    ).resolves.toEqual({ status: "delivered", reference: "message-1" });
    expect(deliver).toHaveBeenCalledWith(
      surface,
      { title: "Urgent", markdown: "Please **help**" },
      undefined
    );
  });

  it("passes composite surfaces through the same Host API", async () => {
    const deliver = vi.fn(async () => ({ status: "delivered" as const }));
    const channelHost = {
      deliver
    } as Pick<ChannelHost, "deliver"> as ChannelHost;
    const composite = fallback([surface]);
    const messageTool = createSendMessageTool(channelHost, composite);

    await executable(messageTool)({ markdown: "Hello" });

    expect(deliver).toHaveBeenCalledWith(composite, { markdown: "Hello" });
  });

  it("validates tool input without requiring a schema library", async () => {
    const { channelHost } = host();
    const messageTool = createSendMessageTool(channelHost, surface);
    const schema = asSchema(messageTool.inputSchema);

    expect(await schema.validate?.({ markdown: "" })).toMatchObject({
      success: false
    });
    expect(
      await schema.validate?.({ markdown: "Ready", ignored: true })
    ).toEqual({
      success: true,
      value: { markdown: "Ready" }
    });
  });
});

describe("AI SDK stream adapter", () => {
  async function collect(parts: unknown[]) {
    const chunks: unknown[] = [];
    const stream = toChannelChunks(
      (async function* () {
        for (const part of parts) yield part as never;
      })()
    );
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  }

  it("keeps the parts a Channel can express and drops the rest", async () => {
    await expect(
      collect([
        { type: "start" },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", text: "Hello" },
        { type: "reasoning-delta", id: "2", text: "thinking" },
        { type: "tool-call", toolCallId: "t1", toolName: "search", input: {} },
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "search",
          input: {},
          output: "ok"
        },
        { type: "tool-error", toolCallId: "t2", toolName: "fetch", error: "x" },
        {
          type: "source",
          sourceType: "url",
          id: "s1",
          url: "https://example.com",
          title: "Example"
        },
        {
          type: "source",
          sourceType: "document",
          id: "s2",
          mediaType: "application/pdf",
          title: "Report"
        },
        { type: "finish", finishReason: "stop" }
      ])
    ).resolves.toEqual([
      { type: "text", text: "Hello" },
      { type: "reasoning", text: "thinking" },
      { type: "tool", name: "search", status: "started" },
      { type: "tool", name: "search", status: "completed" },
      { type: "tool", name: "fetch", status: "failed" },
      { type: "source", url: "https://example.com", title: "Example" }
    ]);
  });

  it("errors the stream when the generation fails, so Channels finalize", async () => {
    await expect(
      collect([
        { type: "text-delta", id: "1", text: "Half an " },
        { type: "error", error: new Error("model failed") }
      ])
    ).rejects.toThrow("model failed");
  });

  it("errors the stream when the generation is aborted", async () => {
    await expect(
      collect([{ type: "abort", reason: "stopped by the reader" }])
    ).rejects.toThrow("stopped by the reader");
  });
});
