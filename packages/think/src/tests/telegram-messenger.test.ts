import { createTelegramAdapter } from "@chat-adapter/telegram";
import { describe, expect, it, vi } from "vitest";
import { telegramMessenger } from "../messengers/telegram";

vi.mock("@chat-adapter/telegram", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@chat-adapter/telegram")>();
  return {
    ...actual,
    createTelegramAdapter: vi.fn(actual.createTelegramAdapter)
  };
});

function lastAdapterConfig(): Record<string, unknown> {
  return vi.mocked(createTelegramAdapter).mock.lastCall?.[0] as Record<
    string,
    unknown
  >;
}

describe("telegram messenger adapter config (#2397)", () => {
  it("forwards nativeStreaming to the adapter", () => {
    telegramMessenger({
      nativeStreaming: true,
      secretToken: "secret",
      token: "token",
      userName: "fake_bot"
    });
    expect(lastAdapterConfig()).toMatchObject({ nativeStreaming: true });

    telegramMessenger({
      secretToken: "secret",
      token: "token",
      userName: "fake_bot"
    });
    expect(lastAdapterConfig().nativeStreaming).toBeUndefined();
  });

  it("allows unverified adapter webhooks only when Think verifies them", () => {
    telegramMessenger({
      secretToken: "secret",
      token: "token",
      userName: "fake_bot"
    });
    expect(lastAdapterConfig()).toMatchObject({
      allowUnverifiedWebhooks: false,
      secretToken: "secret"
    });

    telegramMessenger({
      token: "token",
      userName: "fake_bot",
      verifyWebhook: false
    });
    expect(lastAdapterConfig()).toMatchObject({
      allowUnverifiedWebhooks: true
    });
  });
});
