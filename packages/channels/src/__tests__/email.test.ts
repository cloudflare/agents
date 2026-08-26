import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { email, type EmailSendBinding, type InboundEmailRaw } from "..";

const EMAIL_SURFACE = {
  channelKey: "email",
  version: 1,
  address: { from: "agent@example.com", to: "support@example.com" },
  label: "Email · support@example.com"
} as const;

function channelThatRejects(error: unknown) {
  const send = vi.fn(
    async (_message: unknown): Promise<{ messageId: string }> => {
      throw error;
    }
  );

  return email({
    binding: { send: send as EmailSendBinding["send"] },
    from: "agent@example.com",
    defaultTitle: "Agent escalation"
  });
}

function deliverRejected(error: unknown) {
  const channel = channelThatRejects(error);
  return channel.deliver(EMAIL_SURFACE, { markdown: "Help" });
}

describe("experimental email channel", () => {
  it("sends canonical Markdown as the plain-text email body", async () => {
    const send = vi.fn(async (_message: unknown) => ({
      messageId: "email-1"
    }));
    const channel = email({
      binding: { send: send as EmailSendBinding["send"] },
      from: "agent@example.com"
    });

    await expect(
      channel.deliver(EMAIL_SURFACE, { markdown: "**Help**" })
    ).resolves.toEqual({
      status: "delivered",
      reference: "email-1"
    });

    expect(send).toHaveBeenCalledWith({
      from: "agent@example.com",
      to: "support@example.com",
      subject: "Agent message",
      text: "**Help**",
      replyTo: undefined,
      cc: undefined,
      bcc: undefined,
      headers: {}
    });
  });

  it("derives contact surfaces and preserves reply threading on delivery", async () => {
    const send = vi.fn(async (_message: unknown) => ({ messageId: "email-2" }));
    const channel = email({
      binding: { send: send as EmailSendBinding["send"] },
      from: "agent@example.com"
    });
    expect(
      channel.contactSurface?.({
        channelKey: "email",
        subject: "ada@example.com"
      })
    ).toEqual({
      version: 1,
      address: { from: "agent@example.com", to: "ada@example.com" },
      label: "Email · ada@example.com"
    });

    const replySurface = {
      channelKey: "email",
      version: 1,
      address: {
        from: "agent@example.com",
        to: "ada@example.com",
        subject: "Need help",
        inReplyTo: "message-1",
        references: ["root-1", "message-1"]
      },
      label: "Email · ada@example.com"
    } as const;
    await channel.deliver(JSON.parse(JSON.stringify(replySurface)), {
      markdown: "Following up"
    });

    expect(send).toHaveBeenCalledWith({
      from: "agent@example.com",
      to: "ada@example.com",
      subject: "Re: Need help",
      text: "Following up",
      headers: {
        "In-Reply-To": "<message-1>",
        References: "<root-1> <message-1>"
      }
    });
  });

  it("bounds persisted References headers while preserving root and recent ancestry", async () => {
    const send = vi.fn(async (_message: unknown) => ({ messageId: "email-3" }));
    const channel = email({
      binding: { send: send as EmailSendBinding["send"] },
      from: "agent@example.com"
    });
    const references = [
      "root@example.com",
      ...Array.from(
        { length: 300 },
        (_, index) => `message-${index}-${"x".repeat(20)}@example.com`
      )
    ];

    await channel.deliver(
      {
        channelKey: "email",
        version: 1,
        address: {
          from: "agent@example.com",
          to: "ada@example.com",
          references
        },
        label: "Email · ada@example.com"
      },
      { markdown: "Following up" }
    );

    const header = send.mock.calls[0]?.[0].headers?.References ?? "";
    expect(new TextEncoder().encode(header).byteLength).toBeLessThanOrEqual(
      2048
    );
    expect(header).toContain("<root@example.com>");
    expect(header).toContain("<message-299-");
  });

  it("allows a message title to override the configured email title", async () => {
    const send = vi.fn(async (_message: unknown) => ({ messageId: "email-2" }));
    const channel = email({
      binding: { send: send as EmailSendBinding["send"] },
      from: "agent@example.com",
      defaultTitle: "Default"
    });

    await channel.deliver(EMAIL_SURFACE, {
      title: "Incident",
      markdown: "Details"
    });

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      subject: "Incident",
      text: "Details"
    });
  });

  it("exposes its typed route without evaluating it and selects email inside receive", async () => {
    const route = vi.fn((_event, raw: InboundEmailRaw) => {
      expectTypeOf(raw).toEqualTypeOf<InboundEmailRaw>();
      return raw.subject ?? null;
    });
    const channel = email({
      binding: { send: vi.fn() as EmailSendBinding["send"] },
      from: "agent@example.com",
      inbound: { from: "support@example.com" },
      route
    });
    const raw = new TextEncoder().encode(
      [
        "From: support@example.com",
        "To: agent@example.com",
        "Message-ID: <message-1>",
        "",
        "Hello"
      ].join("\r\n")
    );

    expect(channel.route).toBe(route);
    expect(route).not.toHaveBeenCalled();
    await expect(
      channel.emailIngress?.receive({
        from: "other@example.com",
        to: "agent@example.com",
        headers: new Headers(),
        getRaw: async () => raw
      })
    ).resolves.toBeNull();
    await expect(
      channel.emailIngress?.receive({
        from: "support@example.com",
        to: "agent@example.com",
        headers: new Headers(),
        getRaw: async () => raw
      })
    ).resolves.toMatchObject({
      events: [{ raw: { messageId: "<message-1>" } }]
    });
  });

  it("does not infer inbound recipient or sender filters from outbound configuration", async () => {
    const channel = email({
      binding: { send: vi.fn() as EmailSendBinding["send"] },
      from: "agent@example.com"
    });
    const raw = new TextEncoder().encode(
      [
        "From: anyone@example.com",
        "To: another-mailbox@example.com",
        "Message-ID: <message-anyone>",
        "",
        "Hello"
      ].join("\r\n")
    );

    await expect(
      channel.emailIngress?.receive({
        from: "anyone@example.com",
        to: "another-mailbox@example.com",
        headers: new Headers(),
        getRaw: async () => raw
      })
    ).resolves.toMatchObject({ events: [{ event: { type: "message" } }] });
  });

  it("renders caller-supplied approval links into an approval email", async () => {
    const send = vi.fn(async (_message: unknown) => ({ messageId: "email-3" }));
    const channel = email({
      binding: { send: send as EmailSendBinding["send"] },
      from: "agent@example.com"
    });

    await expect(
      channel.requestApproval?.(EMAIL_SURFACE, {
        interactionId: "deploy-42",
        request: {
          title: "Production deployment",
          summary: "Deploy version 42?",
          input: { version: 42 }
        },
        getApprovalLinks: async () => ({
          approve: "https://example.com/approve",
          reject: "https://example.com/reject"
        })
      })
    ).resolves.toEqual({ status: "delivered", reference: "email-3" });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      subject: "Production deployment",
      text: expect.stringContaining("Approve: https://example.com/approve")
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      text: expect.stringContaining("Reject: https://example.com/reject")
    });
  });

  it("fails plainly when approval links are unavailable", async () => {
    const channel = email({
      binding: { send: vi.fn() as EmailSendBinding["send"] },
      from: "agent@example.com"
    });

    await expect(
      channel.requestApproval?.(EMAIL_SURFACE, {
        interactionId: "deploy-42",
        request: { summary: "Deploy?", input: {} }
      })
    ).resolves.toMatchObject({
      status: "failed",
      retryable: false,
      error: { code: "APPROVAL_LINKS_UNAVAILABLE" }
    });
  });

  it("reports approval-link lookup failures as safe to retry", async () => {
    const send = vi.fn(async (_message: unknown) => ({ messageId: "email-4" }));
    const channel = email({
      binding: { send: send as EmailSendBinding["send"] },
      from: "agent@example.com"
    });

    await expect(
      channel.requestApproval?.(EMAIL_SURFACE, {
        interactionId: "deploy-42",
        request: { summary: "Deploy?", input: {} },
        getApprovalLinks: async () => {
          throw new Error("approval storage unavailable");
        }
      })
    ).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: {
        code: "APPROVAL_LINKS_UNAVAILABLE",
        message:
          "Email approval requests require caller-supplied approval links"
      }
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("marks rate limits as safe to retry", async () => {
    const error = Object.assign(new Error("Slow down"), {
      code: "E_RATE_LIMIT_EXCEEDED"
    });

    await expect(deliverRejected(error)).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: { code: "E_RATE_LIMIT_EXCEEDED", message: "Slow down" }
    });
  });

  it("marks daily quota exhaustion as safe to retry later", async () => {
    const error = Object.assign(new Error("Daily limit reached"), {
      code: "E_DAILY_LIMIT_EXCEEDED"
    });

    await expect(deliverRejected(error)).resolves.toMatchObject({
      status: "failed",
      retryable: true
    });
  });

  it("treats an internal Email Service failure as uncertain", async () => {
    const error = Object.assign(new Error("Internal Server Error"), {
      code: "E_INTERNAL_SERVER_ERROR"
    });

    await expect(deliverRejected(error)).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "E_INTERNAL_SERVER_ERROR",
        message: "Internal Server Error"
      }
    });
  });

  it("marks permanent Email Service errors as unsafe to retry", async () => {
    const error = Object.assign(new Error("Verify the sender"), {
      code: "E_SENDER_NOT_VERIFIED"
    });

    await expect(deliverRejected(error)).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: {
        code: "E_SENDER_NOT_VERIFIED",
        message: "Verify the sender"
      }
    });
  });

  it("recognizes recipient validation errors without an error code", async () => {
    await expect(
      deliverRejected(
        new Error(
          'Email must have at least one recipient in "to", "cc", or "bcc".'
        )
      )
    ).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: {
        code: "E_FIELD_MISSING",
        message:
          'Email must have at least one recipient in "to", "cc", or "bcc".'
      }
    });
  });

  it("treats unknown delivery errors as uncertain to avoid duplicates", async () => {
    await expect(
      deliverRejected(new Error("Connection closed"))
    ).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "EMAIL_DELIVERY_ERROR",
        message: "Connection closed"
      }
    });
  });
});
