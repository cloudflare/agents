import { describe, expect, it, vi } from "vitest";
import { withX402 } from "../payments/x402";
import { paymentFixture } from "./paid-tool-fixture";

describe("transport-independent paid functions", () => {
  it("challenges unpaid calls without running or settling the function", async () => {
    const { config, verify, settle } = await paymentFixture();
    const execute = vi.fn((n: number) => n ** 2);
    const paid = withX402(execute, config);
    const result = await paid(5);
    expect(result).toMatchObject({
      status: "payment-required",
      paymentRequired: {
        x402Version: 2,
        accepts: config.accepts,
        resource: config.resource
      }
    });
    expect(execute).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("verifies, executes an ordinary function, and settles in order", async () => {
    const { config, payment, verify, settle } = await paymentFixture();
    const execute = vi.fn(async (n: number) => n ** 2);
    const result = await withX402(execute, config)(5, payment);
    expect(result).toEqual({
      status: "success",
      result: 25,
      settlement: {
        success: true,
        transaction: "0xtransaction",
        network: "eip155:84532"
      }
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith(5);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0]
    );
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      settle.mock.invocationCallOrder[0]
    );
  });

  it("rejects a payment for different requirements before execution", async () => {
    const { config, payment, verify, settle } = await paymentFixture();
    payment.accepted.amount = "1";
    const execute = vi.fn();
    expect(await withX402(execute, config)(undefined, payment)).toMatchObject({
      status: "payment-required",
      paymentRequired: { error: "INVALID_PAYMENT" }
    });
    expect(execute).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("rejects failed verification without executing or settling", async () => {
    const { config, payment, verify, settle } = await paymentFixture();
    verify.mockResolvedValueOnce({
      isValid: false,
      invalidReason: "invalid_signature"
    });
    const execute = vi.fn();
    expect(await withX402(execute, config)(undefined, payment)).toMatchObject({
      status: "payment-required",
      paymentRequired: { error: "invalid_signature" }
    });
    expect(execute).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("propagates handler failures without settling", async () => {
    const { config, payment, settle } = await paymentFixture();
    const error = new Error("Tool failed");
    const paid = withX402(async () => {
      throw error;
    }, config);
    await expect(paid(undefined, payment)).rejects.toBe(error);
    expect(settle).not.toHaveBeenCalled();
  });

  it("does not expose a result or request a retry after failed settlement", async () => {
    const { config, payment, settle } = await paymentFixture();
    const failure = {
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "eip155:84532" as const
    };
    settle.mockResolvedValueOnce(failure);
    const execute = vi.fn(() => "paid data");
    expect(await withX402(execute, config)(undefined, payment)).toEqual({
      status: "settlement-failed",
      settlement: failure
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
  });

  it.each(["verify", "settle"] as const)(
    "propagates %s outages without automatic retry",
    async (phase) => {
      const fixture = await paymentFixture();
      const error = new Error("Facilitator unavailable");
      fixture[phase].mockRejectedValueOnce(error);
      const execute = vi.fn(() => "result");
      await expect(
        withX402(execute, fixture.config)(undefined, fixture.payment)
      ).rejects.toBe(error);
      expect(fixture[phase]).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledTimes(phase === "verify" ? 0 : 1);
    }
  );

  it("keeps verified payment data stable while the handler runs", async () => {
    const { config, payment, settle } = await paymentFixture();
    const original = structuredClone(payment);
    await withX402(async () => {
      payment.accepted.amount = "999999";
      config.accepts[0].amount = "999999";
      return 1;
    }, config)(undefined, payment);
    expect(settle.mock.calls[0][0]).toEqual(original);
    expect(settle.mock.calls[0][1].amount).toBe("10000");
  });

  it("rejects empty payment configuration at construction", async () => {
    const { config } = await paymentFixture();
    expect(() => withX402(() => 1, { ...config, accepts: [] })).toThrow(
      "At least one"
    );
  });
});
