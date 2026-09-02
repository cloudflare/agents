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

  it("dispatches fallback capabilities after later-installed ones", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const order: string[] = [];
      const { lifecycle } = install(new OrderedStartCapability("first", order));
      lifecycle
        .use(new OrderedStartCapability("fallback", order), { fallback: true })
        .use(new OrderedStartCapability("second", order));

      await lifecycle.start();
      expect(order).toEqual(["first", "second", "fallback"]);
    });
  });

  it("fails loudly when an uninstalled capability reads its services", () => {
    const capability = new ServiceProbeCapability("unbound-probe");
    expect(() => capability.services()).toThrow(
      "ServiceProbeCapability must be installed with Lifecycle.use() before use"
    );
  });
});
