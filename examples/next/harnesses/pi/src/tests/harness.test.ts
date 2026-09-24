import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiHarnessTestObject } from "./worker";

async function settle(
  stub: DurableObjectStub<PiHarnessTestObject>,
  lane: string,
  operationId: string
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await runDurableObjectAlarm(stub);
    const result = await stub.result(lane, operationId);
    if (result) return result;
  }
  return stub.result(lane, operationId);
}

describe("Pi harness example", () => {
  it("recovers a turn after eviction", async () => {
    const name = crypto.randomUUID();
    const stub = env.PI_HARNESS_TEST.getByName(name);
    await stub.submit("main", "op-1", 4);

    await evictDurableObject(stub);
    const fresh = env.PI_HARNESS_TEST.getByName(name);

    expect(await settle(fresh, "main", "op-1")).toMatchObject({
      status: "completed"
    });
    expect(await fresh.messages("main")).toEqual([
      "multiply 4",
      "",
      "",
      "complete"
    ]);
  });

  it("drives multiple lanes", async () => {
    const stub = env.PI_HARNESS_TEST.getByName(crypto.randomUUID());
    await stub.submit("main", "op-1", 2);
    await stub.submit("research", "op-2", 3);

    expect(await settle(stub, "main", "op-1")).toMatchObject({
      status: "completed"
    });
    expect(await settle(stub, "research", "op-2")).toMatchObject({
      status: "completed"
    });
  });
});
