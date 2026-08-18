import { describe, expect, it } from "vitest";
import { inboundEmail, type ChannelEmailInput } from "..";

function emailInput(raw: string): ChannelEmailInput {
  return {
    from: "operator@example.com",
    to: "agent@example.com",
    headers: new Headers(),
    getRaw: async () => new TextEncoder().encode(raw)
  };
}

function rawEmail(options: {
  messageId?: string;
  text: string;
  inReplyTo?: string;
}): string {
  return [
    "From: Operator <operator@example.com>",
    "To: agent@example.com",
    "Subject: Approval",
    ...(options.messageId ? [`Message-ID: <${options.messageId}>`] : []),
    ...(options.inReplyTo ? [`In-Reply-To: <${options.inReplyTo}>`] : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.text
  ].join("\r\n");
}

describe("inbound Email", () => {
  it("normalizes a Workers Email event", async () => {
    const ingress = inboundEmail({ to: "agent@example.com" });

    await expect(
      ingress.receive(
        emailInput(rawEmail({ messageId: "message-2", text: "Hello agent" }))
      )
    ).resolves.toEqual({
      events: [
        {
          type: "message",
          text: "Hello agent",
          reference: "message-2",
          sender: {
            id: "operator@example.com",
            username: "Operator"
          }
        }
      ]
    });
  });

  it("derives a stable replay reference when Message-ID is missing", async () => {
    const ingress = inboundEmail();
    const content = rawEmail({ text: "No message id" });

    const first = await ingress.receive(emailInput(content));
    const second = await ingress.receive(emailInput(content));

    expect(first.events[0]?.reference).toMatch(/^sha256:/);
    expect(second.events[0]?.reference).toBe(first.events[0]?.reference);
  });

  it("keeps replies as normalized messages for application interpretation", async () => {
    const ingress = inboundEmail({
      to: "agent@example.com",
      from: "operator@example.com"
    });

    await expect(
      ingress.receive(
        emailInput(
          rawEmail({
            messageId: "message-2",
            inReplyTo: "message-1",
            text: "YES"
          })
        )
      )
    ).resolves.toEqual({
      events: [
        {
          type: "message",
          text: "YES",
          reference: "message-2",
          replyTo: { reference: "message-1" },
          sender: {
            id: "operator@example.com",
            username: "Operator"
          }
        }
      ]
    });
  });
});
