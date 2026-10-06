import { describe, expect, it } from "vitest";
import {
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
  approvalId: "interaction-1",
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

  it("gives each participant a namespaced agent object of their own", () => {
    expect(routes.perParticipant(message, null, { id: "ada" })).toBe(
      "participant:ada"
    );
  });
});
