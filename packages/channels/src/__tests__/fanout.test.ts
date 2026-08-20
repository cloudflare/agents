import { describe, expect, it, vi } from "vitest";
import {
  ChannelHost,
  fallback,
  fanout,
  fanoutChannel,
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

describe("fanout surfaces", () => {
  it("labels every destination in the composite", () => {
    expect(fanout([surface("Slack"), surface("email")]).label).toBe(
      "Slack and email"
    );
  });

  it("delivers concurrently to every destination with the same context", async () => {
    const started: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first: Channel = {
      async deliver() {
        started.push("first");
        await blocked;
        return { status: "delivered", reference: "chat-1" };
      }
    };
    const second = channel({ status: "delivered", reference: "email-1" });
    const channelHost = host({ first, second });
    const message = { title: "Update", markdown: "Hello" };
    const context = { deliveryId: "notice-1" };

    const delivery = channelHost.deliver(
      fanout([surface("first"), surface("second")]),
      message,
      context
    );
    await vi.waitFor(() => {
      expect(started).toEqual(["first"]);
      expect(second.deliver).toHaveBeenCalledWith(
        surface("second"),
        message,
        context
      );
    });
    release?.();

    await expect(delivery).resolves.toEqual({ status: "delivered" });
  });

  it("reports any uncertain destination as uncertain", async () => {
    const channelHost = host({
      first: channel({ status: "delivered" }),
      second: channel({
        status: "uncertain",
        error: { code: "NETWORK_ERROR", message: "Outcome unknown" }
      })
    });

    await expect(
      channelHost.deliver(fanout([surface("first"), surface("second")]), {
        markdown: "Hello"
      })
    ).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "FANOUT_DELIVERY_UNCERTAIN",
        message:
          "Fanout delivery was partial or had an uncertain destination outcome"
      }
    });
  });

  it("reports a mix of delivered and confirmed failed as uncertain", async () => {
    const channelHost = host({
      first: channel({ status: "delivered" }),
      second: channel({
        status: "failed",
        retryable: true,
        error: { code: "RATE_LIMIT", message: "Try later" }
      })
    });

    await expect(
      channelHost.deliver(fanout([surface("first"), surface("second")]), {
        markdown: "Hello"
      })
    ).resolves.toMatchObject({ status: "uncertain" });
  });

  it.each([
    [true, true, true],
    [true, false, false],
    [false, false, false]
  ])(
    "reports unanimous failures with retryable=%s and %s as %s",
    async (firstRetryable, secondRetryable, expectedRetryable) => {
      const channelHost = host({
        first: channel({
          status: "failed",
          retryable: firstRetryable,
          error: { code: "FIRST_FAILED", message: "First failed" }
        }),
        second: channel({
          status: "failed",
          retryable: secondRetryable,
          error: { code: "SECOND_FAILED", message: "Second failed" }
        })
      });

      await expect(
        channelHost.deliver(fanout([surface("first"), surface("second")]), {
          markdown: "Hello"
        })
      ).resolves.toEqual({
        status: "failed",
        retryable: expectedRetryable,
        error: {
          code: "FANOUT_DELIVERY_FAILED",
          message: "Every fanout destination rejected the delivery"
        }
      });
    }
  );

  it("turns a configured inbound-only destination into an honest failed result", async () => {
    const channelHost = host({ inbound: {} });

    await expect(
      channelHost.deliver(fanout([surface("inbound")]), {
        markdown: "Hello"
      })
    ).resolves.toEqual({
      status: "failed",
      retryable: false,
      error: {
        code: "FANOUT_DELIVERY_FAILED",
        message: "Every fanout destination rejected the delivery"
      }
    });
  });

  it("runs as an ordinary Channel against an injected outbound resolver", async () => {
    const resolver = {
      deliver: vi.fn(async () => ({ status: "delivered" as const })),
      requestApproval: vi.fn(async () => ({ status: "delivered" as const })),
      isAvailable: vi.fn(async () => true)
    } satisfies OutboundResolver;
    const policy = fanoutChannel(resolver);
    const destination = fanout([surface("first"), surface("second")]);

    await expect(
      policy.requestApproval?.(destination, {
        interactionId: "approval-1",
        request: { summary: "Proceed?", input: {} }
      })
    ).resolves.toEqual({ status: "delivered" });
    expect(resolver.requestApproval).toHaveBeenCalledTimes(2);
  });

  it("consults every resolved Channel's availability when used as a fallback", async () => {
    const first = channel({ status: "delivered" }, true);
    const unavailable = channel({ status: "delivered" }, false);
    const final = channel({ status: "delivered", reference: "final" });
    const channelHost = host({ first, unavailable, final });

    await expect(
      channelHost.deliver(
        fallback([
          fanout([surface("first"), surface("unavailable")]),
          surface("final")
        ]),
        { markdown: "Hello" }
      )
    ).resolves.toEqual({ status: "delivered", reference: "final" });
    expect(first.deliver).not.toHaveBeenCalled();
    expect(unavailable.deliver).not.toHaveBeenCalled();
  });
});
