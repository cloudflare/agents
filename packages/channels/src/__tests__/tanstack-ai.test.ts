import { describe, expect, it, vi } from "vitest";
import type { ChannelMessage, DeliveryResult } from "..";
import { createChannelTool } from "../tanstack-ai";

function executable(tool: ReturnType<typeof createChannelTool>) {
  return tool.execute as unknown as (
    message: ChannelMessage
  ) => Promise<DeliveryResult>;
}

describe("TanStack AI channel adapter", () => {
  it("creates a named server tool that delivers through the Channel", async () => {
    const deliver = vi.fn(
      async (): Promise<DeliveryResult> => ({
        status: "delivered",
        reference: "message-1"
      })
    );
    const channelTool = createChannelTool(
      { deliver },
      {
        name: "contactSupport",
        description: "Escalate to a person",
        needsApproval: true,
        metadata: { purpose: "escalation" }
      }
    );

    expect(channelTool.name).toBe("contactSupport");
    expect(channelTool.description).toBe("Escalate to a person");
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

  it("validates tool input without a schema-library dependency", async () => {
    const tool = createChannelTool(
      {
        async deliver() {
          return { status: "delivered" };
        }
      },
      { name: "notify" }
    );

    await expect(executable(tool)({ markdown: "" })).rejects.toThrow(
      "Expected an optional string title and a non-empty Markdown string"
    );
  });
});
