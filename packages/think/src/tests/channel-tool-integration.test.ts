import type { Channel, DeliveryResult } from "@cloudflare/channels";
import { createChannelTool } from "@cloudflare/channels/ai-sdk";
import { describe, expect, it, vi } from "vitest";
import { Think } from "../think";

const deliver = vi.fn(
  async (): Promise<DeliveryResult> => ({
    status: "delivered",
    reference: "delivery-1"
  })
);
const escalationChannel: Channel = { deliver };

class ChannelEnabledThink extends Think {
  override getTools() {
    return {
      escalate: createChannelTool(escalationChannel, {
        description: "Escalate the current situation to a human"
      })
    };
  }
}

describe("experimental channel tools", () => {
  it("can be returned directly from a Think agent's getTools()", async () => {
    const tools = ChannelEnabledThink.prototype.getTools();
    const execute = tools.escalate.execute as unknown as (input: {
      markdown: string;
      title?: string;
    }) => Promise<DeliveryResult>;

    await expect(execute({ markdown: "Please investigate" })).resolves.toEqual({
      status: "delivered",
      reference: "delivery-1"
    });
    expect(deliver).toHaveBeenCalledWith({ markdown: "Please investigate" });
  });
});
