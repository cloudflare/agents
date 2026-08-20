import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  ChannelHost,
  fallback,
  type ChannelMessage,
  type DeliveryResult
} from "..";
import { createSendMessageTool } from "../ai-sdk";

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
