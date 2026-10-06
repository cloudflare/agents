import { describe, expect, it } from "vitest";
import { identityKey, type ChannelIdentity } from "..";

describe("identityKey", () => {
  it("treats an omitted scope as the default scope", () => {
    const implicit = {
      channelKey: "support-form",
      subject: "alice@example.com"
    } satisfies ChannelIdentity;
    const explicit = {
      ...implicit,
      scope: "default"
    } satisfies ChannelIdentity;

    expect(identityKey(implicit)).toBe(identityKey(explicit));
  });

  it("keeps the same subject apart across Channels and scopes", () => {
    const slack = { channelKey: "slack", scope: "T1", subject: "U1" };
    expect(
      new Set([
        identityKey(slack),
        identityKey({ ...slack, scope: "T2" }),
        identityKey({ ...slack, channelKey: "telegram" })
      ]).size
    ).toBe(3);
  });
});
