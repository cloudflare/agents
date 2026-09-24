import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("HarnessDriver alarm", () => {
  it("drives a submitted operation to native settlement", async () => {
    const stub = env.DriverHarnessObject.getByName(crypto.randomUUID());

    const receipt = await stub.submit("main", "op-1", "hello");
    expect(receipt.accepted).toBe(true);
    await runDurableObjectAlarm(stub);

    expect(await stub.settled("op-1")).toEqual({ answer: "op-1" });
    expect(await stub.admissions("op-1")).toBe(1);
    expect(await stub.pending()).toEqual([]);
  });

  it("drives independent scopes from the same physical alarm", async () => {
    const stub = env.DriverHarnessObject.getByName(crypto.randomUUID());

    await stub.submit("main", "op-1", "first");
    await stub.submit("research", "op-2", "second");
    await runDurableObjectAlarm(stub);

    expect(await stub.settled("op-1")).toEqual({ answer: "op-1" });
    expect(await stub.settled("op-2")).toEqual({ answer: "op-2" });
    expect(await stub.pending()).toEqual([]);
  });
});
