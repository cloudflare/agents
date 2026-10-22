import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECONNECT_POLICY,
  makeReconnectPolicy,
  nextReconnect,
  parseAuthExpiryJobPayload,
  parseConnectJobPayload
} from "../../mcp/client/reconnect-policy";

const NOW = 1_000_000_000_000;

describe("reconnect policy", () => {
  it("backs off through the delays and repeats the last one", () => {
    const policy = makeReconnectPolicy({ delaysMs: [10, 20, 40] });
    let previous = undefined;
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const decision = nextReconnect(policy, previous, "s", NOW);
      if (decision._tag !== "retry") throw new Error("expected a retry");
      delays.push(decision.time - NOW);
      previous = decision.payload;
    }
    expect(delays).toEqual([10, 20, 40, 40, 40]);
    expect(previous).toEqual({
      serverId: "s",
      attempt: 5,
      firstFailureAt: NOW
    });
  });

  it("keeps the first failure time across attempts and gives up after the window", () => {
    const policy = makeReconnectPolicy({ giveUpAfterMs: 1000 });
    const first = nextReconnect(policy, undefined, "s", NOW);
    if (first._tag !== "retry") throw new Error("expected a retry");

    const later = nextReconnect(policy, first.payload, "s", NOW + 999);
    expect(later).toMatchObject({
      _tag: "retry",
      payload: { attempt: 2, firstFailureAt: NOW }
    });
    expect(nextReconnect(policy, first.payload, "s", NOW + 1000)).toEqual({
      _tag: "give-up",
      attempts: 2
    });
  });

  it("defaults to a 30s first delay, a 30m cap and a 24h window", () => {
    const policy = makeReconnectPolicy(undefined);
    expect(policy).toEqual(DEFAULT_RECONNECT_POLICY);
    expect(policy.delaysMs[0]).toBe(30_000);
    expect(policy.delaysMs.at(-1)).toBe(30 * 60_000);
    expect(policy.giveUpAfterMs).toBe(24 * 60 * 60_000);
    expect(makeReconnectPolicy({ delaysMs: [] }).delaysMs).toEqual(
      DEFAULT_RECONNECT_POLICY.delaysMs
    );
  });

  it("parses only well-formed job payloads", () => {
    expect(
      parseConnectJobPayload({ serverId: "s", attempt: 2, firstFailureAt: 1 })
    ).toEqual({ serverId: "s", attempt: 2, firstFailureAt: 1 });
    expect(parseConnectJobPayload({ serverId: "s" })).toBeUndefined();
    expect(parseConnectJobPayload(null)).toBeUndefined();

    expect(
      parseAuthExpiryJobPayload({ serverId: "s", authUrl: "https://a" })
    ).toEqual({ serverId: "s", authUrl: "https://a" });
    expect(parseAuthExpiryJobPayload({ authUrl: "https://a" })).toBeUndefined();
  });
});
