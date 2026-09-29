import { describe, expect, it, vi } from "vitest";
import {
  identityKey,
  routes,
  type ChannelApprovalResponse,
  type ChannelInboundMessage
} from "..";

const message: ChannelInboundMessage = {
  type: "message",
  eventId: "event-1",
  thread: {
    id: "thread-1",
    isDirectMessage: true
  },
  message: { id: "message-1", text: "Hello" }
};

const approval: ChannelApprovalResponse = {
  type: "approval-response",
  eventId: "event-2",
  thread: {
    id: "thread-1",
    isDirectMessage: true
  },
  interactionId: "interaction-1",
  decision: "approve",
  reference: "approval-1"
};

describe("routes", () => {
  it.each([
    [message, "event:event-1"],
    [approval, "event:event-2"]
  ])("routes each normalized event independently", (event, expected) => {
    expect(routes.perEvent(event)).toBe(expected);
  });

  it.each([message, approval])(
    "keeps normalized events in their provider thread together",
    (event) => {
      expect(routes.perThread(event)).toBe("thread:thread-1");
    }
  );

  it("routes an event to its sender's channel identity", async () => {
    const route = routes.byIdentity(routes.perEvent);
    const identified: ChannelInboundMessage = {
      ...message,
      actor: {
        id: "U456",
        identity: { channelKey: "slack", scope: "T123", subject: "U456" }
      }
    };

    expect(
      await route(identified, null, { findUser: vi.fn(async () => null) })
    ).toBe(
      `identity:${identityKey({ channelKey: "slack", scope: "T123", subject: "U456" })}`
    );
  });

  it("falls back when an event carries no identity", async () => {
    const route = routes.byIdentity(routes.perEvent);

    expect(
      await route(message, null, { findUser: vi.fn(async () => null) })
    ).toBe("event:event-1");
  });

  it("ignores an unidentified event when given no fallback", async () => {
    const route = routes.byIdentity();

    expect(
      await route(message, null, { findUser: vi.fn(async () => null) })
    ).toBeNull();
  });

  it("prefers an explicitly linked user without evaluating its fallback", async () => {
    const fallback = vi.fn(() => "fallback-route");
    const findUser = vi.fn(async () => ({
      id: "ada",
      channelIdentities: []
    }));
    const route = routes.byUser(fallback);

    await expect(
      route(message, { provider: "raw" }, { findUser })
    ).resolves.toBe("user:ada");
    expect(findUser).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("delegates the exact arguments to any fallback when no user is linked", async () => {
    const raw = { provider: "raw" };
    const context = { findUser: vi.fn(async () => null) };
    const fallback = vi.fn((_event: ChannelInboundMessage, value: typeof raw) =>
      value.provider === "raw" ? "fallback-route" : null
    );
    const route = routes.byUser(fallback);

    await expect(route(message, raw, context)).resolves.toBe("fallback-route");
    expect(fallback).toHaveBeenCalledWith(message, raw, context);
  });
});
