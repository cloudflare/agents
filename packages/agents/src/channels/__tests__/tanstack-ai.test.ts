import { describe, expect, it, vi } from "vitest";
import { ChannelRouter, type ChannelMessage, type DeliveryResult } from "..";
import { createSendMessageTool } from "../tanstack-ai";

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

function router(
  deliver = vi.fn(async () => ({ status: "delivered" as const }))
) {
  return new ChannelRouter({ channels: { test: { deliver } } });
}

describe("TanStack AI message adapter", () => {
  it("creates a named server tool that delivers through the Router", async () => {
    const deliver = vi.fn(
      async (): Promise<DeliveryResult> => ({
        status: "delivered",
        reference: "message-1"
      })
    );
    const messageTool = createSendMessageTool(router(deliver), surface, {
      name: "contactSupport",
      description: "Escalate to a person",
      needsApproval: true,
      metadata: { purpose: "escalation" }
    });

    expect(messageTool.name).toBe("contactSupport");
    expect(messageTool.description).toBe("Escalate to a person");
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

  it("validates tool input without a schema-library dependency", async () => {
    const messageTool = createSendMessageTool(router(), surface, {
      name: "notify"
    });

    await expect(executable(messageTool)({ markdown: "" })).rejects.toThrow(
      "Expected an optional string title and a non-empty Markdown string"
    );
  });
});
