import { describe, expect, it } from "vitest";
import { defineChannels, messengerChannel, resolveChannels } from "../channels";
import { telegramMessenger } from "../messengers/telegram";

function telegram() {
  return telegramMessenger({
    token: "test-token",
    userName: "bot",
    verifyWebhook: false
  });
}

describe("resolveChannels", () => {
  it("always includes an implicit web channel", () => {
    const { channels } = resolveChannels({}, {});
    const web = channels.get("web");
    expect(web?.kind).toBe("web");
    expect(web?.ingress.transport).toBe("websocket");
  });

  it("absorbs getMessengers() entries as messenger channels and feeds the runtime", () => {
    const { channels, messengers } = resolveChannels(
      {},
      { telegram: telegram() }
    );
    expect(channels.get("telegram")?.kind).toBe("messenger");
    expect(channels.get("telegram")?.ingress.transport).toBe("webhook");
    expect(Object.keys(messengers)).toEqual(["telegram"]);
  });

  it("registers configureChannels web/voice entries without feeding the runtime", () => {
    const configured = defineChannels({
      voice: { kind: "voice", ingress: { transport: "voice" } }
    });
    const { channels, messengers } = resolveChannels(configured, {});
    expect(channels.get("voice")?.kind).toBe("voice");
    expect(Object.keys(messengers)).toEqual([]);
  });

  it("feeds messenger-kind configureChannels entries into the runtime", () => {
    const configured = defineChannels({
      tg: messengerChannel(telegram())
    });
    const { channels, messengers } = resolveChannels(configured, {});
    expect(channels.get("tg")?.kind).toBe("messenger");
    expect(Object.keys(messengers)).toEqual(["tg"]);
  });

  it("throws on a duplicate id across configureChannels() and getMessengers()", () => {
    const configured = defineChannels({
      telegram: { kind: "voice", ingress: { transport: "voice" } }
    });
    expect(() => resolveChannels(configured, { telegram: telegram() })).toThrow(
      /channel ids must be unique/
    );
  });
});
