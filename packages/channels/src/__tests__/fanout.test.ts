import { describe, expect, it, vi } from "vitest";
import { fanout, type Channel, type DeliveryResult } from "..";

function channel(
  result: DeliveryResult,
  available?: boolean
): Channel & { deliver: ReturnType<typeof vi.fn> } {
  return {
    ...(available === undefined ? {} : { isAvailable: () => available }),
    deliver: vi.fn(async () => result)
  };
}

describe("experimental fanout channel", () => {
  it("delivers concurrently to every Channel with the same context", async () => {
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
    const compound = fanout([first, second]);
    const message = { title: "Update", markdown: "Hello" };
    const context = { deliveryId: "notice-1", attempt: 2 };

    const delivery = compound.deliver(message, context);
    await vi.waitFor(() => {
      expect(started).toEqual(["first"]);
      expect(second.deliver).toHaveBeenCalledWith(message, context);
    });
    release?.();

    await expect(delivery).resolves.toEqual({ status: "delivered" });
  });

  it("reports any uncertain destination as uncertain", async () => {
    const compound = fanout([
      channel({ status: "delivered", reference: "chat-1" }),
      channel({
        status: "uncertain",
        error: { code: "NETWORK_ERROR", message: "Outcome unknown" }
      })
    ]);

    await expect(compound.deliver({ markdown: "Hello" })).resolves.toEqual({
      status: "uncertain",
      error: {
        code: "FANOUT_DELIVERY_UNCERTAIN",
        message:
          "Fanout delivery was partial or had an uncertain destination outcome"
      }
    });
  });

  it("reports a mix of delivered and confirmed failed as uncertain", async () => {
    const compound = fanout([
      channel({ status: "delivered", reference: "chat-1" }),
      channel({
        status: "failed",
        retryable: true,
        error: { code: "RATE_LIMIT", message: "Try later" }
      })
    ]);

    await expect(
      compound.deliver({ markdown: "Hello" })
    ).resolves.toMatchObject({ status: "uncertain" });
  });

  it.each([
    [true, true, true],
    [true, false, false],
    [false, false, false]
  ])(
    "reports unanimous failures with retryable=%s and %s as %s",
    async (firstRetryable, secondRetryable, expectedRetryable) => {
      const compound = fanout([
        channel({
          status: "failed",
          retryable: firstRetryable,
          error: { code: "FIRST_FAILED", message: "First failed" }
        }),
        channel({
          status: "failed",
          retryable: secondRetryable,
          error: { code: "SECOND_FAILED", message: "Second failed" }
        })
      ]);

      await expect(compound.deliver({ markdown: "Hello" })).resolves.toEqual({
        status: "failed",
        retryable: expectedRetryable,
        error: {
          code: "FANOUT_DELIVERY_FAILED",
          message: "Every fanout destination rejected the delivery"
        }
      });
    }
  );

  it("is available only when every child Channel is available", async () => {
    await expect(
      fanout([
        channel({ status: "delivered" }, true),
        channel({ status: "delivered" })
      ]).isAvailable?.()
    ).resolves.toBe(true);

    await expect(
      fanout([
        channel({ status: "delivered" }, true),
        channel({ status: "delivered" }, false)
      ]).isAvailable?.()
    ).resolves.toBe(false);
  });
});
