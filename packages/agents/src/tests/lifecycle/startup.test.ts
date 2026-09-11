import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";
import { LifecycleCapability, type LifecycleServices } from "../../lifecycle";
import { WebSockets } from "../../websockets";
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

class CatchAllStartCapability extends OrderedStartCapability {
  override readonly claims = "catch-all";
}

/** An HTTP catch-all: answers every request, claims no upgrades. */
class HttpCatchAll extends LifecycleCapability {
  override readonly claims = "catch-all";
  constructor(id = "http-catch-all") {
    super(id);
  }
  onRequest(): Response {
    return new Response("caught", { status: 404 });
  }
}

/** An upgrade catch-all, like WebSockets: claims no requests. */
class UpgradeCatchAll extends LifecycleCapability {
  override readonly claims = "catch-all";
  constructor(id = "upgrade-catch-all") {
    super(id);
  }
  onWebSocketUpgrade(): Response {
    return new Response(null, { status: 426 });
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

  it("dispatches a catch-all capability after later-installed ones", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const order: string[] = [];
      const { lifecycle } = install(new OrderedStartCapability("first", order));
      lifecycle
        .use(new CatchAllStartCapability("catch-all", order))
        .use(new OrderedStartCapability("second", order));

      await lifecycle.start();
      expect(order).toEqual(["first", "second", "catch-all"]);
    });
  });

  it("WebSockets is a catch-all with or without handlers", () => {
    expect(new WebSockets().claims).toBe("catch-all");
    expect(new WebSockets({ handlers: {} }).claims).toBe("catch-all");
  });

  it("rejects a second catch-all for the same dispatch hook", async () => {
    await withCapabilityHarness(({ install }) => {
      const { lifecycle } = install(new HttpCatchAll("one"));
      expect(() => lifecycle.use(new HttpCatchAll("two"))).toThrow(
        'Lifecycle already has a catch-all for onRequest ("one"); a second one could never be reached'
      );
    });
  });

  it("lets catch-alls for disjoint hooks coexist", async () => {
    await withCapabilityHarness(({ install }) => {
      const { lifecycle } = install(new UpgradeCatchAll());
      expect(() => lifecycle.use(new HttpCatchAll())).not.toThrow();
      // WebSockets claims upgrades only, so an HTTP catch-all sits beside it.
      expect(() => lifecycle.use(new WebSockets())).toThrow(
        /catch-all for onWebSocketUpgrade/
      );
    });
  });

  it("a catch-all that implements no dispatch hook never conflicts", async () => {
    await withCapabilityHarness(({ install }) => {
      const order: string[] = [];
      const { lifecycle } = install(new CatchAllStartCapability("one", order));
      expect(() =>
        lifecycle.use(new CatchAllStartCapability("two", order))
      ).not.toThrow();
    });
  });

  it("fails loudly when an uninstalled capability reads its services", () => {
    const capability = new ServiceProbeCapability("unbound-probe");
    expect(() => capability.services()).toThrow(
      "ServiceProbeCapability must be installed with Lifecycle.use() before use"
    );
  });
});
