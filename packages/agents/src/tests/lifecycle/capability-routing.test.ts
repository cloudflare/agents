import { env } from "cloudflare:workers";

import { describe, expect, it } from "vitest";
import {
  LifecycleCapability,
  type LifecycleRouteContext,
  type LifecycleRouteInbound,
  type LifecycleRouteRetirement,
  type LifecycleRouteTransport
} from "../../lifecycle";
import { withCapabilityHarness } from "../shared/capability-harness";

class RouteProbe extends LifecycleCapability {
  readonly seen: Array<{ payload: unknown; started: boolean }> = [];
  readonly retired: string[] = [];
  started = false;

  constructor(id = "route-probe") {
    super(id);
  }

  onStart(): void {
    this.started = true;
  }

  onRoute(context: LifecycleRouteContext): unknown {
    this.seen.push({ payload: context.payload, started: context.started });
    return this.seen.length;
  }

  onRouteRetired(retirement: LifecycleRouteRetirement): void {
    this.retired.push(retirement.address.key);
  }

  retire(key: string): Promise<void> {
    return this.lifecycle.routes.retire({
      address: { key, data: key },
      covers: (ownerKey) => ownerKey === key || ownerKey.startsWith(`${key}/`)
    });
  }

  ready(): Promise<void> {
    return this.lifecycle.ready();
  }
}

class TransportProbe extends LifecycleCapability {
  inbound: LifecycleRouteInbound | undefined;

  constructor(id: string) {
    super(id);
  }

  provideRouteTransport(
    inbound: LifecycleRouteInbound
  ): LifecycleRouteTransport {
    this.inbound = inbound;
    return {
      source: undefined,
      toRoot: (envelope) => inbound.deliver(envelope),
      to: (_target, envelope) => inbound.deliver(envelope)
    };
  }
}

describe("Lifecycle capability routing", () => {
  it("routes messages to the matching local capability", async () => {
    const stub = env.PlainLifecycleObject.getByName(crypto.randomUUID());

    expect(await stub.routeCapability({ value: "routed" })).toEqual({
      payload: { value: "routed" },
      source: null
    });
  });

  it("delivers a bootstrap envelope before startup, then starts on request", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const probe = new RouteProbe();
      const { lifecycle } = install(probe);

      const first = await lifecycle.route({
        capability: "route-probe",
        source: undefined,
        payload: "identity",
        bootstrap: true
      });
      expect(first).toBe(1);
      expect(probe.seen).toEqual([{ payload: "identity", started: false }]);
      expect(probe.started).toBe(false);

      // The capability decides when the object starts.
      await probe.ready();
      expect(probe.started).toBe(true);

      // Once started, a bootstrap envelope is an ordinary route.
      await lifecycle.route({
        capability: "route-probe",
        source: undefined,
        payload: "again",
        bootstrap: true
      });
      expect(probe.seen[1]).toEqual({ payload: "again", started: true });
    });
  });

  it("starts the object before an ordinary route", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const probe = new RouteProbe();
      const { lifecycle } = install(probe);
      await lifecycle.route({
        capability: "route-probe",
        source: undefined,
        payload: "plain"
      });
      expect(probe.started).toBe(true);
      expect(probe.seen).toEqual([{ payload: "plain", started: true }]);
    });
  });

  it("fans a retirement out to every capability in order", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const first = new RouteProbe("first-probe");
      const second = new RouteProbe("second-probe");
      const { lifecycle } = install(first);
      lifecycle.use(second);
      await lifecycle.start();

      await second.retire("Root:r/Child:c");

      expect(first.retired).toEqual(["Root:r/Child:c"]);
      expect(second.retired).toEqual(["Root:r/Child:c"]);
    });
  });

  it("accepts one route transport and rejects a second", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const transport = new TransportProbe("transport-a");
      const { lifecycle } = install(transport);
      expect(transport.inbound).toBeDefined();

      expect(() => lifecycle.use(new TransportProbe("transport-b"))).toThrow(
        "Lifecycle already has a route transport"
      );
    });
  });

  it("delivers inbound envelopes queued during startup once it completes", async () => {
    await withCapabilityHarness(async ({ install }) => {
      const transport = new TransportProbe("transport");
      const probe = new RouteProbe();
      const { lifecycle } = install(transport);
      lifecycle.use(probe);
      // Hand an envelope over while the object is still starting: the
      // capability's own onStart is the only place that can observe it.
      let delivered: Promise<unknown> | undefined;
      lifecycle.use({
        onStart: () => {
          delivered = transport.inbound!.deliver({
            capability: "route-probe",
            source: undefined,
            payload: "queued"
          });
        }
      });
      await lifecycle.start();
      expect(await delivered).toBe(1);
      expect(probe.seen).toEqual([{ payload: "queued", started: true }]);
    });
  });
});
