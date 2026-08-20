import { describe, expect, expectTypeOf, it } from "vitest";
import { inboundEmail, type ChannelEmailInput, type InboundEmailRaw } from "..";

function emailInput(raw: string): ChannelEmailInput {
  return {
    from: "operator@example.com",
    to: "agent@example.com",
    headers: new Headers(),
    getRaw: async () => new TextEncoder().encode(raw)
  };
}

function claimed<Result>(result: Result | null): Result {
  if (!result) throw new Error("Expected email ingress to claim the input");
  return result;
}

function rawEmail(options: {
  messageId?: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  replyTo?: string;
  autoSubmitted?: string;
}): string {
  return [
    "From: Operator <operator@example.com>",
    "To: agent@example.com",
    "Subject: Approval",
    ...(options.messageId ? [`Message-ID: <${options.messageId}>`] : []),
    ...(options.inReplyTo ? [`In-Reply-To: <${options.inReplyTo}>`] : []),
    ...(options.references ? [`References: ${options.references}`] : []),
    ...(options.replyTo ? [`Reply-To: ${options.replyTo}`] : []),
    ...(options.autoSubmitted
      ? [`Auto-Submitted: ${options.autoSubmitted}`]
      : []),
    "Content-Type: text/plain; charset=utf-8",
    "",
    options.text
  ].join("\r\n");
}

describe("inbound Email", () => {
  it("declines non-matching recipients and senders before reading raw email", async () => {
    const getRaw = async () => {
      throw new Error("raw email should not be read");
    };
    const ingress = inboundEmail({
      to: "agent@example.com",
      from: "operator@example.com"
    });

    await expect(
      ingress.receive({
        from: "other@example.com",
        to: "agent@example.com",
        headers: new Headers(),
        getRaw
      })
    ).resolves.toBeNull();
    await expect(
      ingress.receive({
        from: "operator@example.com",
        to: "other@example.com",
        headers: new Headers(),
        getRaw
      })
    ).resolves.toBeNull();
  });

  it("normalizes stable identity and preserves a typed parsed email", async () => {
    const ingress = inboundEmail({ to: "agent@example.com" });
    const result = claimed(
      await ingress.receive(
        emailInput(rawEmail({ messageId: "message-2", text: "Hello agent" }))
      )
    );
    const envelope = result.events[0];

    expectTypeOf(envelope?.raw).toEqualTypeOf<InboundEmailRaw | undefined>();
    expect(envelope?.raw).toMatchObject({
      messageId: "<message-2>",
      subject: "Approval"
    });
    expect(envelope?.raw.text?.trim()).toBe("Hello agent");
    expect(envelope?.event).toEqual({
      type: "message",
      eventId: "message-2",
      thread: {
        id: "message-2",
        isDirectMessage: "unknown"
      },
      replySurface: {
        version: 1,
        address: {
          from: "agent@example.com",
          to: "operator@example.com",
          subject: "Approval",
          inReplyTo: "message-2",
          references: ["message-2"]
        },
        label: "Email · operator@example.com"
      },
      actor: {
        id: "operator@example.com",
        identity: {
          subject: "operator@example.com"
        },
        fullName: "Operator"
      },
      message: {
        id: "message-2",
        title: "Approval",
        text: "Hello agent",
        attachments: [],
        metadata: { autoReply: false }
      }
    });
  });

  it("uses Reply-To for delivery without changing actor identity", async () => {
    const ingress = inboundEmail({
      to: "agent@example.com",
      replyFrom: "verified@example.com"
    });
    const result = claimed(
      await ingress.receive(
        emailInput(
          rawEmail({
            messageId: "message-reply-to",
            text: "Hello",
            replyTo: "Replies <replies@example.com>"
          })
        )
      )
    );

    expect(result.events[0]?.event.actor?.identity).toEqual({
      subject: "operator@example.com"
    });
    expect(result.events[0]?.event.replySurface).toMatchObject({
      address: {
        from: "verified@example.com",
        to: [{ email: "replies@example.com", name: "Replies" }]
      }
    });
  });

  it("matches recipient filters without regard to address case", async () => {
    const ingress = inboundEmail({ to: "agent@example.com" });
    const result = claimed(
      await ingress.receive({
        ...emailInput(rawEmail({ messageId: "message-4", text: "Hello" })),
        to: "Agent@Example.com"
      })
    );

    expect(result.events).toHaveLength(1);
  });

  it("derives a stable replay reference when Message-ID is missing", async () => {
    const ingress = inboundEmail();
    const content = rawEmail({ text: "No message id" });

    const first = claimed(await ingress.receive(emailInput(content)));
    const second = claimed(await ingress.receive(emailInput(content)));

    const firstEvent = first.events[0]?.event;
    const secondEvent = second.events[0]?.event;
    expect(firstEvent?.eventId).toMatch(/^sha256:/);
    expect(secondEvent?.eventId).toBe(firstEvent?.eventId);
    if (firstEvent?.type === "message") {
      expect(firstEvent.message.id).toBe(firstEvent.eventId);
      expect(firstEvent.thread.id).toBe(firstEvent.eventId);
    }
  });

  it("normalizes attachment facts while keeping attachment content in raw", async () => {
    const content = [
      "From: Operator <operator@example.com>",
      "To: agent@example.com",
      "Subject: Logs",
      "Message-ID: <message-attachment>",
      'Content-Type: multipart/mixed; boundary="boundary"',
      "",
      "--boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See attachment",
      "--boundary",
      "Content-Type: text/plain; name=log.txt",
      "Content-Disposition: attachment; filename=log.txt",
      "Content-ID: <attachment-1>",
      "Content-Transfer-Encoding: base64",
      "",
      "aGVsbG8=",
      "--boundary--",
      ""
    ].join("\r\n");
    const result = claimed(await inboundEmail().receive(emailInput(content)));
    const envelope = result.events[0];

    expect(envelope?.raw.attachments[0]?.content).toBeInstanceOf(ArrayBuffer);
    expect(envelope?.event).toMatchObject({
      type: "message",
      message: {
        attachments: [
          {
            id: "attachment-1",
            mediaType: "text/plain",
            name: "log.txt",
            size: 5
          }
        ]
      }
    });
  });

  it("uses the first References id as the stable thread root", async () => {
    const ingress = inboundEmail({
      to: "agent@example.com",
      from: "operator@example.com"
    });
    const result = claimed(
      await ingress.receive(
        emailInput(
          rawEmail({
            messageId: "message-3",
            references: "<message-1> <message-2>",
            inReplyTo: "message-2",
            autoSubmitted: "auto-replied",
            text: "YES"
          })
        )
      )
    );
    const event = result.events[0]?.event;

    expect(event).toMatchObject({
      type: "message",
      eventId: "message-3",
      thread: { id: "message-1" },
      message: {
        id: "message-3",
        reply: { id: "message-2" },
        metadata: { autoReply: true }
      }
    });
  });
});
