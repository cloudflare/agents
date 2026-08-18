import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { Channel, ChannelMessage, DeliveryResult } from "..";
import { createChannelTool } from "../ai-sdk";

function executable(tool: ReturnType<typeof createChannelTool>) {
  return tool.execute as unknown as (
    message: ChannelMessage
  ) => Promise<DeliveryResult>;
}

describe("AI SDK channel adapter", () => {
  it("adapts a configured channel to a caller-described AI SDK tool", async () => {
    const deliver = vi.fn(
      async (): Promise<DeliveryResult> => ({
        status: "delivered",
        reference: "message-1"
      })
    );
    const channel: Channel = { deliver };

    const channelTool = createChannelTool(channel, {
      description: "Escalate to a human",
      needsApproval: true,
      metadata: { purpose: "escalation" },
      inputExamples: [{ input: { markdown: "Please **help**" } }]
    });

    expect(channelTool.description).toBe("Escalate to a human");
    expect(channelTool.needsApproval).toBe(true);
    expect(channelTool.metadata).toEqual({ purpose: "escalation" });

    await expect(
      executable(channelTool)({ title: "Urgent", markdown: "Please **help**" })
    ).resolves.toEqual({ status: "delivered", reference: "message-1" });
    expect(deliver).toHaveBeenCalledWith({
      title: "Urgent",
      markdown: "Please **help**"
    });
  });

  it("validates tool input without requiring a schema library", async () => {
    const channelTool = createChannelTool({
      async deliver() {
        return { status: "delivered" };
      }
    });
    const schema = asSchema(channelTool.inputSchema);

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
