import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";
import { LifecycleCapability, type LifecycleServices } from "../../lifecycle";
import {
  CALLABLES_RPC_QUERY,
  CALLABLES_RPC_VALUE,
  WebSockets
} from "../../websockets";
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

  it("WebSockets refuses callables RPC upgrades itself when no target is configured", async () => {
    const url = new URL("https://example.com/room");
    url.searchParams.set(CALLABLES_RPC_QUERY, CALLABLES_RPC_VALUE);
    const response = await new WebSockets().onWebSocketUpgrade({
      request: new Request(url, { headers: { Upgrade: "websocket" } })
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Pass `callables`");
  });

  it("rejects installing a second catch-all capability", async () => {
    await withCapabilityHarness(({ install }) => {
      const order: string[] = [];
      const { lifecycle } = install(new CatchAllStartCapability("one", order));
      expect(() =>
        lifecycle.use(new CatchAllStartCapability("two", order))
      ).toThrow(
        'Lifecycle already has a catch-all capability ("one"); a second one could never be reached'
      );
    });
  });

  it("fails loudly when an uninstalled capability reads its services", () => {
    const capability = new ServiceProbeCapability("unbound-probe");
    expect(() => capability.services()).toThrow(
      "ServiceProbeCapability must be installed with Lifecycle.use() before use"
    );
  });
});
