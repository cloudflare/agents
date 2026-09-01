import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("PiHarness", () => {
  it("executes dynamic tools and restores their durable transcript after eviction", async () => {
    const stub = env.PiHarnessObject.getByName(crypto.randomUUID());
    await stub.setToolRevision(2);

    const first = await stub.runTool(3);
    expect(first).toMatchObject({
      kind: "run",
      status: "completed",
      toolResults: [{ text: "8", revision: 2, result: 8 }]
    });

    await evictDurableObject(stub);
    expect(await stub.toolResults()).toEqual([
      { text: "8", revision: 2, result: 8 }
    ]);

    await stub.setToolRevision(4);
    const second = await stub.runTool(3);
    expect(second.toolResults).toEqual([
      { text: "8", revision: 2, result: 8 },
      { text: "16", revision: 4, result: 16 }
    ]);
  });
});
