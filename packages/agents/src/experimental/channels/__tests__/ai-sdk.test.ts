import { asSchema, type UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { ChannelGateway, type ChannelMessage, type DeliveryResult } from "..";
import { answerToolCall, createSendMessageTool } from "../../../harness/ai-sdk";

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

function host(
  deliver = vi.fn(
    async (): Promise<DeliveryResult> => ({ status: "delivered" })
  )
) {
  return {
    deliver,
    channelHost: new ChannelGateway({
      channels: { test: { deliver } },
      agent: () => {
        throw new Error("no agent");
      }
    })
  };
}

describe("AI SDK send-message tool", () => {
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

describe("AI SDK turns", () => {
  const asked = (state: string, extra: Record<string, unknown> = {}) =>
    ({
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-getLocation",
          toolCallId: "t1",
          input: {},
          state,
          approval: { id: "a1" },
          ...extra
        }
      ]
    }) as unknown as UIMessage;

  it("records a rejected approval as denied", () => {
    const answered = answerToolCall([asked("approval-requested")], {
      type: "approval-response",
      eventId: "e1",
      turnId: "turn",
      approvalId: "a1",
      approved: false
    });
    expect(answered?.parts[0]).toMatchObject({
      state: "output-denied",
      approval: { id: "a1", approved: false }
    });
  });

  it("records a client tool's result after its approval", () => {
    const answered = answerToolCall(
      [asked("approval-responded", { approval: { id: "a1", approved: true } })],
      {
        type: "tool-result",
        eventId: "e1",
        turnId: "turn",
        toolCallId: "t1",
        result: { ok: true, output: "here" }
      }
    );
    expect(answered?.parts[0]).toMatchObject({
      state: "output-available",
      output: "here"
    });
  });
});
