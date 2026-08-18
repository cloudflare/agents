import { describe, expect, it, vi } from "vitest";
import { email, type EmailSendBinding } from "..";

function channelThatRejects(error: unknown) {
  const send = vi.fn(
    async (_message: unknown): Promise<{ messageId: string }> => {
      throw error;
    }
  );

  return email({
    binding: { send: send as EmailSendBinding["send"] },
    from: "agent@example.com",
    to: "support@example.com",
    defaultTitle: "Agent escalation"
  });
}

describe("experimental email channel", () => {
  it("sends canonical Markdown as the plain-text email body", async () => {
    const send = vi.fn(async (_message: unknown) => ({
      messageId: "email-1"
    }));
    const channel = email({
      binding: { send: send as EmailSendBinding["send"] },
      from: "agent@example.com",
      to: "support@example.com"
    });

    await expect(channel.deliver({ markdown: "**Help**" })).resolves.toEqual({
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
      headers: undefined
    });
  });

  it("allows a message title to override the configured email title", async () => {
    const send = vi.fn(async (_message: unknown) => ({ messageId: "email-2" }));
    const channel = email({
      binding: { send: send as EmailSendBinding["send"] },
      from: "agent@example.com",
      to: "support@example.com",
      defaultTitle: "Default"
    });

    await channel.deliver({ title: "Incident", markdown: "Details" });

    expect(send.mock.calls[0]?.[0]).toMatchObject({
      subject: "Incident",
      text: "Details"
    });
  });

  it("carries Workers Email ingress on the same Channel by default", () => {
    const channel = email({
      binding: { send: vi.fn() as EmailSendBinding["send"] },
      from: "agent@example.com",
      to: "support@example.com"
    });

    expect(
      channel.emailIngress?.accepts?.({
        from: "support@example.com",
        to: "agent@example.com",
        headers: new Headers(),
        getRaw: async () => new Uint8Array()
      })
    ).toBe(true);
  });

  it("renders Host-owned approval links into an approval email", async () => {
    const send = vi.fn(async (_message: unknown) => ({ messageId: "email-3" }));
    const channel = email({
      binding: { send: send as EmailSendBinding["send"] },
      from: "agent@example.com",
      to: "support@example.com"
    });

    await expect(
      channel.requestApproval?.({
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
      from: "agent@example.com",
      to: "support@example.com"
    });

    await expect(
      channel.requestApproval?.({
        interactionId: "deploy-42",
        request: { summary: "Deploy?", input: {} }
      })
    ).resolves.toMatchObject({
      status: "failed",
      retryable: false,
      error: { code: "APPROVAL_LINKS_UNAVAILABLE" }
    });
  });

  it("marks rate limits as safe to retry", async () => {
    const error = Object.assign(new Error("Slow down"), {
      code: "E_RATE_LIMIT_EXCEEDED"
    });

    await expect(
      channelThatRejects(error).deliver({ markdown: "Help" })
    ).resolves.toEqual({
      status: "failed",
      retryable: true,
      error: { code: "E_RATE_LIMIT_EXCEEDED", message: "Slow down" }
    });
  });

  it("marks permanent Email Service errors as unsafe to retry", async () => {
    const error = Object.assign(new Error("Verify the sender"), {
      code: "E_SENDER_NOT_VERIFIED"
    });

    await expect(
      channelThatRejects(error).deliver({ markdown: "Help" })
    ).resolves.toEqual({
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
      channelThatRejects(
        new Error(
          'Email must have at least one recipient in "to", "cc", or "bcc".'
        )
      ).deliver({ markdown: "Help" })
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
      channelThatRejects(new Error("Connection closed")).deliver({
        markdown: "Help"
      })
    ).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "EMAIL_DELIVERY_ERROR",
        message: "Connection closed"
      }
    });
  });
});
