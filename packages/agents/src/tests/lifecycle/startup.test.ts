import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";
import { LifecycleCapability, type LifecycleServices } from "../../lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";

class ServiceProbeCapability extends LifecycleCapability {
  constructor(id = "service-probe") {
    super(id);
  }

  services(): LifecycleServices {
    return this.lifecycle;
  }
}

class OrderedStartCapability extends LifecycleCapability {
  constructor(
    id: string,
    private readonly order: string[]
  ) {
    super(id);
  }

  override onStart(): void {
    this.order.push(this.capabilityId);
  }
}

describe("Lifecycle startup", () => {
  it("starts capabilities and the host from RPC entry points", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());

    expect(await stub.startFromRpc({ label: "rpc" })).toEqual([
      "capability:start:rpc",
      "host:start:rpc"
    ]);
  });

  it("retries startup after a capability start failure without running the host", async () => {
    const stub = env.RetryableStartObject.getByName(crypto.randomUUID());

    expect(await stub.tryStart()).toBe("intentional startup failure");
    expect(await stub.getHostStarts()).toBe(0);

    expect(await stub.tryStart()).toBe("started");
    expect(await stub.getHostStarts()).toBe(1);
  });

  it("rejects adding capabilities after startup", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());
    await stub.startFromRpc({ label: "late" });

    expect(await stub.useCapabilityAfterStartForTest()).toBe(
      "Lifecycle capabilities must be added before startup"
    );
  });

  it("rejects installing two capabilities with the same ID", async () => {
    await withCapabilityHarness(({ install }) => {
      const { lifecycle } = install(new ServiceProbeCapability());
      expect(() => lifecycle.use(new ServiceProbeCapability())).toThrow(
        'Lifecycle capability "service-probe" is already installed'
      );
    });
  });

  it("positions capabilities relative to installed capability IDs", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const order: string[] = [];
      const { lifecycle } = install(
        new OrderedStartCapability("middle", order)
      );
      lifecycle
        .use(new OrderedStartCapability("first", order), { before: "middle" })
        .use(new OrderedStartCapability("last", order), { after: "middle" });

      await lifecycle.start();
      expect(order).toEqual(["first", "middle", "last"]);
    });
  });

  it("rejects positioning relative to an unknown capability", async () => {
    await withCapabilityHarness(({ install }) => {
      const { lifecycle } = install(new ServiceProbeCapability());
      expect(() =>
        lifecycle.use(new ServiceProbeCapability("other"), {
          before: "missing"
        })
      ).toThrow('Lifecycle capability "missing" is not installed');
    });
  });

  it("fails loudly when an uninstalled capability reads its services", () => {
    const capability = new ServiceProbeCapability("unbound-probe");
    expect(() => capability.services()).toThrow(
      "ServiceProbeCapability must be installed with Lifecycle.use() before use"
    );
  });
});
