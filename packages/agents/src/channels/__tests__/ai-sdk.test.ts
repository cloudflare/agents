import { asSchema, type TextStreamPart, type ToolSet } from "ai";
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

async function collect(parts: TextStreamPart<ToolSet>[]) {
  const chunks = [];
  const stream = toChannelChunks(
    (async function* () {
      yield* parts;
    })()
  );
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
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
    const channelHost = { deliver } as Pick<
      ChannelHost,
      "deliver"
    > as ChannelHost;
    const composite = fallback([surface]);
    await executable(createSendMessageTool(channelHost, composite))({
      markdown: "Hello"
    });
    expect(deliver).toHaveBeenCalledWith(composite, { markdown: "Hello" });
  });

  it("validates tool input without requiring a schema library", async () => {
    const messageTool = createSendMessageTool(host().channelHost, surface);
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

describe("AI SDK full stream adapter", () => {
  it("preserves lifecycle, boundaries, tool values, sources, and files", async () => {
    const metadata = { provider: { trace: "abc" } };
    await expect(
      collect([
        { type: "start" },
        { type: "text-start", id: "text-1", providerMetadata: metadata },
        {
          type: "text-delta",
          id: "text-1",
          text: "Hello",
          providerMetadata: metadata
        },
        { type: "text-end", id: "text-1", providerMetadata: metadata },
        { type: "reasoning-start", id: "reason-1" },
        { type: "reasoning-delta", id: "reason-1", text: "thinking" },
        { type: "reasoning-end", id: "reason-1" },
        {
          type: "tool-input-start",
          id: "t1",
          toolName: "search",
          title: "Search"
        },
        { type: "tool-input-delta", id: "t1", delta: '{"q":' },
        { type: "tool-input-end", id: "t1" },
        {
          type: "tool-call",
          toolCallId: "t1",
          toolName: "search",
          input: { q: "docs" }
        },
        {
          type: "tool-result",
          toolCallId: "t1",
          toolName: "search",
          input: { q: "docs" },
          output: { found: true },
          preliminary: true
        },
        {
          type: "tool-error",
          toolCallId: "t2",
          toolName: "fetch",
          input: {},
          error: new Error("failed")
        },
        { type: "tool-output-denied", toolCallId: "t3", toolName: "delete" },
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
          title: "Report",
          filename: "report.pdf"
        },
        {
          type: "file",
          file: {
            base64: "aGk=",
            uint8Array: new Uint8Array([104, 105]),
            mediaType: "text/plain"
          }
        },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: undefined,
          totalUsage: {} as never
        }
      ])
    ).resolves.toEqual([
      { type: "message-start" },
      { type: "text-start", id: "text-1", providerMetadata: metadata },
      { type: "text", id: "text-1", text: "Hello", providerMetadata: metadata },
      { type: "text-end", id: "text-1", providerMetadata: metadata },
      { type: "reasoning-start", id: "reason-1" },
      { type: "reasoning", id: "reason-1", text: "thinking" },
      { type: "reasoning-end", id: "reason-1" },
      {
        type: "tool-input-start",
        toolCallId: "t1",
        toolName: "search",
        title: "Search"
      },
      { type: "tool-input-delta", toolCallId: "t1", delta: '{"q":' },
      {
        type: "tool-input-available",
        toolCallId: "t1",
        toolName: "search",
        input: { q: "docs" }
      },
      {
        type: "tool-output-available",
        toolCallId: "t1",
        output: { found: true },
        preliminary: true
      },
      { type: "tool-output-error", toolCallId: "t2", errorText: "failed" },
      { type: "tool-output-denied", toolCallId: "t3" },
      {
        type: "source",
        id: "s1",
        url: "https://example.com",
        title: "Example"
      },
      {
        type: "source-document",
        id: "s2",
        mediaType: "application/pdf",
        title: "Report",
        filename: "report.pdf"
      },
      {
        type: "file",
        url: "data:text/plain;base64,aGk=",
        mediaType: "text/plain"
      },
      { type: "message-finish", finishReason: "stop" }
    ]);
  });

  it.each([
    {
      part: {
        type: "error",
        error: new Error("model failed")
      } as TextStreamPart<ToolSet>,
      message: "model failed"
    },
    {
      part: {
        type: "abort",
        reason: "reader stopped"
      } as TextStreamPart<ToolSet>,
      message: "reader stopped"
    }
  ])(
    "errors and closes the source after $part.type",
    async ({ part, message }) => {
      let finalized = false;
      const source = (async function* () {
        try {
          yield part;
          yield {
            type: "text-delta",
            id: "1",
            text: "never"
          } as TextStreamPart<ToolSet>;
        } finally {
          finalized = true;
        }
      })();
      const reader = toChannelChunks(source).getReader();
      await expect(reader.read()).rejects.toThrow(message);
      expect(finalized).toBe(true);
    }
  );
});
