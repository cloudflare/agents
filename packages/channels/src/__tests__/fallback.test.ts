import { describe, expect, it, vi } from "vitest";
import {
  ChannelHost,
  fallback,
  fallbackChannel,
  type Channel,
  type DeliveryResult,
  type OutboundResolver
} from "..";

function surface(channelKey: string) {
  return {
    channelKey,
    version: 1,
    address: null,
    label: channelKey
  } as const;
}

function channel(
  result: DeliveryResult,
  available?: boolean
): Channel & { deliver: ReturnType<typeof vi.fn> } {
  return {
    ...(available === undefined ? {} : { isAvailable: () => available }),
    deliver: vi.fn(async () => result)
  };
}

function host(channels: Record<string, Channel>) {
  return new ChannelHost({ channels, onMessage() {} });
}

describe("fallback surfaces", () => {
  it("uses the first available destination", async () => {
    const first = channel({ status: "delivered", reference: "voice-1" }, true);
    const second = channel({ status: "delivered", reference: "email-1" });
    const channelHost = host({ first, second });

    await expect(
      channelHost.deliver(fallback([surface("first"), surface("second")]), {
        markdown: "Hello"
      })
    ).resolves.toEqual({ status: "delivered", reference: "voice-1" });
    expect(second.deliver).not.toHaveBeenCalled();
  });

  it("skips unavailable destinations but always attempts the final one", async () => {
    const first = channel({ status: "delivered" }, false);
    const final = channel({ status: "delivered", reference: "email-1" }, false);
    const channelHost = host({ first, final });
    const message = { title: "Update", markdown: "Hello" };

    await expect(
      channelHost.deliver(
        fallback([surface("first"), surface("final")]),
        message
      )
    ).resolves.toEqual({ status: "delivered", reference: "email-1" });
    expect(first.deliver).not.toHaveBeenCalled();
    expect(final.deliver).toHaveBeenCalledWith(
      surface("final"),
      message,
      undefined
    );
  });

  it.each([true, false])(
    "advances after a definitive failure (retryable: %s)",
    async (retryable) => {
      const first = channel({
        status: "failed",
        retryable,
        error: { code: "DELIVERY_FAILED", message: "Not delivered" }
      });
      const second = channel({ status: "delivered", reference: "email-1" });
      const channelHost = host({ first, second });

      await expect(
        channelHost.deliver(fallback([surface("first"), surface("second")]), {
          markdown: "Hello"
        })
      ).resolves.toEqual({ status: "delivered", reference: "email-1" });
    }
  );

  it("stops after an uncertain outcome", async () => {
    const first = channel({
      status: "uncertain",
      error: { code: "DELIVERY_ERROR", message: "Unknown outcome" }
    });
    const second = channel({ status: "delivered" });
    const channelHost = host({ first, second });

    await channelHost.deliver(fallback([surface("first"), surface("second")]), {
      markdown: "Hello"
    });

    expect(first.deliver).toHaveBeenCalledOnce();
    expect(second.deliver).not.toHaveBeenCalled();
  });

  it("forwards delivery context to the resolved Channel", async () => {
    const first = channel({ status: "delivered" });
    const channelHost = host({ first });
    const message = { markdown: "Hello" };
    const context = { deliveryId: "notice-1" };

    await channelHost.deliver(fallback([surface("first")]), message, context);

    expect(first.deliver).toHaveBeenCalledWith(
      surface("first"),
      message,
      context
    );
  });

  it("applies the same fallback policy to approval requests", async () => {
    const first = vi.fn(async () => ({
      status: "failed" as const,
      retryable: false,
      error: { code: "NOT_SENT", message: "Not sent" }
    }));
    const second = vi.fn(async () => ({
      status: "delivered" as const,
      reference: "approval-1"
    }));
    const channelHost = host({
      first: { requestApproval: first },
      second: { requestApproval: second }
    });
    const options = {
      interactionId: "approval-1",
      request: { summary: "Proceed?", input: {} }
    };

    await expect(
      channelHost.requestApproval(
        fallback([surface("first"), surface("second")]),
        options
      )
    ).resolves.toEqual({ status: "delivered", reference: "approval-1" });
    expect(second).toHaveBeenCalledWith(surface("second"), options);
  });

  it("treats a configured inbound-only Channel as a confirmed failure", async () => {
    const second = channel({ status: "delivered", reference: "email-1" });
    const channelHost = host({ inbound: {}, second });

    await expect(
      channelHost.deliver(fallback([surface("inbound"), surface("second")]), {
        markdown: "Hello"
      })
    ).resolves.toEqual({ status: "delivered", reference: "email-1" });
  });

  it("runs as an ordinary Channel against an injected outbound resolver", async () => {
    const resolver = {
      deliver: vi.fn(async () => ({ status: "delivered" as const })),
      requestApproval: vi.fn(async () => ({ status: "delivered" as const })),
      isAvailable: vi.fn(async () => true)
    } satisfies OutboundResolver;
    const policy = fallbackChannel(resolver);
    const destination = fallback([surface("first")]);
    const message = { markdown: "Hello" };

    await expect(policy.deliver?.(destination, message)).resolves.toEqual({
      status: "delivered"
    });
    expect(resolver.deliver).toHaveBeenCalledWith(
      surface("first"),
      message,
      undefined
    );
  });

  it("constructs labelled inert data without consulting configured Channels", () => {
    expect(fallback([surface("Slack"), surface("email")])).toEqual({
      channelKey: "fallback",
      version: 1,
      address: { surfaces: [surface("Slack"), surface("email")] },
      label: "Slack, then email"
    });
  });
});
