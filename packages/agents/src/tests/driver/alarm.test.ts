import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Driver alarm", () => {
  it("steps a submitted operation until it is done", async () => {
    const stub = env.DriverHarnessObject.getByName(crypto.randomUUID());

    const receipt = await stub.submit("main", "op-1", "hello");
    expect(receipt.accepted).toBe(true);
    await runDurableObjectAlarm(stub);

    expect(await stub.result("op-1")).toEqual({ answer: "op-1" });
    expect(await stub.steps("op-1")).toBe(1);
    expect(await stub.pending()).toEqual([]);
  });

  it("steps independent scopes from the same physical alarm", async () => {
    const stub = env.DriverHarnessObject.getByName(crypto.randomUUID());

    await stub.submit("main", "op-1", "first");
    await stub.submit("research", "op-2", "second");
    await runDurableObjectAlarm(stub);

    expect(await stub.result("op-1")).toEqual({ answer: "op-1" });
    expect(await stub.result("op-2")).toEqual({ answer: "op-2" });
    expect(await stub.pending()).toEqual([]);
  });
});
