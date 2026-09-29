import { describe, expect, it } from "vitest";
import { isChannelMessageSurface } from "..";

describe("Channel message surfaces", () => {
  it("accepts a finite JSON-serializable versioned surface with a label", () => {
    expect(
      isChannelMessageSurface({
        channelKey: "telegram",
        version: 1,
        address: { chatId: "42", replyToMessageId: 7 },
        label: "Telegram · Ada"
      })
    ).toBe(true);
  });

  it.each([
    {
      channelKey: "telegram",
      version: 1,
      address: { chatId: "42" }
    },
    {
      channelKey: "telegram",
      version: 2,
      address: { chatId: "42" },
      label: "Telegram · Ada"
    },
    {
      channelKey: "telegram",
      version: 1,
      address: { chatId: undefined },
      label: "Telegram · Ada"
    },
    {
      channelKey: "telegram",
      version: 1,
      address: { score: Number.NaN },
      label: "Telegram · Ada"
    },
    {
      channelKey: "telegram",
      version: 1,
      address: { chatId: "42" },
      label: "  "
    }
  ])("rejects a malformed, stale, or unlabelled surface", (surface) => {
    expect(isChannelMessageSurface(surface)).toBe(false);
  });
});
