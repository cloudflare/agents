import { describe, expect, it } from "vitest";
import { messengerChannel, resolveChannels } from "../channels";
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
    const configured = {
      voice: { kind: "voice", ingress: { transport: "voice" } }
    } as const;
    const { channels, messengers } = resolveChannels(configured, {});
    expect(channels.get("voice")?.kind).toBe("voice");
    expect(Object.keys(messengers)).toEqual([]);
  });

  it("feeds messenger-kind configureChannels entries into the runtime", () => {
    const configured = {
      tg: messengerChannel(telegram())
    };
    const { channels, messengers } = resolveChannels(configured, {});
    expect(channels.get("tg")?.kind).toBe("messenger");
    expect(Object.keys(messengers)).toEqual(["tg"]);
  });

  it("allows overriding the web channel's policy with a kind: web entry", () => {
    const configured = {
      web: {
        kind: "web",
        ingress: { transport: "websocket" },
        instructions: "be concise"
      }
    } as const;
    const { channels } = resolveChannels(configured, {});
    const web = channels.get("web");
    expect(web?.kind).toBe("web");
    expect(web?.instructions).toBe("be concise");
    // A policy-only override must retain the implicit web capabilities.
    expect(web?.capabilities).toEqual({
      canStream: true,
      canEditMessages: true
    });
  });

  it("throws when configureChannels() replaces web with a non-web kind", () => {
    const configured = {
      web: { kind: "voice", ingress: { transport: "voice" } }
    } as const;
    expect(() => resolveChannels(configured, {})).toThrow(
      /reserved for the built-in WebSocket chat surface/
    );
  });

  it("throws when getMessengers() declares a messenger named web", () => {
    expect(() => resolveChannels({}, { web: telegram() })).toThrow(
      /reserved for the built-in WebSocket chat surface/
    );
  });

  it("throws on a duplicate id across configureChannels() and getMessengers()", () => {
    const configured = {
      telegram: { kind: "voice", ingress: { transport: "voice" } }
    } as const;
    expect(() => resolveChannels(configured, { telegram: telegram() })).toThrow(
      /channel ids must be unique/
    );
  });
});
